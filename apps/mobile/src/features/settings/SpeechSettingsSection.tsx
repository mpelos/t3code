import type { StaticScreenProps } from "@react-navigation/native";
import { SettingsScreen } from "./components/SettingsScreen";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { useState } from "react";
import { View, Pressable } from "react-native";
import {
  QWEN_NARRATION_VOICES,
  QWEN_NARRATION_LANGUAGES,
  type EnvironmentId,
  type SpeechSettings,
} from "@t3tools/contracts";
import {
  speechProviderOptions,
  speechSettingsDraft,
  selectSpeechProvider,
  dictationSettingsFromDraft,
  narrationSettingsFromDraft,
} from "@t3tools/client-runtime/voice-input";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { speechEnvironment, speechContextAtom } from "../../state/speech";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Menu } from "../../components/ui/Menu";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "./components/SettingsSection";

export function SpeechSettingsRouteScreen({
  route,
}: StaticScreenProps<{ role?: "dictation" | "narration" }>) {
  return (
    <SettingsScreen title="Speech">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4 pb-6"
      >
        <SpeechSettingsSection role={route.params?.role} />
      </ScreenScrollView>
    </SettingsScreen>
  );
}

export function SpeechSettingsSection({ role }: { readonly role?: "dictation" | "narration" }) {
  const speech = useAtomValue(speechContextAtom);
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const environment = connectedEnvironments.find(
    (candidate) => candidate.environmentId === speech.environmentId,
  );
  const config = useAtomValue(serverEnvironment.configValueAtom(speech.environmentId))?.settings
    .speech;
  return (
    <SettingsSection
      title="Speech"
      footer="Use the selected environment for dictation and read aloud in every chat on this device. Credentials stay on that environment."
    >
      <Menu
        actions={connectedEnvironments.map((candidate) => ({
          id: candidate.environmentId,
          title: candidate.environmentLabel,
        }))}
        onPressAction={({ nativeEvent }) => {
          const next = connectedEnvironments.find(
            (candidate) => candidate.environmentId === nativeEvent.event,
          );
          if (next) savePreferences({ speechEnvironmentId: next.environmentId });
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Speech environment"
          className="min-h-14 flex-row items-center justify-between gap-3 px-4 py-3"
        >
          <Text className="text-base text-foreground">Speech environment</Text>
          <Text className="shrink text-sm text-foreground-muted">
            {environment?.environmentLabel ?? "Choose an environment"}
          </Text>
        </Pressable>
      </Menu>
      {environment?.connectionState === "connected" && config ? (
        <View key={speech.environmentId}>
          {role !== "narration" ? (
            <SpeechForm
              key={`dictation:${config.dictation?.provider}`}
              environmentId={environment.environmentId}
              config={config}
              role="dictation"
            />
          ) : null}
          {role !== "dictation" ? (
            <SpeechForm
              key={`narration:${config.narration?.provider}`}
              environmentId={environment.environmentId}
              config={config}
              role="narration"
            />
          ) : null}
        </View>
      ) : (
        <Text className="p-4 text-sm text-foreground-muted">
          {speech.environmentId
            ? "Connect the selected environment to configure Speech."
            : "Choose a connected environment to configure Speech."}
        </Text>
      )}
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
  function field(name: "credential" | "language" | "voice" | "baseUrl", placeholder: string) {
    return (
      <AppTextInput
        accessibilityLabel={name === "baseUrl" ? "Local voice server URL" : `${label} ${name}`}
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
        placeholder={placeholder}
        value={draft[name]}
        onChangeText={(value) => changeDraft({ ...draft, [name]: value })}
        editable={!disabled}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={name === "credential"}
      />
    );
  }
  function choice(name: "language" | "voice", values: readonly string[]) {
    return (
      <View pointerEvents={disabled ? "none" : "auto"}>
        <Menu
          actions={values.map((value) => ({ id: value, title: value }))}
          onPressAction={({ nativeEvent }) => changeDraft({ ...draft, [name]: nativeEvent.event })}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${label} ${name}`}
            disabled={disabled}
            className="min-h-12 flex-row items-center justify-between rounded-lg border border-border-subtle px-3 py-2"
          >
            <Text className="text-foreground-muted">{name === "voice" ? "Voice" : "Language"}</Text>
            <Text className="text-foreground">{draft[name]}</Text>
          </Pressable>
        </Menu>
      </View>
    );
  }
  return (
    <View className="gap-3 p-4">
      <Text className="font-t3-medium text-base text-foreground">{label}</Text>
      <View pointerEvents={disabled ? "none" : "auto"}>
        <Menu
          actions={speechProviderOptions(role).map((option) => ({
            id: option.value,
            title: option.label,
          }))}
          onPressAction={({ nativeEvent }) => {
            const provider = speechProviderOptions(role).find(
              (option) => option.value === nativeEvent.event,
            );
            if (provider) changeDraft(selectSpeechProvider(draft, provider.value));
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${label} provider`}
            disabled={disabled}
            className="min-h-12 flex-row items-center justify-between rounded-lg border border-border-subtle px-3 py-2"
          >
            <Text className="text-foreground-muted">Provider</Text>
            <Text className="text-foreground">
              {speechProviderOptions(role).find((option) => option.value === draft.provider)?.label}
            </Text>
          </Pressable>
        </Menu>
      </View>
      {draft.provider !== "disabled" ? (
        <>
          {draft.provider !== "qwen"
            ? field(
                "credential",
                current?.provider === draft.provider &&
                  "credential" in current &&
                  current.credential
                  ? "Stored credential; enter to replace"
                  : draft.provider === "google"
                    ? "Service account JSON"
                    : "API key",
              )
            : null}
          {draft.provider === "google" ? (
            <Text className="text-sm text-foreground-muted">
              Paste a service account JSON key with access to{" "}
              {role === "dictation" ? "Speech-to-Text v2" : "Text-to-Speech"}. Enable the API and
              billing in its project.
            </Text>
          ) : null}
          {draft.provider === "qwen" ? (
            <>
              {field("baseUrl", "Local server URL (on the Speech environment)")}
              <Text className="text-sm text-foreground-muted">
                Run Qwen3-TTS with MLX Audio on the selected Speech environment. Audio is generated
                there and sent to this device.
              </Text>
              {choice("language", QWEN_NARRATION_LANGUAGES)}
              {choice("voice", QWEN_NARRATION_VOICES)}
            </>
          ) : null}
          {role === "dictation" || draft.provider === "google"
            ? field("language", "Language code (pt-BR)")
            : null}
          {role === "narration" && draft.provider !== "qwen"
            ? field("voice", draft.provider === "elevenlabs" ? "ElevenLabs voice ID" : "Voice name")
            : null}
          {role === "dictation" && draft.provider === "google" ? (
            <Text className="text-sm text-foreground-muted">Up to 60 seconds per dictation.</Text>
          ) : null}
        </>
      ) : null}
      {draft.provider !== "disabled" ? (
        <Text className="text-sm text-foreground-muted">
          {draft.provider === "qwen"
            ? "Saving generates a short audio sample on the selected environment to verify the local model."
            : "Saving tests your credentials with a short request to the selected provider and may use credits."}
        </Text>
      ) : null}
      {!allowed ? (
        <Text className="text-sm text-foreground-muted">
          You need settings access to update this environment's speech configuration.
        </Text>
      ) : null}
      {saved ? (
        <Text accessibilityRole="alert">
          {draft.provider === "disabled"
            ? "Disabled."
            : draft.provider === "qwen"
              ? "Local narration verified and saved."
              : "Credentials verified and saved."}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <Button
        label={`${draft.provider === "disabled" ? "Save" : "Validate and save"} ${label.toLowerCase()}`}
        disabled={disabled}
        loading={pending}
        onPress={() => void save()}
      />
    </View>
  );
}
