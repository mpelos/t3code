import { expect, it, vi } from "vite-plus/test";
import { NarrationController } from "./narration.ts";

it.each(["loading", "playing"] as const)(
  "cancels %s and ignores a late completion after another response starts",
  async (phase) => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<Uint8Array>();
    const playFinished = Promise.withResolvers<void>();
    const played: number[] = [];
    const controller = new NarrationController<string>({
      synthesize: async (_text, context) => {
        if (context === "first") {
          if (phase === "loading") {
            entered.resolve();
            return finish.promise;
          }
          return new Uint8Array([1]);
        }
        return new Uint8Array([2]);
      },
      play: async (audio) => {
        played.push(audio[0] ?? 0);
        if (audio[0] === 1) {
          entered.resolve();
          await playFinished.promise;
        }
      },
    });
    const first = controller.start("first", "First response", "first");
    await entered.promise;
    await controller.start("second", "Second response", "second");
    finish.resolve(new Uint8Array([1]));
    playFinished.resolve();
    await first;
    expect(played).toEqual(phase === "loading" ? [2] : [1, 2]);
    expect(controller.getSnapshot()).toEqual({ owner: null, phase: "idle", error: null });
  },
);

it("plays long responses in order and stops before requesting more audio on failure", async () => {
  const synthesize = vi.fn(async () => new Uint8Array([1]));
  const controller = new NarrationController<void>({
    synthesize,
    play: async () => {
      throw new Error("Audio device unavailable");
    },
  });
  await controller.start("reply", "A long response. ".repeat(1000), undefined);
  expect(synthesize).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot()).toMatchObject({
    owner: "reply",
    phase: "idle",
    error: "Audio device unavailable",
  });
});
