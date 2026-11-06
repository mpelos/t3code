export type NarrationAudioInfo = {
  readonly durationSeconds: number;
  readonly waveform: readonly number[];
};

export function inspectNarrationAudio(audio: {
  readonly duration: number;
  readonly length: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}): NarrationAudioInfo {
  if (!Number.isFinite(audio.duration) || audio.duration <= 0 || audio.length === 0)
    throw new Error("The generated audio has no playable duration.");
  const count = Math.max(1, Math.ceil(audio.duration * 12));
  const waveform = Array<number>(count).fill(0);
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const samples = audio.getChannelData(channel);
    for (let bin = 0; bin < count; bin++) {
      const start = Math.floor((bin * samples.length) / count);
      const end = Math.floor(((bin + 1) * samples.length) / count);
      let squares = 0;
      for (let index = start; index < end; index++) squares += (samples[index] ?? 0) ** 2;
      waveform[bin] = Math.max(waveform[bin] ?? 0, Math.sqrt(squares / Math.max(1, end - start)));
    }
  }
  return { durationSeconds: audio.duration, waveform };
}

export function narrationWaveform(segments: readonly NarrationAudioInfo[]): readonly number[] {
  const duration = segments.reduce((total, segment) => total + segment.durationSeconds, 0);
  if (duration <= 0) return [];
  const bars = Array<number>(64).fill(0);
  let offset = 0;
  for (const segment of segments) {
    for (const [index, peak] of segment.waveform.entries()) {
      const start = Math.floor(
        ((offset + (index * segment.durationSeconds) / segment.waveform.length) / duration) *
          bars.length,
      );
      const end = Math.ceil(
        ((offset + ((index + 1) * segment.durationSeconds) / segment.waveform.length) / duration) *
          bars.length,
      );
      for (let bar = start; bar < Math.min(end, bars.length); bar++)
        bars[bar] = Math.max(bars[bar] ?? 0, peak);
    }
    offset += segment.durationSeconds;
  }
  const maximum = Math.max(0.001, ...bars);
  return bars.map((peak) => Math.sqrt(peak / maximum));
}

export function formatNarrationTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function narrationWaveformPath(waveform: readonly number[]): string {
  return waveform
    .map((level, index) => {
      const x = (((index + 0.5) * 256) / waveform.length).toFixed(2);
      const height = 2 + Math.max(0, Math.min(1, level)) * 24;
      return `M${x},${((28 - height) / 2).toFixed(2)}v${height.toFixed(2)}`;
    })
    .join("");
}
