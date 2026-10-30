import { SpeechError } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { NarrationController } from "./narration.ts";

it("keeps the first audio playing while the seekable waveform grows and freezes it during a drag", async () => {
  const ready = Promise.withResolvers<void>();
  const next = Promise.withResolvers<Uint8Array>();
  const firstFinished = Promise.withResolvers<void>();
  const moved = Promise.withResolvers<void>();
  const preparedNext = Promise.withResolvers<void>();
  const forward = Promise.withResolvers<void>();
  const tail = Promise.withResolvers<Uint8Array>();
  const pauses: boolean[] = [];
  const starts: number[] = [];
  let generated = 0;
  const controller = new NarrationController<void>({
    synthesize: async () => {
      generated++;
      if (generated === 1) return new Uint8Array([1]);
      if (generated === 2) return next.promise;
      preparedNext.resolve();
      return tail.promise;
    },
    inspect: async () => ({ durationSeconds: 10, waveform: [0.2, 0.8] }),
    play: async (_audio, signal, options) => {
      starts.push(options.startSeconds);
      options.onReady({ setPaused: (paused) => pauses.push(paused), setRate: () => {} });
      if (starts.length === 1) {
        ready.resolve();
        signal.addEventListener("abort", () => firstFinished.resolve(), { once: true });
        await firstFinished.promise;
      } else {
        if (starts.length === 2) moved.resolve();
        else forward.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
    },
  });
  const reading = controller.start("reply", "A".repeat(4100), undefined);
  await ready.promise;
  expect(controller.getSnapshot().durationSeconds).toBe(10);
  controller.beginSeek();
  controller.seekTo(7.2);
  expect(controller.getSnapshot()).toMatchObject({
    paused: true,
    seeking: true,
    elapsedSeconds: 7.2,
  });
  expect(pauses.at(-1)).toBe(true);
  const frozen = controller.getSnapshot().waveform;
  next.resolve(new Uint8Array([2]));
  await preparedNext.promise;
  expect(controller.getSnapshot().durationSeconds).toBe(10);
  expect(controller.getSnapshot().waveform).toBe(frozen);
  controller.endSeek();
  await moved.promise;
  expect(starts).toEqual([0, 7.2]);
  expect(pauses.at(-1)).toBe(false);
  expect(frozen.length).toBeGreaterThan(0);
  expect(controller.getSnapshot().durationSeconds).toBe(20);
  controller.togglePaused();
  controller.beginSeek();
  controller.seekTo(100);
  expect(controller.getSnapshot().elapsedSeconds).toBe(20);
  controller.seekTo(15);
  controller.endSeek();
  await forward.promise;
  expect(starts).toEqual([0, 7.2, 5]);
  expect(pauses.at(-1)).toBe(true);
  expect(generated).toBe(3);
  controller.beginSeek();
  controller.seekTo(0);
  controller.cancelSeek();
  expect(controller.getSnapshot()).toMatchObject({
    paused: true,
    seeking: false,
    elapsedSeconds: 15,
  });
  controller.stop();
  await reading;
});

it("restores the original position when a drag is cancelled as its audio segment finishes", async () => {
  const ready = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const starts: number[] = [];
  const controller = new NarrationController<void>({
    synthesize: async () => new Uint8Array([1]),
    inspect: async () => ({ durationSeconds: 10, waveform: [0.5] }),
    play: async (_audio, _signal, options) => {
      starts.push(options.startSeconds);
      options.onReady({
        setRate: () => {},
        setPaused: (paused) => {
          if (paused) finished.resolve();
        },
      });
      if (starts.length === 1) {
        options.onProgress(3);
        ready.resolve();
        await finished.promise;
      }
    },
  });
  const reading = controller.start("reply", "Hello", undefined);
  await ready.promise;
  controller.beginSeek();
  controller.seekTo(8);
  controller.cancelSeek();
  await reading;
  expect(starts).toEqual([0, 3]);
});

it("ignores an interrupted playback failure when seeking within the same response", async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const paused: boolean[] = [];
  let plays = 0;
  const controller = new NarrationController<void>({
    synthesize: async () => new Uint8Array([1]),
    inspect: async () => ({ durationSeconds: 10, waveform: [0.5] }),
    play: async (_audio, signal, options) => {
      const initial = ++plays === 1;
      options.onReady({ setRate: () => {}, setPaused: (value) => paused.push(value) });
      if (initial) first.resolve();
      else second.resolve();
      await new Promise<void>((resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            if (initial) reject(new Error("The interrupted seek failed"));
            else resolve();
          },
          { once: true },
        ),
      );
    },
  });
  const reading = controller.start("reply", "Hello", undefined);
  await first.promise;
  controller.beginSeek();
  controller.seekTo(3);
  controller.endSeek();
  await second.promise;
  expect(controller.getSnapshot()).toMatchObject({
    error: null,
    seeking: false,
    paused: false,
    elapsedSeconds: 3,
  });
  expect(paused.at(-1)).toBe(false);
  controller.stop();
  await reading;
});

it.each(["loading", "playing"] as const)(
  "cancels %s and ignores a late completion after another response starts",
  async (phase) => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<Uint8Array>();
    const playFinished = Promise.withResolvers<void>();
    const played: number[] = [];
    const controller = new NarrationController<string>({
      inspect: async () => ({ durationSeconds: 20, waveform: [0.2, 0.8] }),
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
      durationSeconds: 0,
      waveform: [],
      seeking: false,
      complete: false,
    });
  },
);

it("aborts background generation when playback fails", async () => {
  const synthesize = vi.fn(
    async (_text: string, _context: void, _signal: AbortSignal) => new Uint8Array([1]),
  );
  const controller = new NarrationController<void>({
    synthesize,
    inspect: async () => ({ durationSeconds: 20, waveform: [0.2, 0.8] }),
    play: async () => {
      throw new Error("Audio device unavailable");
    },
  });
  await controller.start("reply", "A long response. ".repeat(1000), undefined);
  expect(synthesize).toHaveBeenCalledTimes(2);
  expect(synthesize.mock.calls.every(([, , signal]) => signal.aborted)).toBe(true);
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
    inspect: async () => ({ durationSeconds: 20, waveform: [0.2, 0.8] }),
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
  expect(firstRate).toHaveBeenLastCalledWith(1.25);
  controller.cycleRate();
  expect(firstRate).toHaveBeenLastCalledWith(1.5);
  controller.cycleRate();
  expect(firstRate).toHaveBeenLastCalledWith(1.75);
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
    elapsedSeconds: 23.5,
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
    inspect: async () => ({ durationSeconds: 20, waveform: [0.2, 0.8] }),
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
  expect(setRate).toHaveBeenCalledExactlyOnceWith(1.25);
  controller.togglePaused();
  finished.resolve();
  await reading;
  expect(controller.getSnapshot()).toMatchObject({
    owner: null,
    phase: "idle",
    paused: false,
    rate: 1.25,
  });
});

it.each([
  "invalid-credential",
  "permission-denied",
  "insufficient-credit",
  "rejected",
  "quota-exceeded",
  "unavailable",
] as const)("presents %s with the appropriate recovery action", async (reason) => {
  const error = new SpeechError({ reason, provider: "elevenlabs", role: "narration" });
  const play = vi.fn();
  const controller = new NarrationController<void>({
    inspect: async () => ({ durationSeconds: 20, waveform: [0.2, 0.8] }),
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
