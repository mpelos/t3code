import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { WebVoiceRecorder } from "./webVoiceRecorder";

it.each([true, false])(
  "waits for macOS microphone permission (%s) before capture",
  async (granted) => {
    using resources = new DisposableStack();
    const decision = Promise.withResolvers<boolean>();
    vi.stubGlobal("desktopBridge", {
      getClientPlatform: () => "darwin",
      requestMicrophoneAccess: () => decision.promise,
    });
    resources.defer(() => vi.unstubAllGlobals());
    using capture = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockRejectedValue(
        new Error("Native permission must be resolved before opening the microphone"),
      );
    const recorder = new WebVoiceRecorder(() => {});
    const permission = recorder.requestPermission();
    decision.resolve(granted);
    expect(await permission).toEqual({ granted, canAskAgain: granted });
    expect(capture).not.toHaveBeenCalled();
  },
);

it.each(["left", "right", "opposite-phase", "suspended-meter", "silent"] as const)(
  "captures %s input without submitting silent audio",
  async (input) => {
    await using resources = new AsyncDisposableStack();
    const sourceContext = new AudioContext();
    resources.defer(() => sourceContext.close());
    const meterContext = new AudioContext();
    resources.defer(() => (meterContext.state === "closed" ? undefined : meterContext.close()));
    await meterContext.suspend();
    const source = sourceContext.createBufferSource();
    const sampleRate = sourceContext.sampleRate;
    source.buffer = sourceContext.createBuffer(2, sampleRate / 4, sampleRate);
    const samples = source.buffer.getChannelData(input === "right" ? 1 : 0);
    if (input !== "silent") {
      for (let index = 0; index < samples.length; index++)
        samples[index] = Math.sin((index * 2 * Math.PI * 440) / sampleRate);
    }
    if (input === "opposite-phase") {
      const right = source.buffer.getChannelData(1);
      for (let index = 0; index < right.length; index++) right[index] = -(samples[index] ?? 0);
    }
    const sourceEnded = Promise.withResolvers<void>();
    source.onended = () => sourceEnded.resolve();
    const destination = sourceContext.createMediaStreamDestination();
    source.connect(destination);
    resources.defer(() => {
      for (const track of destination.stream.getTracks()) track.stop();
    });
    await using screen = await render(
      <button onClick={() => void sourceContext.resume()}>Enable test audio</button>,
    );
    using _audioContext = vi.spyOn(globalThis, "AudioContext").mockImplementation(function () {
      return meterContext;
    });
    using _capture = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockImplementation(async () => destination.stream.clone());
    const recorder = new WebVoiceRecorder(() => {});
    resources.defer(async () => {
      await recorder.stop();
      await recorder.release();
    });
    await userEvent.click(screen.getByRole("button", { name: "Enable test audio" }));
    await recorder.requestPermission();
    await recorder.prepareToRecordAsync();
    expect(meterContext.state).toBe("running");
    if (input === "suspended-meter") await meterContext.suspend();
    recorder.record({ forDuration: 300 });
    source.start();
    if (input !== "silent" && input !== "suspended-meter") {
      await vi.waitFor(() => expect(recorder.levels().some((level) => level > 0)).toBe(true));
    }
    await sourceEnded.promise;
    await recorder.stop();
    await recorder.release();
    expect(meterContext.state).toBe("closed");
    if (input === "silent") {
      await expect(async () => recorder.read(recorder.uri ?? "")).rejects.toThrow(
        "No audio was captured",
      );
      return;
    }
    const recording = recorder.uri ? await recorder.read(recorder.uri) : undefined;
    expect(recording).toBeDefined();
    if (!recording) throw new Error("Recording was not saved");
    const audio = await sourceContext.decodeAudioData(await recording.blob.arrayBuffer());
    expect(
      Array.from({ length: audio.numberOfChannels }, (_, channel) =>
        audio.getChannelData(channel).some((sample) => Math.abs(sample) > 0.1),
      ).some(Boolean),
    ).toBe(true);
  },
);
