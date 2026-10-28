import { uuidv4 } from "../../lib/uuid";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useSyncExternalStore } from "react";
import { AppState, View } from "react-native";
import { createAudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { Atom } from "effect/reactivity";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { NarrationController } from "@t3tools/client-runtime/voice-input";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { serverEnvironment } from "../../state/server";
import { speechEnvironment } from "../../state/speech";
import { useEnvironmentScope } from "../../state/session";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
  pauseAudioPlayer,
} from "../../lib/audioSession";
import { IconButton } from "../../components/ui/IconButton";
import { AppText as Text } from "../../components/ui/AppText";

async function playNarration(bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const file = new File(Paths.cache, `narration-${uuidv4()}.mp3`);
  file.write(bytes);
  const player = createAudioPlayer(file.uri, { updateInterval: 250 });
  const finished = Promise.withResolvers<Error | null>();
  const abort = () => {
    pauseAudioPlayer(player);
    finished.resolve(null);
  };
  const token = acquireAudioSession(
    "playback",
    () => finished.resolve(new Error("Narration was interrupted.")),
    () => pauseAudioPlayer(player),
  );
  const listener = player.addListener("playbackStatusUpdate", (status) => {
    if (status.error) finished.resolve(new Error("Could not play the generated audio."));
    else if (status.didJustFinish) finished.resolve(null);
  });
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) return;
    if (!(await activateAudioSession(token)))
      throw new Error("Finish dictation before listening to a response.");
    if (signal.aborted) return;
    player.play();
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

const narrationAtom = Atom.make((get) => {
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
    play: playNarration,
  });
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "background") controller.stop();
  });
  get.addFinalizer(() => {
    subscription.remove();
    controller.stop();
  });
  return controller;
}).pipe(Atom.keepAlive);

export function ReadAloudButton({
  environmentId,
  owner,
  text,
  streaming,
}: {
  readonly environmentId: EnvironmentId;
  readonly owner: string;
  readonly text: string;
  readonly streaming: boolean;
}) {
  const controller = useAtomValue(narrationAtom);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const configured = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.settings.speech
    .narration?.credential;
  const allowed = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const key = `${environmentId}:${owner}`;
  const active = state.owner === key && state.phase !== "idle";
  const error = state.owner === key ? state.error : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops audio when its response unmounts or the configured narration provider disconnects
  useEffect(() => {
    if (!configured && controller.getSnapshot().owner === key) controller.stop();
    return () => {
      if (controller.getSnapshot().owner === key) controller.stop();
    };
  }, [controller, key, configured]);
  if (!configured) return null;
  return (
    <View className="shrink flex-row items-center gap-1">
      <IconButton
        icon={active ? "stop.fill" : "headphones"}
        accessibilityLabel={active ? "Stop reading aloud" : "Read aloud (AI-generated voice)"}
        disabled={!active && (!allowed || streaming || !text.trim())}
        onPress={() =>
          active ? controller.stop() : void controller.start(key, text, environmentId)
        }
      />
      {error ? (
        <Text accessibilityRole="alert" className="shrink text-xs text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
