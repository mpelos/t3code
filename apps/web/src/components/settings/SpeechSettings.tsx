import { useState } from "react";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type SpeechSettings as SpeechConfig,
} from "@t3tools/contracts";
import {
  SPEECH_PROVIDERS,
  speechSettingsDraft,
  selectSpeechProvider,
  dictationSettingsFromDraft,
  narrationSettingsFromDraft,
  type SpeechProvider,
} from "@t3tools/client-runtime/voice-input";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentScope } from "~/state/session";
import { serverEnvironment } from "~/state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { searchableSetting } from "./settingsSearch";

export function SpeechSettings() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const environment =
    selectedEnvironmentId !== null
      ? environments.find((candidate) => candidate.environmentId === selectedEnvironmentId)
      : (environments.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
        environments.find((candidate) => candidate.connection.phase === "connected") ??
        environments[0]);
  const options = environments.map((candidate) => ({
    value: candidate.environmentId,
    label: settingsScopeEnvironmentLabel(candidate, environments),
  }));
  const connected = environment?.connection.phase === "connected";
  return (
    <SettingsSection {...searchableSetting("speech")}>
      <SettingsRow
        title="Environment"
        description="Speech credentials are stored on this environment and used by its chats."
        control={
          <Select
            items={options}
            value={environment?.environmentId ?? null}
            onValueChange={(next) => {
              if (next !== null) setSelectedEnvironmentId(next);
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
        Recordings and response text are sent to your selected provider. Narration uses an
        AI-generated voice.
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
  const [error, setError] = useState<string | null>(null);
  const allowed = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const label = role === "dictation" ? "Dictation" : "Read aloud";
  const disabled = !allowed || pending;
  async function save() {
    setError(null);
    setPending(true);
    const built = await settlePromise(async () =>
      role === "dictation"
        ? { dictation: dictationSettingsFromDraft(draft, config.dictation) }
        : { narration: narrationSettingsFromDraft(draft, config.narration) },
    );
    const result =
      built._tag === "Failure"
        ? built
        : await update({ environmentId, input: { patch: { speech: built.value } } });
    setPending(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not save speech settings.");
    } else setDraft({ ...draft, credential: "" });
  }
  return (
    <SettingsRow
      title={label}
      description={
        role === "dictation"
          ? "Transcribe your microphone into an editable draft."
          : "Listen to the agent's responses."
      }
    >
      <div className="flex max-w-xl flex-col gap-3 py-3">
        <Select
          items={SPEECH_PROVIDERS.filter(
            (provider) => role === "narration" || provider.value !== "elevenlabs",
          )}
          value={draft.provider}
          onValueChange={(provider: SpeechProvider | null) => {
            if (provider) setDraft(selectSpeechProvider(draft, provider));
          }}
          disabled={disabled}
        >
          <SelectTrigger aria-label={`${label} provider`}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {SPEECH_PROVIDERS.filter(
              (provider) => role === "narration" || provider.value !== "elevenlabs",
            ).map((provider) => (
              <SelectItem key={provider.value} value={provider.value}>
                {provider.label}
                {role === "dictation" && provider.value === "openai" ? " Whisper" : ""}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {draft.provider !== "disabled" ? (
          <>
            <SecretInput
              aria-label={`${label} credentials`}
              configured={Boolean(current?.provider === draft.provider && current.credential)}
              value={draft.credential}
              placeholder={draft.provider === "google" ? "Service account JSON" : "API key"}
              disabled={disabled}
              onChange={(event) => setDraft({ ...draft, credential: event.target.value })}
            />
            {draft.provider === "google" ? (
              <p className="text-xs text-muted-foreground">
                Paste a Google Cloud service account JSON key with access to{" "}
                {role === "dictation" ? "Speech-to-Text v2" : "Text-to-Speech"}. Enable the
                corresponding API and billing in its project.
              </p>
            ) : null}
            {role === "dictation" || draft.provider === "google" ? (
              <Input
                aria-label={`${label} language`}
                placeholder="Language code (pt-BR)"
                value={draft.language}
                disabled={disabled}
                onChange={(event) => setDraft({ ...draft, language: event.target.value })}
              />
            ) : null}
            {role === "narration" ? (
              <Input
                aria-label="Narration voice"
                placeholder={draft.provider === "elevenlabs" ? "ElevenLabs voice ID" : "Voice name"}
                value={draft.voice}
                disabled={disabled}
                onChange={(event) => setDraft({ ...draft, voice: event.target.value })}
              />
            ) : null}
            {role === "dictation" && draft.provider === "google" ? (
              <p className="text-xs text-muted-foreground">
                Google recordings are limited to 60 seconds per dictation.
              </p>
            ) : null}
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {error}
          </p>
        ) : null}
        <div>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => void save()}>
            {pending ? "Saving…" : `Save ${label.toLowerCase()}`}
          </Button>
        </div>
      </div>
    </SettingsRow>
  );
}
