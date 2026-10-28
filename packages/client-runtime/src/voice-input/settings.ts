import * as Schema from "effect/Schema";
import {
  SpeechError,
  DEFAULT_QWEN_NARRATION_URL,
  QwenNarrationSettings,
  type DictationSettings,
  type NarrationSettings,
} from "@t3tools/contracts";

const SPEECH_PROVIDERS = [
  { value: "disabled", label: "Disabled" },
  { value: "openai", label: "OpenAI" },
  { value: "google", label: "Google Cloud" },
  { value: "elevenlabs", label: "ElevenLabs" },
  { value: "qwen", label: "Qwen3-TTS (local)" },
] as const;
export function speechProviderOptions(role: "dictation" | "narration") {
  return role === "narration"
    ? SPEECH_PROVIDERS
    : SPEECH_PROVIDERS.filter(
        ({ value }) => value === "disabled" || value === "openai" || value === "google",
      );
}
export type SpeechProvider = (typeof SPEECH_PROVIDERS)[number]["value"];
const decodeQwenNarrationSettings = Schema.decodeUnknownSync(QwenNarrationSettings);
export type SpeechSettingsDraft = {
  readonly provider: SpeechProvider;
  readonly credential: string;
  readonly language: string;
  readonly voice: string;
  readonly baseUrl: string;
};

export function speechSettingsDraft(
  config: DictationSettings | NarrationSettings | null,
): SpeechSettingsDraft {
  return {
    provider: config?.provider ?? "disabled",
    credential: "",
    language: config && "language" in config ? config.language : "en-US",
    voice: config && "voice" in config ? config.voice : "coral",
    baseUrl: config?.provider === "qwen" ? config.baseUrl : DEFAULT_QWEN_NARRATION_URL,
  };
}

export function selectSpeechProvider(
  draft: SpeechSettingsDraft,
  provider: SpeechProvider,
): SpeechSettingsDraft {
  return {
    ...draft,
    provider,
    credential: "",
    voice:
      provider === "qwen"
        ? "Ryan"
        : provider === "google"
          ? "en-US-Chirp3-HD-Aoede"
          : provider === "openai"
            ? "coral"
            : "",
    language:
      provider === "qwen" ? "Portuguese" : draft.provider === "qwen" ? "en-US" : draft.language,
  };
}

function credentialFor(
  draft: SpeechSettingsDraft,
  current: DictationSettings | NarrationSettings | null,
): string {
  const credential =
    draft.credential.trim() ||
    (current?.provider === draft.provider && "credential" in current ? current.credential : "");
  if (!credential) throw new Error("Enter credentials before enabling this provider.");
  return credential;
}

export function dictationSettingsFromDraft(
  draft: SpeechSettingsDraft,
  current: DictationSettings | null,
): DictationSettings | null {
  if (draft.provider === "disabled") return null;
  if (draft.provider === "elevenlabs" || draft.provider === "qwen")
    throw new Error("Choose OpenAI or Google Cloud for dictation.");
  if (!draft.language.trim()) throw new Error("Enter a language code, such as pt-BR.");
  return {
    provider: draft.provider,
    credential: credentialFor(draft, current),
    language: draft.language.trim(),
  };
}

export function narrationSettingsFromDraft(
  draft: SpeechSettingsDraft,
  current: NarrationSettings | null,
): NarrationSettings | null {
  if (draft.provider === "disabled") return null;
  if (draft.provider === "qwen") {
    return decodeQwenNarrationSettings({
      provider: "qwen",
      baseUrl: draft.baseUrl,
      voice: draft.voice,
      language: draft.language,
    });
  }
  const credential = credentialFor(draft, current);
  if (!draft.voice.trim()) throw new Error("Enter a voice name or ID.");
  if (draft.provider === "google") {
    if (!draft.language.trim()) throw new Error("Enter a language code, such as pt-BR.");
    return {
      provider: "google",
      credential,
      voice: draft.voice.trim(),
      language: draft.language.trim(),
    };
  }
  return { provider: draft.provider, credential, voice: draft.voice.trim() };
}

const isSpeechError = Schema.is(SpeechError);

export function speechErrorRequiresConfiguration(error: unknown): boolean {
  return (
    isSpeechError(error) &&
    ((error.provider === "qwen" &&
      (error.reason === "unavailable" || error.reason === "invalid-response")) ||
      error.reason === "invalid-credential" ||
      error.reason === "permission-denied" ||
      error.reason === "not-configured" ||
      error.reason === "rejected")
  );
}
