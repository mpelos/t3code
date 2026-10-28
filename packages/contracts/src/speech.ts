import * as Schema from "effect/Schema";

export const SPEECH_AUDIO_MAX_BYTES = 20 * 1024 * 1024;
export const NARRATION_CHUNK_MAX_BYTES = 4000;
export const SpeechAudioFormat = Schema.Literals(["webm", "mp4", "m4a", "ogg", "wav"]);
export type SpeechAudioFormat = typeof SpeechAudioFormat.Type;

export const NarrationInput = Schema.Struct({
  text: Schema.NonEmptyString.check(Schema.isMaxLength(NARRATION_CHUNK_MAX_BYTES)),
});
export type NarrationInput = typeof NarrationInput.Type;

export class SpeechError extends Schema.TaggedError<SpeechError>()(
  "SpeechError",
  {
    reason: Schema.Literals([
      "not-configured",
      "invalid-credential",
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
    switch (this.reason) {
      case "not-configured":
        return "Configure a speech provider in Settings first.";
      case "invalid-credential":
        return "The speech credentials are invalid or lack permission. Check Settings.";
      case "invalid-audio":
        return "The recording is empty, too large, or uses an unsupported format.";
      case "invalid-text":
        return "There is no readable text, or this narration segment is too large.";
      case "rejected":
        return "The speech provider rejected the request. Check your voice, language, billing, and quota.";
      case "unavailable":
        return "The speech provider could not be reached. Try again.";
      case "invalid-response":
        return "The speech provider returned an invalid response.";
    }
  }
}
