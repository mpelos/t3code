export {
  VoiceInputController,
  VOICE_RECORDING_LIMIT_SECONDS,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceInputPhase,
  type VoiceInputState,
  type VoiceRecorder,
  type VoiceRecorderStatus,
} from "./controller.ts";
export {
  voiceTranscriptionFailure,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionErrorCode,
  type VoiceTranscriptionOptions,
} from "./transcription.ts";

export { NarrationController } from "./narration.ts";
export {
  SPEECH_PROVIDERS,
  speechSettingsDraft,
  selectSpeechProvider,
  dictationSettingsFromDraft,
  narrationSettingsFromDraft,
  type SpeechSettingsDraft,
  type SpeechProvider,
} from "./settings.ts";
