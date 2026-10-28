import { narrationChunks } from "@t3tools/shared/narration";

export type NarrationState = {
  readonly owner: string | null;
  readonly phase: "idle" | "loading" | "playing";
  readonly error: string | null;
};

export class NarrationController<Context> {
  private state: NarrationState = { owner: null, phase: "idle", error: null };
  private readonly listeners = new Set<() => void>();
  private active: AbortController | null = null;

  private readonly dependencies: {
    readonly synthesize: (
      text: string,
      context: Context,
      signal: AbortSignal,
    ) => Promise<Uint8Array>;
    readonly play: (audio: Uint8Array, signal: AbortSignal) => Promise<void>;
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
    this.publish({ owner: null, phase: "idle", error: null });
  }

  async start(owner: string, markdown: string, context: Context): Promise<void> {
    this.stop();
    const chunks = narrationChunks(markdown);
    if (chunks.length === 0) {
      this.publish({ owner, phase: "idle", error: "This response has no readable text." });
      return;
    }
    const operation = new AbortController();
    this.active = operation;
    try {
      for (const text of chunks) {
        this.publish({ owner, phase: "loading", error: null });
        const audio = await this.dependencies.synthesize(text, context, operation.signal);
        if (operation.signal.aborted) return;
        this.publish({ owner, phase: "playing", error: null });
        await this.dependencies.play(audio, operation.signal);
        if (operation.signal.aborted) return;
      }
      if (this.active === operation) this.stop();
    } catch (error) {
      if (operation.signal.aborted) return;
      operation.abort();
      this.active = null;
      this.publish({
        owner,
        phase: "idle",
        error: error instanceof Error ? error.message : "Could not read this response aloud.",
      });
    }
  }

  private publish(state: NarrationState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
