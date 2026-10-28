import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import {
  VoiceInputController,
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useStableCallback } from "~/hooks/useStableCallback";
import { serverEnvironment } from "~/state/server";
import { speechEnvironment } from "~/state/speech";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentScope } from "~/state/session";
import { WebVoiceRecorder } from "./webVoiceRecorder";

export function useWebDictation(input: {
  readonly environmentId: EnvironmentId;
  readonly ownerKey: string;
  readonly readDraft: () => VoiceDraftSnapshot;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(input.environmentId))?.settings
    .speech.dictation;
  const allowed = useEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
  const transcribe = useAtomCommand(speechEnvironment.transcribe, { reportFailure: false });
  const [state, setState] = useState<VoiceInputState>({
    phase: "idle",
    error: null,
    errorAction: null,
  });
  const readDraft = useStableCallback(input.readDraft);
  const commitDraft = useStableCallback(input.commitDraft);
  const getTranscriber = useStableCallback((read: WebVoiceRecorder["read"]) =>
    !config?.credential || !allowed
      ? null
      : {
          prepare: async () => ({
            locale: config.language,
            maxRecordingSeconds: config.provider === "google" ? 60 : 300,
            transcribe: async (uri: string, { signal }: { readonly signal: AbortSignal }) => {
              throwIfVoiceTranscriptionAborted(signal);
              const recording = read(uri);
              if (!recording) throw new Error("The recording is no longer available.");
              const result = await transcribe({
                environmentId: input.environmentId,
                input: {
                  audio: new Uint8Array(await recording.blob.arrayBuffer()),
                  format: recording.format,
                  signal,
                },
              });
              if (result._tag === "Failure") {
                const cause = squashAtomCommandFailure(result);
                throw new VoiceTranscriptionError(
                  "transcription-failed",
                  cause instanceof Error ? cause.message : "Could not transcribe this recording.",
                  { cause },
                );
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
    if (!config?.credential || !allowed || readDraft().ownerKey !== input.ownerKey)
      controller.cancel();
    return () => controller.dispose();
  }, [controller, input.ownerKey, config, allowed, readDraft]);
  return {
    state,
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
