import { randomUUID } from "~/lib/utils";
import {
  voiceTranscriptionFailure,
  type VoiceRecorder,
  type VoiceRecorderStatus,
} from "@t3tools/client-runtime/voice-input";
import type { SpeechAudioFormat } from "@t3tools/contracts";

const FORMATS: ReadonlyArray<{ readonly mimeType: string; readonly format: SpeechAudioFormat }> = [
  { mimeType: "audio/webm;codecs=opus", format: "webm" },
  { mimeType: "audio/mp4", format: "mp4" },
  { mimeType: "audio/ogg;codecs=opus", format: "ogg" },
];

export class WebVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private recording: { readonly promise: Promise<void>; readonly resolve: () => void } | null =
    null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private context: AudioContext | null = null;
  private analysers: AnalyserNode[] = [];
  private readonly recordings = new Map<
    string,
    { readonly blob: Blob; readonly format: SpeechAudioFormat }
  >();
  private readonly onStatus: (status: VoiceRecorderStatus) => void;

  constructor(onStatus: (status: VoiceRecorderStatus) => void) {
    this.onStatus = onStatus;
  }

  async requestPermission() {
    const desktop = window.desktopBridge;
    if (desktop?.getClientPlatform() === "darwin") {
      const granted = await desktop.requestMicrophoneAccess();
      return { granted, canAskAgain: granted };
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return { granted: true, canAskAgain: true };
  }

  async prepareToRecordAsync(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const format = FORMATS.find(({ mimeType }) => MediaRecorder.isTypeSupported(mimeType));
    if (!format) throw new Error("Audio recording is not supported in this browser.");
    const context = new AudioContext();
    this.context = context;
    const channels = this.stream.getAudioTracks()[0]?.getSettings().channelCount ?? 2;
    const splitter = context.createChannelSplitter(channels);
    context.createMediaStreamSource(this.stream).connect(splitter);
    this.analysers = Array.from({ length: channels }, (_, channel) => {
      const analyser = context.createAnalyser();
      analyser.fftSize = 64;
      splitter.connect(analyser, channel);
      return analyser;
    });
    await this.context.resume();
    this.uri = randomUUID();
    const uri = this.uri;
    const chunks: Blob[] = [];
    const recording = Promise.withResolvers<void>();
    this.recording = recording;
    // Capture the system input directly; metering must not alter or drive the recorded signal.
    this.recorder = new MediaRecorder(this.stream, { mimeType: format.mimeType });
    this.recorder.addEventListener("dataavailable", ({ data }) => {
      if (data.size) chunks.push(data);
    });
    this.recorder.addEventListener(
      "stop",
      () => {
        this.recordings.set(uri, {
          blob: new Blob(chunks, { type: format.mimeType }),
          format: format.format,
        });
        this.clearTimer();
        recording.resolve();
        this.onStatus({ isFinished: true, hasError: false, error: null, url: uri });
      },
      { once: true },
    );
    this.recorder.addEventListener(
      "error",
      () => {
        this.clearTimer();
        recording.resolve();
        this.onStatus({
          isFinished: true,
          hasError: true,
          error: "Voice recording failed.",
          url: uri,
        });
      },
      { once: true },
    );
    for (const track of this.stream.getAudioTracks())
      track.addEventListener(
        "ended",
        () => {
          this.onStatus({
            isFinished: true,
            hasError: true,
            error: "Microphone disconnected.",
            url: uri,
          });
        },
        { once: true },
      );
  }

  record({ forDuration }: { readonly forDuration: number }): void {
    this.recorder?.start();
    this.timer = setTimeout(() => {
      void this.stop();
    }, forDuration * 1000);
  }

  async stop(): Promise<void> {
    this.clearTimer();
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop();
      await this.recording?.promise;
    }
  }

  async release(): Promise<void> {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    const context = this.context;
    this.context = null;
    this.analysers = [];
    if (context) await context.close();
  }

  levels(): Uint8Array {
    const values = new Uint8Array(32);
    const channel = new Uint8Array(32);
    for (const analyser of this.analysers) {
      analyser.getByteFrequencyData(channel);
      for (let index = 0; index < values.length; index++)
        values[index] = Math.max(values[index] ?? 0, channel[index] ?? 0);
    }
    return values;
  }

  async read(uri: string) {
    const recording = this.recordings.get(uri);
    if (!recording) return undefined;
    const decoder = new OfflineAudioContext(1, 1, 48000);
    const audio = await decoder.decodeAudioData(await recording.blob.arrayBuffer());
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      if (audio.getChannelData(channel).some((sample) => Math.abs(sample) > 0.0001))
        return recording;
    }
    throw voiceTranscriptionFailure(
      new Error(
        "No audio was captured. Check the default input and microphone access for this app on this device, then try again.",
      ),
    );
  }
  delete(uri: string): void {
    this.recordings.delete(uri);
  }
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
