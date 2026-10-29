import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { WebVoiceRecorder } from "./webVoiceRecorder";

it.each([0, 1])(
  "records input channel %s in the same mono signal shown by the meter",
  async (channel) => {
    await using resources = new AsyncDisposableStack();
    const sourceContext = new AudioContext();
    resources.defer(() => sourceContext.close());
    const meterContext = new AudioContext();
    resources.defer(() => (meterContext.state === "closed" ? undefined : meterContext.close()));
    await meterContext.suspend();
    const source = sourceContext.createBufferSource();
    const sampleRate = sourceContext.sampleRate;
    source.buffer = sourceContext.createBuffer(2, sampleRate / 4, sampleRate);
    const samples = source.buffer.getChannelData(channel);
    for (let index = 0; index < samples.length; index++)
      samples[index] = Math.sin((index * 2 * Math.PI * 440) / sampleRate);
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
    recorder.record({ forDuration: 300 });
    source.start();
    await vi.waitFor(() => expect(recorder.levels().some((level) => level > 0)).toBe(true));
    await sourceEnded.promise;
    await recorder.stop();
    await recorder.release();
    expect(meterContext.state).toBe("closed");
    const recording = recorder.uri ? recorder.read(recorder.uri) : undefined;
    expect(recording).toBeDefined();
    if (!recording) throw new Error("Recording was not saved");
    const audio = await sourceContext.decodeAudioData(await recording.blob.arrayBuffer());
    expect(audio.numberOfChannels).toBe(1);
    expect(audio.getChannelData(0).some((sample) => Math.abs(sample) > 0.1)).toBe(true);
  },
);
