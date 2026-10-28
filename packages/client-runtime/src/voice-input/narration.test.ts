import { SpeechError } from "@t3tools/contracts";
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
      play: async (audio, _signal, options) => {
        options.onReady({ setPaused: () => {}, setRate: () => {} });
        played.push(audio[0] ?? 0);
        if (audio[0] === 1) {
          entered.resolve();
          await playFinished.promise;
        }
      },
    });
    const first = controller.start("first", "First response", "first");
    await entered.promise;
    expect(controller.getSnapshot().phase).toBe(phase);
    await controller.start("second", "Second response", "second");
    finish.resolve(new Uint8Array([1]));
    playFinished.resolve();
    await first;
    expect(played).toEqual(phase === "loading" ? [2] : [1, 2]);
    expect(controller.getSnapshot()).toEqual({
      owner: null,
      phase: "idle",
      error: null,
      errorAction: null,
      paused: false,
      rate: 1,
      elapsedSeconds: 0,
    });
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

it("keeps pause, speed and elapsed time across audio segments, then closes without playing more", async () => {
  const firstReady = Promise.withResolvers<void>();
  const secondRequested = Promise.withResolvers<void>();
  const secondAudio = Promise.withResolvers<Uint8Array>();
  const secondReady = Promise.withResolvers<void>();
  const firstFinished = Promise.withResolvers<void>();
  const secondFinished = Promise.withResolvers<void>();
  const firstPaused = vi.fn();
  const firstRate = vi.fn();
  const secondPaused = vi.fn();
  const secondRate = vi.fn();
  const played: number[] = [];
  const synthesize = vi.fn(async () => {
    if (synthesize.mock.calls.length === 1) return new Uint8Array([1]);
    if (synthesize.mock.calls.length > 2) return new Uint8Array([3]);
    secondRequested.resolve();
    return secondAudio.promise;
  });
  const controller = new NarrationController<void>({
    synthesize,
    play: async (audio, signal, options) => {
      played.push(audio[0] ?? 0);
      if (audio[0] === 1) {
        options.onReady({ setPaused: firstPaused, setRate: firstRate });
        options.onProgress(12.8);
        firstReady.resolve();
        await firstFinished.promise;
      } else {
        signal.addEventListener("abort", () => secondFinished.resolve(), { once: true });
        options.onReady({ setPaused: secondPaused, setRate: secondRate });
        options.onProgress(3.5);
        secondReady.resolve();
        await secondFinished.promise;
        options.onProgress(100);
      }
    },
  });
  const reading = controller.start("reply", "A long response. ".repeat(1000), undefined);
  await firstReady.promise;
  await secondRequested.promise;
  expect(controller.getSnapshot().phase).toBe("playing");
  controller.togglePaused();
  expect(firstPaused).toHaveBeenLastCalledWith(true);
  controller.cycleRate();
  expect(firstRate).toHaveBeenLastCalledWith(1.5);
  controller.cycleRate();
  expect(firstRate).toHaveBeenLastCalledWith(2);
  controller.togglePaused();
  expect(firstPaused).toHaveBeenLastCalledWith(false);
  firstFinished.resolve();
  await secondRequested.promise;
  controller.togglePaused();
  secondAudio.resolve(new Uint8Array([2]));
  await secondReady.promise;
  expect(secondPaused).toHaveBeenLastCalledWith(true);
  expect(secondRate).toHaveBeenLastCalledWith(2);
  expect(controller.getSnapshot()).toMatchObject({
    phase: "playing",
    paused: true,
    elapsedSeconds: 16,
  });
  controller.cycleRate();
  expect(secondRate).toHaveBeenLastCalledWith(1);
  controller.togglePaused();
  expect(secondPaused).toHaveBeenLastCalledWith(false);
  controller.stop();
  await reading;
  expect(controller.getSnapshot()).toMatchObject({ owner: null, phase: "idle", elapsedSeconds: 0 });
  expect(synthesize).toHaveBeenCalledTimes(3);
  expect(played).toEqual([1, 2]);
});

it("applies controls changed during initial loading and clears the player on natural completion", async () => {
  const audio = Promise.withResolvers<Uint8Array>();
  const ready = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const setPaused = vi.fn();
  const setRate = vi.fn();
  const controller = new NarrationController<void>({
    synthesize: () => audio.promise,
    play: async (_audio, _signal, options) => {
      options.onReady({ setPaused, setRate });
      ready.resolve();
      await finished.promise;
    },
  });
  const reading = controller.start("reply", "Hello", undefined);
  controller.togglePaused();
  controller.cycleRate();
  audio.resolve(new Uint8Array([1]));
  await ready.promise;
  expect(setPaused).toHaveBeenCalledExactlyOnceWith(true);
  expect(setRate).toHaveBeenCalledExactlyOnceWith(1.5);
  controller.togglePaused();
  finished.resolve();
  await reading;
  expect(controller.getSnapshot()).toMatchObject({
    owner: null,
    phase: "idle",
    paused: false,
    rate: 1.5,
  });
});

it.each([
  "invalid-credential",
  "permission-denied",
  "rejected",
  "quota-exceeded",
  "unavailable",
] as const)("presents %s with the appropriate recovery action", async (reason) => {
  const error = new SpeechError({ reason, provider: "elevenlabs", role: "narration" });
  const play = vi.fn();
  const controller = new NarrationController<void>({
    synthesize: async () => {
      throw error;
    },
    play,
  });
  await controller.start("reply", "Hello", undefined);
  expect(controller.getSnapshot()).toMatchObject({
    owner: "reply",
    phase: "idle",
    error: error.message,
    errorAction: reason === "quota-exceeded" || reason === "unavailable" ? null : "speech-settings",
  });
  expect(play).not.toHaveBeenCalled();
});
