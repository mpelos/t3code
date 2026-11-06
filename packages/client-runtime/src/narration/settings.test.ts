import { expect, it } from "vite-plus/test";
import { DEFAULT_QWEN_NARRATION_URL, SpeechError, isNarrationConfigured } from "@t3tools/contracts";
import {
  narrationSettingsFromDraft,
  selectNarrationProvider,
  narrationProviderOptions,
  narrationSettingsDraft,
  narrationErrorRequiresConfiguration,
} from "./settings.ts";

it("builds and restores local narration without credentials", () => {
  const draft = selectNarrationProvider(narrationSettingsDraft(null), "qwen");
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
  expect(narrationSettingsDraft(config)).toEqual(draft);
  expect(narrationSettingsFromDraft(selectNarrationProvider(draft, "disabled"), config)).toBeNull();
});

it("requires a Fish voice and credentials, reuses only its stored key, and allows disabling", () => {
  const draft = selectNarrationProvider(narrationSettingsDraft(null), "fish");
  expect(narrationProviderOptions.map(({ value }) => value)).toContain("fish");
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
  const restored = narrationSettingsDraft(config);
  expect(restored.credential).toBe("");
  expect(narrationSettingsFromDraft(restored, config)).toEqual(config);
  const paid = narrationSettingsFromDraft({ ...restored, fishModel: "s2.1-pro" }, config);
  expect(paid).toMatchObject({ provider: "fish", model: "s2.1-pro", credential: "key" });
  expect(narrationSettingsDraft(paid).fishModel).toBe("s2.1-pro");
  expect(() =>
    narrationSettingsFromDraft(restored, {
      provider: "elevenlabs",
      credential: "other-key",
      voice: "other-voice",
    }),
  ).toThrow("Enter credentials");
  expect(
    narrationSettingsFromDraft(selectNarrationProvider(restored, "disabled"), config),
  ).toBeNull();
  expect(
    narrationErrorRequiresConfiguration(
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
  const draft = selectNarrationProvider(narrationSettingsDraft(null), "qwen");
  expect(() => narrationSettingsFromDraft({ ...draft, baseUrl }, null)).toThrow();
});

it.each(["unavailable", "invalid-response", "rejected"] as const)(
  "offers local setup recovery for %s",
  (reason) => {
    const error = new SpeechError({ provider: "qwen", role: "narration", reason });
    expect(narrationErrorRequiresConfiguration(error)).toBe(true);
    expect(error.message).toContain("local voice server");
    expect(error.message).not.toMatch(/API key|billing|credits/);
  },
);
