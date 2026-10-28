import { Atom } from "effect/reactivity";
import { isNarrationConfigured, type EnvironmentId } from "@t3tools/contracts";
import {
  NarrationController,
  type NarrationPlaybackOptions,
} from "@t3tools/client-runtime/voice-input";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { speechContextAtom, speechEnvironment } from "./speech";

function playNarration(bytes: Uint8Array, signal: AbortSignal, options: NarrationPlaybackOptions) {
  return new Promise<void>((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: "audio/mpeg" }));
    const player = new Audio(url);
    let finished = false;
    let paused = true;
    const progress = () => options.onProgress(player.currentTime);
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      player.onended = null;
      player.onerror = null;
      player.ontimeupdate = null;
      player.pause();
      player.removeAttribute("src");
      player.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      finish();
      return;
    }
    player.onended = () => {
      progress();
      finish();
    };
    player.onerror = () => finish(new Error("Could not play the generated audio."));
    player.ontimeupdate = progress;
    options.onReady({
      setRate: (rate) => {
        player.playbackRate = rate;
      },
      setPaused: (next) => {
        paused = next;
        if (paused) player.pause();
        else
          void player.play().catch((error: unknown) => {
            if (
              !paused &&
              !signal.aborted &&
              !(error instanceof DOMException && error.name === "AbortError")
            )
              finish(new Error("Audio playback was blocked. Try reading the response again."));
          });
      },
    });
  });
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
  get.addFinalizer(() => controller.stop());
  return controller;
}).pipe(Atom.keepAlive);
