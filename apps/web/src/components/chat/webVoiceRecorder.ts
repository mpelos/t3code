import { randomUUID } from "~/lib/utils";
import type { VoiceRecorder, VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";
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
  private analyser: AnalyserNode | null = null;
  private readonly recordings = new Map<
    string,
    { readonly blob: Blob; readonly format: SpeechAudioFormat }
  >();
  private readonly onStatus: (status: VoiceRecorderStatus) => void;

  constructor(onStatus: (status: VoiceRecorderStatus) => void) {
    this.onStatus = onStatus;
  }

  async requestPermission() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    for (const track of stream.getTracks()) track.stop();
    return { granted: true, canAskAgain: true };
  }

  async prepareToRecordAsync(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    const format = FORMATS.find(({ mimeType }) => MediaRecorder.isTypeSupported(mimeType));
    if (!format) throw new Error("Audio recording is not supported in this browser.");
    this.uri = randomUUID();
    const uri = this.uri;
    const chunks: Blob[] = [];
    const recording = Promise.withResolvers<void>();
    this.recording = recording;
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
    this.context = new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 64;
    this.context.createMediaStreamSource(this.stream).connect(this.analyser);
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
    this.analyser = null;
    if (context) await context.close();
  }

  levels(): Uint8Array {
    const values = new Uint8Array(32);
    this.analyser?.getByteFrequencyData(values);
    return values;
  }

  read(uri: string) {
    return this.recordings.get(uri);
  }
  delete(uri: string): void {
    this.recordings.delete(uri);
  }
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
