import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import {
  QWEN_NARRATION_VOICES,
  QWEN_NARRATION_LANGUAGES,
  type EnvironmentId,
  type SpeechSettings as SpeechConfig,
} from "@t3tools/contracts";
import {
  speechProviderOptions,
  fishNarrationModelOptions,
  speechSettingsDraft,
  selectSpeechProvider,
  dictationSettingsFromDraft,
  narrationSettingsFromDraft,
  type SpeechProvider,
} from "@t3tools/client-runtime/voice-input";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "~/state/use-atom-command";
import { speechEnvironment, speechContextAtom, selectSpeechEnvironment } from "~/state/speech";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useEnvironments } from "~/state/environments";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { searchableSetting } from "./settingsSearch";

export function SpeechSettings() {
  const { environments } = useEnvironments();
  const { environmentId } = useAtomValue(speechContextAtom);
  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  const options = environments.map((candidate) => ({
    value: candidate.environmentId,
    label: settingsScopeEnvironmentLabel(candidate, environments),
  }));
  const connected = environment?.connection.phase === "connected";
  return (
    <SettingsSection {...searchableSetting("speech")}>
      <SettingsRow
        title="Speech environment"
        description="Use this environment for dictation and read aloud in every chat on this device. Credentials stay on this environment."
        control={
          <Select
            items={options}
            value={environment?.environmentId ?? null}
            onValueChange={(next) => {
              if (next !== null) void selectSpeechEnvironment(next);
            }}
            disabled={options.length === 0}
          >
            <SelectTrigger aria-label="Speech environment">
              <SelectValue placeholder="Choose an environment" />
            </SelectTrigger>
            <SelectPopup>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {connected && environment.serverConfig ? (
        <SpeechForms
          key={environment.environmentId}
          environmentId={environment.environmentId}
          config={environment.serverConfig.settings.speech}
        />
      ) : (
        <SettingsRow
          title={
            connected
              ? "Loading speech settings…"
              : environment
                ? `Connect to ${environment.label} to configure speech`
                : "Connect an environment to configure speech"
          }
          description={
            connected
              ? "Waiting for the environment's configuration."
              : "Open Settings → Connections to connect the environment running your chats."
          }
        />
      )}
    </SettingsSection>
  );
}

function SpeechForms({
  environmentId,
  config,
}: {
  readonly environmentId: EnvironmentId;
  readonly config: SpeechConfig;
}) {
  return (
    <>
      <p className="px-4 py-2 text-sm text-muted-foreground">
        Cloud providers receive your recordings or response text. Local narration runs on the
        selected Speech environment.
      </p>
      <SpeechForm
        key={`dictation:${config.dictation?.provider}`}
        environmentId={environmentId}
        config={config}
        role="dictation"
      />
      <SpeechForm
        key={`narration:${config.narration?.provider}`}
        environmentId={environmentId}
        config={config}
        role="narration"
      />
    </>
  );
}

function SpeechForm({
  environmentId,
  config,
  role,
}: {
  readonly environmentId: EnvironmentId;
  readonly config: SpeechConfig;
  readonly role: "dictation" | "narration";
}) {
  const current = config[role];
  const [draft, setDraft] = useState(() => speechSettingsDraft(current));
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = useAtomValue(speechEnvironment.configure.permissionAtom(environmentId));
  const update = useAtomCommand(speechEnvironment.configure, { reportFailure: false });
  const label = role === "dictation" ? "Dictation" : "Read aloud";
  const disabled = !allowed || pending;
  function changeDraft(next: typeof draft) {
    setSaved(false);
    setError(null);
    setDraft(next);
  }
  async function save() {
    setError(null);
    setSaved(false);
    setPending(true);
    const built = await settlePromise(async () =>
      role === "dictation"
        ? {
            role: "dictation" as const,
            config: dictationSettingsFromDraft(draft, config.dictation),
          }
        : {
            role: "narration" as const,
            config: narrationSettingsFromDraft(draft, config.narration),
          },
    );
    const result =
      built._tag === "Failure" ? built : await update({ environmentId, input: built.value });
    setPending(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not save speech settings.");
    } else {
      setDraft({ ...draft, credential: "" });
      setSaved(true);
    }
  }
  return (
    <SettingsRow
      id={`speech-${role}`}
      title={label}
      description={
        role === "dictation"
          ? "Transcribe your microphone into an editable draft."
          : "Listen to the agent's responses."
      }
    >
      <div className="flex max-w-xl flex-col gap-3 py-3">
        <Select
          items={speechProviderOptions(role)}
          value={draft.provider}
          onValueChange={(provider: SpeechProvider | null) => {
            if (provider) changeDraft(selectSpeechProvider(draft, provider));
          }}
          disabled={disabled}
        >
          <SelectTrigger aria-label={`${label} provider`}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {speechProviderOptions(role).map((provider) => (
              <SelectItem key={provider.value} value={provider.value}>
                {provider.label}
                {role === "dictation" && provider.value === "openai" ? " Whisper" : ""}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {draft.provider !== "disabled" ? (
          <>
            {draft.provider !== "qwen" ? (
              <SecretInput
                aria-label={`${label} credentials`}
                configured={Boolean(
                  current?.provider === draft.provider &&
                  "credential" in current &&
                  current.credential,
                )}
                value={draft.credential}
                placeholder={draft.provider === "google" ? "Service account JSON" : "API key"}
                disabled={disabled}
                onChange={(event) => changeDraft({ ...draft, credential: event.target.value })}
              />
            ) : null}
            {draft.provider === "google" ? (
              <p className="text-xs text-muted-foreground">
                Paste a Google Cloud service account JSON key with access to{" "}
                {role === "dictation" ? "Speech-to-Text v2" : "Text-to-Speech"}. Enable the
                corresponding API and billing in its project.
              </p>
            ) : null}
            {draft.provider === "qwen" ? (
              <>
                <Input
                  aria-label="Local voice server URL"
                  placeholder="http://127.0.0.1:18320"
                  value={draft.baseUrl}
                  disabled={disabled}
                  onChange={(event) => changeDraft({ ...draft, baseUrl: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Run Qwen3-TTS with MLX Audio on the selected Speech environment. This address
                  belongs to that environment, including when using mobile.
                </p>
                <Select
                  items={QWEN_NARRATION_LANGUAGES.map((value) => ({ value, label: value }))}
                  value={draft.language}
                  disabled={disabled}
                  onValueChange={(language) => {
                    if (language) changeDraft({ ...draft, language });
                  }}
                >
                  <SelectTrigger aria-label="Read aloud language">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {QWEN_NARRATION_LANGUAGES.map((language) => (
                      <SelectItem key={language} value={language}>
                        {language}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Select
                  items={QWEN_NARRATION_VOICES.map((value) => ({ value, label: value }))}
                  value={draft.voice}
                  disabled={disabled}
                  onValueChange={(voice) => {
                    if (voice) changeDraft({ ...draft, voice });
                  }}
                >
                  <SelectTrigger aria-label="Narration voice">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {QWEN_NARRATION_VOICES.map((voice) => (
                      <SelectItem key={voice} value={voice}>
                        {voice}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </>
            ) : null}
            {role === "dictation" || draft.provider === "google" ? (
              <Input
                aria-label={`${label} language`}
                placeholder="Language code (pt-BR)"
                value={draft.language}
                disabled={disabled}
                onChange={(event) => changeDraft({ ...draft, language: event.target.value })}
              />
            ) : null}
            {role === "narration" && draft.provider !== "qwen" ? (
              <Input
                aria-label="Narration voice"
                placeholder={
                  draft.provider === "fish"
                    ? "Fish Audio voice ID (reference_id)"
                    : draft.provider === "elevenlabs"
                      ? "ElevenLabs voice ID"
                      : "Voice name"
                }
                value={draft.voice}
                disabled={disabled}
                onChange={(event) => changeDraft({ ...draft, voice: event.target.value })}
              />
            ) : null}
            {draft.provider === "fish" ? (
              <>
                <Select
                  items={fishNarrationModelOptions}
                  value={draft.fishModel}
                  disabled={disabled}
                  onValueChange={(model: typeof draft.fishModel | null) => {
                    if (model) changeDraft({ ...draft, fishModel: model });
                  }}
                >
                  <SelectTrigger aria-label="Read aloud model">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {fishNarrationModelOptions.map(({ value, label }) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Copy the voice ID from a voice on fish.audio. Language is detected automatically.
                  {draft.fishModel === "s2.1-pro"
                    ? " The paid model requires API credit in Fish Audio."
                    : " The free model is subject to Fish Audio usage limits."}
                </p>
              </>
            ) : null}
            {role === "dictation" && draft.provider === "google" ? (
              <p className="text-xs text-muted-foreground">
                Google recordings are limited to 60 seconds per dictation.
              </p>
            ) : null}
          </>
        ) : null}
        {draft.provider !== "disabled" ? (
          <p className="text-xs text-muted-foreground">
            {draft.provider === "qwen"
              ? "Saving generates a short audio sample on the selected environment to verify the local model."
              : "Saving tests your credentials with a short request to the selected provider and may use credits."}
          </p>
        ) : null}
        {!allowed ? (
          <p className="text-sm text-muted-foreground">
            You need settings access to update this environment's speech configuration.
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="text-sm text-muted-foreground">
            {draft.provider === "disabled"
              ? "Disabled."
              : draft.provider === "qwen"
                ? "Local narration verified and saved."
                : "Credentials verified and saved."}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {error}
          </p>
        ) : null}
        <div>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => void save()}>
            {pending
              ? "Saving…"
              : `${draft.provider === "disabled" ? "Save" : "Validate and save"} ${label.toLowerCase()}`}
          </Button>
        </div>
      </div>
    </SettingsRow>
  );
}
