import { speechErrorRequiresConfiguration } from "./settings.ts";
import { narrationChunks } from "@t3tools/shared/narration";
import type { NarrationSettings } from "@t3tools/contracts";
import { narrationWaveform, type NarrationAudioInfo } from "./narrationWaveform.ts";

const NARRATION_RATES = [1, 1.25, 1.5, 1.75, 2] as const;

export type NarrationState = {
  readonly owner: string | null;
  readonly phase: "idle" | "loading" | "playing";
  readonly error: string | null;
  readonly errorAction: "speech-settings" | null;
  readonly paused: boolean;
  readonly rate: (typeof NARRATION_RATES)[number];
  readonly elapsedSeconds: number;
  readonly durationSeconds: number;
  readonly waveform: readonly number[];
  readonly seeking: boolean;
  readonly complete: boolean;
};

type NarrationPlayback = {
  readonly setPaused: (paused: boolean) => void;
  readonly setRate: (rate: NarrationState["rate"]) => void;
};

export type NarrationPlaybackOptions = {
  readonly startSeconds: number;
  readonly onReady: (playback: NarrationPlayback) => void;
  readonly onProgress: (seconds: number) => void;
};

type Segment = NarrationAudioInfo & { readonly audio: Uint8Array; readonly start: number };
type Session = {
  readonly operation: AbortController;
  readonly segments: Segment[];
  changed: ReturnType<typeof Promise.withResolvers<void>>;
  playbackAbort: AbortController | null;
  playback: NarrationPlayback | null;
  cursor: { index: number; offset: number };
  duration: number;
  complete: boolean;
  failure: { error: unknown } | null;
  drag: { readonly paused: boolean; readonly originalSeconds: number } | null;
};

function wake(session: Session) {
  session.changed.resolve();
  session.changed = Promise.withResolvers<void>();
}

export class NarrationController<Context> {
  private state: NarrationState = {
    owner: null,
    phase: "idle",
    error: null,
    errorAction: null,
    paused: false,
    rate: 1,
    elapsedSeconds: 0,
    durationSeconds: 0,
    waveform: [],
    seeking: false,
    complete: false,
  };
  private readonly listeners = new Set<() => void>();
  private session: Session | null = null;
  private readonly dependencies: {
    readonly synthesize: (
      text: string,
      context: Context,
      signal: AbortSignal,
    ) => Promise<Uint8Array>;
    readonly inspect: (audio: Uint8Array, signal: AbortSignal) => Promise<NarrationAudioInfo>;
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
    const session = this.session;
    this.session = null;
    session?.operation.abort();
    session?.playbackAbort?.abort();
    if (session) {
      session.segments.length = 0;
      wake(session);
    }
    this.publish({
      ...this.state,
      owner: null,
      phase: "idle",
      error: null,
      errorAction: null,
      paused: false,
      elapsedSeconds: 0,
      durationSeconds: 0,
      waveform: [],
      seeking: false,
      complete: false,
    });
  }

  togglePaused(): void {
    if (!this.session || this.state.seeking) return;
    const paused = !this.state.paused;
    this.publish({ ...this.state, paused });
    this.session.playback?.setPaused(paused);
  }

  cycleRate(): void {
    const rate =
      NARRATION_RATES[(NARRATION_RATES.indexOf(this.state.rate) + 1) % NARRATION_RATES.length] ??
      NARRATION_RATES[0];
    this.publish({ ...this.state, rate });
    this.session?.playback?.setRate(rate);
  }

  beginSeek(): void {
    const session = this.session;
    if (!session || session.drag || this.state.durationSeconds <= 0) return;
    session.drag = { paused: this.state.paused, originalSeconds: this.state.elapsedSeconds };
    this.publish({ ...this.state, paused: true, seeking: true });
    session.playback?.setPaused(true);
  }

  seekTo(seconds: number): void {
    if (!this.session?.drag || !Number.isFinite(seconds)) return;
    this.publish({
      ...this.state,
      elapsedSeconds: Math.max(0, Math.min(seconds, this.state.durationSeconds)),
    });
  }

  endSeek(): void {
    const session = this.session;
    if (!session?.drag) return;
    const paused = session.drag.paused;
    const seconds = this.state.elapsedSeconds;
    const index = session.segments.findIndex(
      (segment) => seconds < segment.start + segment.durationSeconds,
    );
    const selected = index < 0 ? session.segments.length - 1 : index;
    const segment = session.segments[selected];
    if (!segment) return;
    session.drag = null;
    session.cursor = { index: selected, offset: seconds - segment.start };
    session.playback = null;
    session.playbackAbort?.abort();
    this.publish({ ...this.state, paused, seeking: false });
    this.publishTimeline(session);
    wake(session);
  }

  cancelSeek(): void {
    if (!this.session?.drag) return;
    this.seekTo(this.session.drag.originalSeconds);
    this.endSeek();
  }

  async start(
    owner: string,
    markdown: string,
    context: Context,
    provider?: NarrationSettings["provider"],
  ): Promise<void> {
    this.stop();
    const chunks = narrationChunks(markdown, provider);
    if (chunks.length === 0) {
      this.publish({ ...this.state, owner, error: "This response has no readable text." });
      return;
    }
    const session: Session = {
      operation: new AbortController(),
      segments: [],
      changed: Promise.withResolvers<void>(),
      playbackAbort: null,
      playback: null,
      cursor: { index: 0, offset: 0 },
      duration: 0,
      complete: false,
      failure: null,
      drag: null,
    };
    this.session = session;
    this.publish({ ...this.state, owner, phase: "loading" });
    void this.generate(session, chunks, context);
    try {
      while (this.session === session) {
        const segment = session.segments[session.cursor.index];
        if (session.drag || !segment) {
          if (!session.drag && !segment) {
            if (session.failure) throw session.failure.error;
            if (session.complete) {
              this.stop();
              return;
            }
            this.publish({ ...this.state, phase: "loading" });
          }
          await session.changed.promise;
          continue;
        }
        const playbackAbort = new AbortController();
        session.playbackAbort = playbackAbort;
        const cursor = session.cursor;
        try {
          await this.dependencies.play(segment.audio, playbackAbort.signal, {
            startSeconds: session.cursor.offset,
            onReady: (playback) => {
              if (this.session !== session || playbackAbort.signal.aborted) return;
              session.playback = playback;
              playback.setRate(this.state.rate);
              this.publish({ ...this.state, phase: "playing" });
              playback.setPaused(this.state.paused);
            },
            onProgress: (seconds) => {
              if (
                this.session !== session ||
                playbackAbort.signal.aborted ||
                session.drag ||
                !Number.isFinite(seconds)
              )
                return;
              const elapsedSeconds =
                segment.start + Math.max(0, Math.min(seconds, segment.durationSeconds));
              if (elapsedSeconds !== this.state.elapsedSeconds)
                this.publish({ ...this.state, elapsedSeconds });
            },
          });
        } catch (error) {
          if (!playbackAbort.signal.aborted) throw error;
        }
        if (this.session !== session) return;
        session.playback = null;
        session.playbackAbort = null;
        if (cursor === session.cursor) {
          session.cursor = { index: session.cursor.index + 1, offset: 0 };
          if (!session.drag)
            this.publish({
              ...this.state,
              elapsedSeconds: segment.start + segment.durationSeconds,
            });
        }
      }
    } catch (error) {
      if (this.session !== session) return;
      this.stop();
      this.publish({
        ...this.state,
        owner,
        errorAction: speechErrorRequiresConfiguration(error) ? "speech-settings" : null,
        error: error instanceof Error ? error.message : "Could not read this response aloud.",
      });
    }
  }

  private async generate(session: Session, chunks: readonly string[], context: Context) {
    try {
      for (const text of chunks) {
        const audio = await this.dependencies.synthesize(text, context, session.operation.signal);
        if (this.session !== session) return;
        const info = await this.dependencies.inspect(audio, session.operation.signal);
        if (this.session !== session) return;
        if (!Number.isFinite(info.durationSeconds) || info.durationSeconds <= 0)
          throw new Error("The generated audio has no playable duration.");
        session.segments.push({ ...info, audio, start: session.duration });
        session.duration += info.durationSeconds;
        this.publishTimeline(session);
        wake(session);
      }
      session.complete = true;
      this.publishTimeline(session);
    } catch (error) {
      session.failure = { error };
    } finally {
      wake(session);
    }
  }

  private publishTimeline(session: Session) {
    if (this.session !== session || session.drag) return;
    this.publish({
      ...this.state,
      durationSeconds: session.duration,
      waveform: narrationWaveform(session.segments),
      complete: session.complete,
    });
  }

  private publish(state: NarrationState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
