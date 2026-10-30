import { AppState } from "react-native";
import { createAudioPlayer } from "expo-audio";
import { decodeAudioData } from "react-native-audio-api";
import { File, Paths } from "expo-file-system";
import { Atom } from "effect/reactivity";
import { isNarrationConfigured, type EnvironmentId } from "@t3tools/contracts";
import {
  NarrationController,
  inspectNarrationAudio,
  type NarrationPlaybackOptions,
} from "@t3tools/client-runtime/voice-input";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { speechEnvironment, speechContextAtom } from "../../state/speech";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
  pauseAudioPlayer,
} from "../../lib/audioSession";
import { uuidv4 } from "../../lib/uuid";

async function playNarration(
  bytes: Uint8Array,
  signal: AbortSignal,
  options: NarrationPlaybackOptions,
): Promise<void> {
  if (signal.aborted) return;
  const file = new File(Paths.cache, `narration-${uuidv4()}.mp3`);
  file.write(bytes);
  const player = createAudioPlayer(file.uri, { updateInterval: 250 });
  const finished = Promise.withResolvers<Error | null>();
  const loaded = Promise.withResolvers<Error | null>();
  let ready = false;
  const abort = () => {
    pauseAudioPlayer(player);
    finished.resolve(null);
    loaded.resolve(null);
  };
  const token = acquireAudioSession(
    "playback",
    () => finished.resolve(new Error("Narration was interrupted.")),
    () => pauseAudioPlayer(player),
  );
  const listener = player.addListener("playbackStatusUpdate", (status) => {
    if (ready) options.onProgress(status.currentTime);
    if (status.isLoaded) loaded.resolve(null);
    if (status.error) {
      const error = new Error("Could not play the generated audio.");
      finished.resolve(error);
      loaded.resolve(error);
    } else if (status.didJustFinish) finished.resolve(null);
  });
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) return;
    if (player.isLoaded) loaded.resolve(null);
    const loadError = await loaded.promise;
    if (loadError) throw loadError;
    if (signal.aborted) return;
    if (!(await activateAudioSession(token)))
      throw new Error("Finish dictation before listening to a response.");
    if (signal.aborted) return;
    await player.seekTo(options.startSeconds, 0, 0);
    if (signal.aborted) return;
    ready = true;
    options.onReady({
      setPaused: (paused) => {
        try {
          if (paused) pauseAudioPlayer(player);
          else player.play();
        } catch {
          finished.resolve(new Error("Could not play the generated audio."));
        }
      },
      setRate: (rate) => {
        try {
          player.setPlaybackRate(rate);
        } catch {
          finished.resolve(new Error("Could not change the playback speed."));
        }
      },
    });
    const error = await finished.promise;
    if (error) throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    listener.remove();
    try {
      await releaseAudioSession(token);
    } finally {
      try {
        player.release();
      } finally {
        file.delete();
      }
    }
  }
}

export const narrationAtom = Atom.make((get) => {
  const registry = get.registry;
  const controller = new NarrationController<EnvironmentId>({
    synthesize: async (text, environmentId, signal) => {
      const result = await speechEnvironment.narrate.run(registry, {
        environmentId,
        input: { text, signal },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
    inspect: async (bytes) =>
      inspectNarrationAudio(await decodeAudioData(Uint8Array.from(bytes).buffer, 8000)),
    play: playNarration,
  });
  let previous = registry.get(speechContextAtom);
  get.addFinalizer(
    registry.subscribe(speechContextAtom, (speech) => {
      if (
        speech.environmentId !== previous.environmentId ||
        speech.narration?.provider !== previous.narration?.provider ||
        !isNarrationConfigured(speech.narration) ||
        !speech.canOperate
      )
        controller.stop();
      previous = speech;
    }),
  );
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "background") controller.stop();
  });
  get.addFinalizer(() => {
    subscription.remove();
    controller.stop();
  });
  return controller;
}).pipe(Atom.keepAlive);
