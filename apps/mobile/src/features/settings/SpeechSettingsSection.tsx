import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { View } from "react-native";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type SpeechSettings,
} from "@t3tools/contracts";
import {
  SPEECH_PROVIDERS,
  speechSettingsDraft,
  selectSpeechProvider,
  dictationSettingsFromDraft,
  narrationSettingsFromDraft,
} from "@t3tools/client-runtime/voice-input";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentScope } from "../../state/session";
import { SettingsSection } from "./components/SettingsSection";

export function SpeechSettingsSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.settings.speech;
  if (!config) return null;
  return (
    <SettingsSection
      title="Speech"
      footer="Recordings and response text are sent to your selected provider. Narration uses an AI-generated voice."
    >
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
    </SettingsSection>
  );
}

function SpeechForm({
  environmentId,
  config,
  role,
}: {
  readonly environmentId: EnvironmentId;
  readonly config: SpeechSettings;
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
  function field(name: "credential" | "language" | "voice", placeholder: string) {
    return (
      <AppTextInput
        accessibilityLabel={`${label} ${name}`}
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
        placeholder={placeholder}
        value={draft[name]}
        onChangeText={(value) => setDraft({ ...draft, [name]: value })}
        editable={!disabled}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={name === "credential"}
      />
    );
  }
  return (
    <View className="gap-3 p-4">
      <Text className="font-t3-medium text-base text-foreground">{label}</Text>
      <View pointerEvents={disabled ? "none" : "auto"}>
        <SegmentedControl
          selected={draft.provider}
          options={SPEECH_PROVIDERS.filter(
            (option) => role === "narration" || option.value !== "elevenlabs",
          )}
          onSelect={(provider) => setDraft(selectSpeechProvider(draft, provider))}
        />
      </View>
      {draft.provider !== "disabled" ? (
        <>
          {field(
            "credential",
            current?.provider === draft.provider && current.credential
              ? "Stored credential; enter to replace"
              : draft.provider === "google"
                ? "Service account JSON"
                : "API key",
          )}
          {draft.provider === "google" ? (
            <Text className="text-sm text-foreground-muted">
              Paste a service account JSON key with access to{" "}
              {role === "dictation" ? "Speech-to-Text v2" : "Text-to-Speech"}. Enable the API and
              billing in its project.
            </Text>
          ) : null}
          {role === "dictation" || draft.provider === "google"
            ? field("language", "Language code (pt-BR)")
            : null}
          {role === "narration"
            ? field("voice", draft.provider === "elevenlabs" ? "ElevenLabs voice ID" : "Voice name")
            : null}
          {role === "dictation" && draft.provider === "google" ? (
            <Text className="text-sm text-foreground-muted">Up to 60 seconds per dictation.</Text>
          ) : null}
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <Button
        label={`Save ${label.toLowerCase()}`}
        disabled={disabled}
        loading={pending}
        onPress={() => void save()}
      />
    </View>
  );
}
