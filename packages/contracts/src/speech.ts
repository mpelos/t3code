import * as Schema from "effect/Schema";
import { DictationSettings, NarrationSettings } from "./settings.ts";

export const SPEECH_AUDIO_MAX_BYTES = 20 * 1024 * 1024;
export const NARRATION_CHUNK_MAX_BYTES = 4000;
export const QWEN_NARRATION_CHUNK_MAX_CHARACTERS = 300;
export const SpeechAudioFormat = Schema.Literals(["webm", "mp4", "m4a", "ogg", "wav"]);
export type SpeechAudioFormat = typeof SpeechAudioFormat.Type;

export const NarrationInput = Schema.Struct({
  text: Schema.NonEmptyString.check(Schema.isMaxLength(NARRATION_CHUNK_MAX_BYTES)),
});
export type NarrationInput = typeof NarrationInput.Type;

export const SpeechConfigureInput = Schema.Union([
  Schema.Struct({ role: Schema.Literal("dictation"), config: Schema.NullOr(DictationSettings) }),
  Schema.Struct({ role: Schema.Literal("narration"), config: Schema.NullOr(NarrationSettings) }),
]);
export type SpeechConfigureInput = typeof SpeechConfigureInput.Type;

export function isNarrationConfigured(config: NarrationSettings | null | undefined): boolean {
  return config != null && (config.provider === "qwen" || Boolean(config.credential));
}

export class SpeechError extends Schema.TaggedError<SpeechError>()(
  "SpeechError",
  {
    provider: Schema.optionalKey(Schema.Literals(["openai", "google", "elevenlabs", "qwen"])),
    role: Schema.optionalKey(Schema.Literals(["dictation", "narration"])),
    reason: Schema.Literals([
      "not-configured",
      "invalid-credential",
      "permission-denied",
      "quota-exceeded",
      "invalid-audio",
      "invalid-text",
      "rejected",
      "unavailable",
      "invalid-response",
    ]),
  },
  { httpApiStatus: 502 },
) {
  override get message(): string {
    const provider =
      this.provider === "openai"
        ? "OpenAI"
        : this.provider === "google"
          ? "Google Cloud"
          : this.provider === "elevenlabs"
            ? "ElevenLabs"
            : this.provider === "qwen"
              ? "Qwen3-TTS"
              : "Speech";
    const context = `${provider}${this.role ? ` ${this.role}` : ""}: `;
    if (this.provider === "qwen") {
      switch (this.reason) {
        case "unavailable":
          return (
            context +
            "The local voice server is unavailable or still loading. Start MLX Audio on the selected Speech environment and check its server URL."
          );
        case "rejected":
          return (
            context +
            "The local voice server rejected the request. Check the installed CustomVoice model, voice, and language in Speech settings."
          );
        case "quota-exceeded":
          return (
            context +
            "The local voice server is busy. Try again after the current generation finishes."
          );
        case "invalid-credential":
        case "permission-denied":
          return (
            context +
            "The local voice server denied access. Check its address and access configuration in Speech settings."
          );
        case "invalid-response":
          return (
            context +
            "The local voice server did not return playable MP3 audio. Check its model and FFmpeg installation."
          );
      }
    }
    switch (this.reason) {
      case "not-configured":
        return context + "Configure a speech provider in Settings first.";
      case "invalid-credential":
        return (
          context +
          (this.provider === "google"
            ? "Google rejected the service account credentials. Check the JSON key and the environment clock in Speech settings."
            : "The API key is invalid or expired. Update it in Speech settings.")
        );
      case "permission-denied":
        return (
          context +
          "Access was denied. Check the key permissions and enable the required API in your provider account."
        );
      case "quota-exceeded":
        return (
          context +
          "The provider rate limit or quota was reached. Check your balance and limits, then try again."
        );
      case "invalid-audio":
        return context + "The recording is empty, too large, or uses an unsupported format.";
      case "invalid-text":
        return context + "There is no readable text, or this narration segment is too large.";
      case "rejected":
        return (
          context +
          "The speech provider rejected the request. Check your voice, language, billing, and quota."
        );
      case "unavailable":
        return context + "The speech provider could not be reached. Try again.";
      case "invalid-response":
        return context + "The speech provider returned an invalid response.";
    }
  }
}
