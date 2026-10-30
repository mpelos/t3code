import { expect, it } from "vite-plus/test";
import { inspectNarrationAudio, narrationWaveform } from "./narrationWaveform.ts";

it.each(["right", "opposite-phase", "silent"] as const)(
  "extracts real %s samples without cancelling channels",
  (input) => {
    const left = new Float32Array(120);
    const right = new Float32Array(120);
    if (input !== "silent") right.fill(0.5, 60);
    if (input === "opposite-phase") left.fill(-0.5, 60);
    const audio = inspectNarrationAudio({
      duration: 1,
      length: 120,
      numberOfChannels: 2,
      getChannelData: (channel) => (channel === 0 ? left : right),
    });
    expect(audio.durationSeconds).toBe(1);
    expect(audio.waveform.slice(0, 6)).toEqual(Array(6).fill(0));
    expect(audio.waveform.slice(6)).toEqual(Array(6).fill(input === "silent" ? 0 : 0.5));
  },
);

it("maps waveform peaks by duration and rejects audio without a playable length", () => {
  const waveform = narrationWaveform([
    { durationSeconds: 1, waveform: [0] },
    { durationSeconds: 3, waveform: [0.5] },
  ]);
  expect(waveform.slice(0, 16)).toEqual(Array(16).fill(0));
  expect(waveform.slice(16)).toEqual(Array(48).fill(1));
  expect(() =>
    inspectNarrationAudio({
      duration: 0,
      length: 0,
      numberOfChannels: 0,
      getChannelData: () => new Float32Array(),
    }),
  ).toThrow("no playable duration");
});
