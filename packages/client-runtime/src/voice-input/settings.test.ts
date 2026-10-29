import { expect, it } from "vite-plus/test";
import { DEFAULT_QWEN_NARRATION_URL, SpeechError, isNarrationConfigured } from "@t3tools/contracts";
import {
  dictationSettingsFromDraft,
  narrationSettingsFromDraft,
  selectSpeechProvider,
  speechProviderOptions,
  speechSettingsDraft,
  speechErrorRequiresConfiguration,
} from "./settings.ts";

it("builds and restores local narration without credentials while keeping it out of dictation", () => {
  const draft = selectSpeechProvider(speechSettingsDraft(null), "qwen");
  const config = narrationSettingsFromDraft(draft, null);
  expect(config).toEqual({
    provider: "qwen",
    baseUrl: DEFAULT_QWEN_NARRATION_URL,
    voice: "Ryan",
    language: "Portuguese",
  });
  expect(isNarrationConfigured(config)).toBe(true);
  expect(isNarrationConfigured(null)).toBe(false);
  expect(isNarrationConfigured({ provider: "openai", credential: "", voice: "coral" })).toBe(false);
  expect(speechSettingsDraft(config)).toEqual(draft);
  expect(speechProviderOptions("dictation").map(({ value }) => value)).not.toContain("qwen");
  expect(() => dictationSettingsFromDraft(draft, null)).toThrow("Choose OpenAI or Google Cloud");
  expect(narrationSettingsFromDraft(selectSpeechProvider(draft, "disabled"), config)).toBeNull();
});

it("requires a Fish voice and credentials, reuses only its stored key, and allows disabling", () => {
  const draft = selectSpeechProvider(speechSettingsDraft(null), "fish");
  expect(speechProviderOptions("narration").map(({ value }) => value)).toContain("fish");
  expect(speechProviderOptions("dictation").map(({ value }) => value)).not.toContain("fish");
  expect(() => dictationSettingsFromDraft(draft, null)).toThrow("Choose OpenAI or Google Cloud");
  expect(() => narrationSettingsFromDraft(draft, null)).toThrow("Enter credentials");
  expect(() => narrationSettingsFromDraft({ ...draft, credential: "key" }, null)).toThrow(
    "Enter a voice",
  );
  const config = narrationSettingsFromDraft(
    { ...draft, credential: " key ", voice: " voice-id " },
    null,
  );
  expect(config).toEqual({
    provider: "fish",
    credential: "key",
    voice: "voice-id",
    model: "s2.1-pro-free",
  });
  expect(isNarrationConfigured(config)).toBe(true);
  const restored = speechSettingsDraft(config);
  expect(restored.credential).toBe("");
  expect(narrationSettingsFromDraft(restored, config)).toEqual(config);
  const paid = narrationSettingsFromDraft({ ...restored, fishModel: "s2.1-pro" }, config);
  expect(paid).toMatchObject({ provider: "fish", model: "s2.1-pro", credential: "key" });
  expect(speechSettingsDraft(paid).fishModel).toBe("s2.1-pro");
  expect(() =>
    narrationSettingsFromDraft(restored, {
      provider: "elevenlabs",
      credential: "other-key",
      voice: "other-voice",
    }),
  ).toThrow("Enter credentials");
  expect(narrationSettingsFromDraft(selectSpeechProvider(restored, "disabled"), config)).toBeNull();
  expect(
    speechErrorRequiresConfiguration(
      new SpeechError({ provider: "fish", reason: "invalid-credential" }),
    ),
  ).toBe(true);
});

it.each([
  "file:///tmp/model",
  "http://key:secret@localhost:18320",
  "http://localhost:18320?token=secret",
  "not a URL",
])("rejects invalid local endpoint %s", (baseUrl) => {
  const draft = selectSpeechProvider(speechSettingsDraft(null), "qwen");
  expect(() => narrationSettingsFromDraft({ ...draft, baseUrl }, null)).toThrow();
});

it.each(["unavailable", "invalid-response", "rejected"] as const)(
  "offers local setup recovery for %s",
  (reason) => {
    const error = new SpeechError({ provider: "qwen", role: "narration", reason });
    expect(speechErrorRequiresConfiguration(error)).toBe(true);
    expect(error.message).toContain("local voice server");
    expect(error.message).not.toMatch(/API key|billing|credits/);
  },
);
