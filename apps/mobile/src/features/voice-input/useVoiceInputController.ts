import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId } from "@t3tools/contracts";
import { speechContextAtom } from "../../state/speech";
import { useNavigation } from "@react-navigation/native";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { useGlobalVoiceInput } from "./VoiceInputProvider";
import { createVoiceInputTarget } from "./voiceInputSession";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export function useVoiceInputController(input: {
  readonly environmentId: EnvironmentId | null;
  readonly ownerKey: string | null;
  readonly label: string;
  readonly readDraftMessage: () => string | null;
  readonly subscribeToDraftChanges: (onChange: () => void) => () => void;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
}) {
  const navigation = useNavigation();
  const global = useGlobalVoiceInput();
  const speech = useAtomValue(speechContextAtom);
  const allowed = speech.canOperate;
  const { session } = global;
  const latestInput = useRef(input);
  // oxlint-disable-next-line react/refs -- Transcription finishes asynchronously and must reach the composer's current selection setter, not the one captured at start.
  latestInput.current = input;
  const mounted = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks mount so async transcription results skip a composer that has unmounted
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      const ownerKey = input.ownerKey;
      if (!ownerKey) return;
      session.setOwnerFocused(ownerKey, true);
      return () => session.setOwnerFocused(ownerKey, false);
    }, [input.ownerKey, session]),
  );

  const start = useCallback(() => {
    const captured = latestInput.current;
    if (!captured.environmentId || !captured.ownerKey || captured.disabled || !allowed) return;
    void session.start({
      ...createVoiceInputTarget(
        captured.environmentId,
        captured.ownerKey,
        captured.readDraftMessage,
        (text, selection) => {
          captured.onChangeDraftMessage(text);
          if (mounted.current && latestInput.current.ownerKey === captured.ownerKey) {
            latestInput.current.onChangeSelection(selection);
          }
        },
        captured.selection,
        captured.subscribeToDraftChanges,
      ),
      label: captured.label,
    });
  }, [session, allowed]);
  const state = global.ownerKey === input.ownerKey ? global.state : IDLE_STATE;
  const isBusy = voiceInputBlocksSubmission(state);
  return {
    isAvailable:
      input.environmentId !== null &&
      input.ownerKey !== null &&
      Boolean(speech.dictation?.credential && allowed) &&
      (!global.isBusy || global.ownerKey === input.ownerKey),
    state,
    openSpeechSettings: () => {
      session.cancel(input.ownerKey);
      navigation.navigate("SettingsSpeech", { role: "dictation" });
    },
    audioLevels: global.audioLevels,
    elapsedSeconds: global.elapsedSeconds,
    isBusy,
    freezesEditor: isBusy,
    blocksSubmission: isBusy,
    start,
    stop: global.stop,
    cancel: global.cancel,
  };
}
