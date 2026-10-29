import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toastManager } from "../ui/toast";
import { useAtomValue } from "@effect/atom-react";
import {
  VoiceInputController,
  voiceTranscriptionFailure,
  throwIfVoiceTranscriptionAborted,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useStableCallback } from "~/hooks/useStableCallback";
import { speechEnvironment, speechContextAtom } from "~/state/speech";
import { useAtomCommand } from "~/state/use-atom-command";
import { WebVoiceRecorder } from "./webVoiceRecorder";

export function useWebDictation(input: {
  readonly ownerKey: string;
  readonly readDraft: () => VoiceDraftSnapshot;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
}) {
  const navigate = useNavigate();
  const speech = useAtomValue(speechContextAtom);
  const speechEnvironmentId = speech.environmentId;
  const config = speech.dictation;
  const allowed = speech.canOperate;
  const transcribe = useAtomCommand(speechEnvironment.transcribe, { reportFailure: false });
  const [state, setState] = useState<VoiceInputState>({
    phase: "idle",
    error: null,
    errorAction: null,
  });
  const readDraft = useStableCallback(input.readDraft);
  const commitDraft = useStableCallback(input.commitDraft);
  const getTranscriber = useStableCallback((read: WebVoiceRecorder["read"]) =>
    !config?.credential || !allowed || speechEnvironmentId === null
      ? null
      : {
          prepare: async () => ({
            locale: config.language,
            maxRecordingSeconds: config.provider === "google" ? 60 : 300,
            transcribe: async (uri: string, { signal }: { readonly signal: AbortSignal }) => {
              throwIfVoiceTranscriptionAborted(signal);
              const recording = await read(uri);
              if (!recording) throw new Error("The recording is no longer available.");
              const result = await transcribe({
                environmentId: speechEnvironmentId,
                input: {
                  audio: new Uint8Array(await recording.blob.arrayBuffer()),
                  format: recording.format,
                  signal,
                },
              });
              if (result._tag === "Failure") {
                const cause = squashAtomCommandFailure(result);
                throw voiceTranscriptionFailure(cause);
              }
              return result.value.text;
            },
          }),
        },
  );
  const [{ controller, recorder }] = useState(() => {
    const recorder = new WebVoiceRecorder((status) => {
      void controller.handleRecorderStatus(status);
    });
    const controller = new VoiceInputController({
      recorder,
      getTranscriber: () => getTranscriber((uri) => recorder.read(uri)),
      readDraft,
      commitDraft,
      onStateChange: setState,
      requestPermission: () => recorder.requestPermission(),
      configureRecording: async () => {},
      releaseRecording: () => recorder.release(),
      deleteRecording: (uri) => recorder.delete(uri),
    });
    return { controller, recorder };
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns microphone and network cleanup when the draft, environment, or configured provider changes
  useEffect(() => {
    if (
      speechEnvironmentId === null ||
      !config?.credential ||
      !allowed ||
      readDraft().ownerKey !== input.ownerKey
    )
      controller.cancel();
    return () => controller.dispose();
  }, [controller, input.ownerKey, speechEnvironmentId, config, allowed, readDraft]);
  return {
    state,
    canOpenMicrophoneSettings: window.desktopBridge?.getClientPlatform() === "darwin",
    openMicrophoneSettings: async () => {
      controller.cancel();
      try {
        const opened = await window.desktopBridge?.openSystemSettings("microphone");
        if (!opened) throw new Error("Could not open microphone settings.");
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not open microphone settings",
          description: error instanceof Error ? error.message : "Open System Settings manually.",
        });
      }
    },
    openSettings: () => {
      controller.cancel();
      void navigate({
        to: "/settings/general",
        search: {},
        hash: "speech-dictation",
      });
    },
    recorder,
    isBusy: voiceInputBlocksSubmission(state),
    available: Boolean(
      config?.credential &&
      allowed &&
      typeof MediaRecorder !== "undefined" &&
      navigator.mediaDevices?.getUserMedia,
    ),
    start: () => {
      void controller.start();
    },
    stop: () => {
      void controller.stop();
    },
    cancel: () => controller.cancel(),
  };
}
