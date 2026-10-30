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

export {
  NarrationController,
  type NarrationPlaybackOptions,
  type NarrationState,
} from "./narration.ts";
export {
  inspectNarrationAudio,
  formatNarrationTime,
  narrationWaveformPath,
} from "./narrationWaveform.ts";
export {
  speechProviderOptions,
  fishNarrationModelOptions,
  speechSettingsDraft,
  selectSpeechProvider,
  dictationSettingsFromDraft,
  narrationSettingsFromDraft,
  type SpeechSettingsDraft,
  type SpeechProvider,
} from "./settings.ts";
