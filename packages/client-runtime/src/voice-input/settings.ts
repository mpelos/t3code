import type { DictationSettings, NarrationSettings } from "@t3tools/contracts";

export const SPEECH_PROVIDERS = [
  { value: "disabled", label: "Disabled" },
  { value: "openai", label: "OpenAI" },
  { value: "google", label: "Google Cloud" },
  { value: "elevenlabs", label: "ElevenLabs" },
] as const;
export type SpeechProvider = (typeof SPEECH_PROVIDERS)[number]["value"];
export type SpeechSettingsDraft = {
  readonly provider: SpeechProvider;
  readonly credential: string;
  readonly language: string;
  readonly voice: string;
};

export function speechSettingsDraft(
  config: DictationSettings | NarrationSettings | null,
): SpeechSettingsDraft {
  return {
    provider: config?.provider ?? "disabled",
    credential: "",
    language: config && "language" in config ? config.language : "en-US",
    voice: config && "voice" in config ? config.voice : "coral",
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
    voice: provider === "google" ? "en-US-Chirp3-HD-Aoede" : provider === "openai" ? "coral" : "",
  };
}

function credentialFor(
  draft: SpeechSettingsDraft,
  current: DictationSettings | NarrationSettings | null,
): string {
  const credential =
    draft.credential.trim() || (current?.provider === draft.provider ? current.credential : "");
  if (!credential) throw new Error("Enter credentials before enabling this provider.");
  return credential;
}

export function dictationSettingsFromDraft(
  draft: SpeechSettingsDraft,
  current: DictationSettings | null,
): DictationSettings | null {
  if (draft.provider === "disabled") return null;
  if (draft.provider === "elevenlabs")
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
