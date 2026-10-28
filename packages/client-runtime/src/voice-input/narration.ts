import { speechErrorRequiresConfiguration } from "./settings.ts";
import { narrationChunks } from "@t3tools/shared/narration";
import type { NarrationSettings } from "@t3tools/contracts";

export type NarrationState = {
  readonly owner: string | null;
  readonly phase: "idle" | "loading" | "playing";
  readonly error: string | null;
  readonly errorAction: "speech-settings" | null;
  readonly paused: boolean;
  readonly rate: 1 | 1.5 | 2;
  readonly elapsedSeconds: number;
};

type NarrationPlayback = {
  readonly setPaused: (paused: boolean) => void;
  readonly setRate: (rate: NarrationState["rate"]) => void;
};

export type NarrationPlaybackOptions = {
  readonly onReady: (playback: NarrationPlayback) => void;
  readonly onProgress: (seconds: number) => void;
};

export class NarrationController<Context> {
  private state: NarrationState = {
    owner: null,
    phase: "idle",
    error: null,
    errorAction: null,
    paused: false,
    rate: 1,
    elapsedSeconds: 0,
  };
  private readonly listeners = new Set<() => void>();
  private active: AbortController | null = null;
  private playback: NarrationPlayback | null = null;

  private readonly dependencies: {
    readonly synthesize: (
      text: string,
      context: Context,
      signal: AbortSignal,
    ) => Promise<Uint8Array>;
    readonly play: (
      audio: Uint8Array,
      signal: AbortSignal,
      options: NarrationPlaybackOptions,
    ) => Promise<void>;
  };

  constructor(dependencies: NarrationController<Context>["dependencies"]) {
    this.dependencies = dependencies;
  }

  readonly getSnapshot = (): NarrationState => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  stop(): void {
    this.active?.abort();
    this.active = null;
    this.playback = null;
    this.publish({
      ...this.state,
      owner: null,
      phase: "idle",
      error: null,
      errorAction: null,
      paused: false,
      elapsedSeconds: 0,
    });
  }

  togglePaused(): void {
    if (!this.active) return;
    const paused = !this.state.paused;
    this.publish({ ...this.state, paused });
    this.playback?.setPaused(paused);
  }

  cycleRate(): void {
    const rate = this.state.rate === 1 ? 1.5 : this.state.rate === 1.5 ? 2 : 1;
    this.publish({ ...this.state, rate });
    this.playback?.setRate(rate);
  }

  async start(
    owner: string,
    markdown: string,
    context: Context,
    provider?: NarrationSettings["provider"],
  ): Promise<void> {
    this.stop();
    const chunks = narrationChunks(markdown, provider);
    const first = chunks[0];
    if (first === undefined) {
      this.publish({
        ...this.state,
        owner,
        phase: "idle",
        error: "This response has no readable text.",
        errorAction: null,
      });
      return;
    }
    const operation = new AbortController();
    this.active = operation;
    this.publish({ ...this.state, owner, phase: "loading", error: null, errorAction: null });
    let completedSeconds = 0;
    const generate = async (text: string) => {
      try {
        return { audio: await this.dependencies.synthesize(text, context, operation.signal) };
      } catch (error) {
        return { error };
      }
    };
    let pending = generate(first);
    try {
      for (const [index] of chunks.entries()) {
        const result = await pending;
        if (operation.signal.aborted) return;
        if ("error" in result) throw result.error;
        let position = 0;
        await this.dependencies.play(result.audio, operation.signal, {
          onReady: (playback) => {
            if (operation.signal.aborted) return;
            this.playback = playback;
            playback.setRate(this.state.rate);
            this.publish({ ...this.state, phase: "playing" });
            playback.setPaused(this.state.paused);
            const next = chunks[index + 1];
            if (next !== undefined) pending = generate(next);
          },
          onProgress: (seconds) => {
            if (operation.signal.aborted || !Number.isFinite(seconds) || seconds < 0) return;
            position = seconds;
            const elapsedSeconds = Math.floor(completedSeconds + position);
            if (elapsedSeconds !== this.state.elapsedSeconds)
              this.publish({ ...this.state, elapsedSeconds });
          },
        });
        if (operation.signal.aborted) return;
        this.playback = null;
        completedSeconds += position;
        if (index + 1 < chunks.length) this.publish({ ...this.state, phase: "loading" });
      }
      if (this.active === operation) this.stop();
    } catch (error) {
      if (operation.signal.aborted) return;
      operation.abort();
      this.active = null;
      this.playback = null;
      this.publish({
        ...this.state,
        owner,
        phase: "idle",
        errorAction: speechErrorRequiresConfiguration(error) ? "speech-settings" : null,
        error: error instanceof Error ? error.message : "Could not read this response aloud.",
      });
    }
  }

  private publish(state: NarrationState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
