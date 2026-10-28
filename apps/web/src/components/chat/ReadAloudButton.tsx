import { Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useSyncExternalStore } from "react";
import { Atom } from "effect/reactivity";
import { SquareIcon, Volume2Icon } from "lucide-react";
import { type EnvironmentId } from "@t3tools/contracts";
import { NarrationController } from "@t3tools/client-runtime/voice-input";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { speechEnvironment, speechContextAtom } from "~/state/speech";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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
    play: (bytes, signal) =>
      new Promise<void>((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: "audio/mpeg" }));
        const player = new Audio(url);
        const finish = (error?: Error) => {
          signal.removeEventListener("abort", abort);
          player.onended = null;
          player.onerror = null;
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
        player.onended = () => finish();
        player.onerror = () => finish(new Error("Could not play the generated audio."));
        void player
          .play()
          .catch(() =>
            finish(new Error("Audio playback was blocked. Try reading the response again.")),
          );
      }),
  });
  get.addFinalizer(() => controller.stop());
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
  const speech = useAtomValue(speechContextAtom);
  const speechEnvironmentId = speech.environmentId;
  const configured = speech.narration?.credential;
  const allowed = speech.canOperate;
  const key = `${speechEnvironmentId}:${environmentId}:${owner}`;
  const active = state.owner === key && state.phase !== "idle";
  const error = state.owner === key ? state.error : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops audio when its response leaves the timeline or its provider is disconnected
  useEffect(() => {
    if (!configured && controller.getSnapshot().owner === key) controller.stop();
    return () => {
      if (controller.getSnapshot().owner === key) controller.stop();
    };
  }, [controller, key, configured]);
  if (!configured || speechEnvironmentId === null) return null;
  const label = active ? "Stop reading aloud" : "Read aloud (AI-generated voice)";
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2"
      data-speech-active={active || Boolean(error) ? "true" : undefined}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              aria-label={label}
              disabled={!active && (!allowed || streaming || !text.trim())}
              onClick={() =>
                active ? controller.stop() : void controller.start(key, text, speechEnvironmentId)
              }
            />
          }
        >
          {active && state.phase === "loading" ? (
            <Spinner />
          ) : active ? (
            <SquareIcon />
          ) : (
            <Volume2Icon />
          )}
        </TooltipTrigger>
        <TooltipPopup>{error ?? label}</TooltipPopup>
      </Tooltip>
      {error && state.errorAction === "speech-settings" ? (
        <Link
          to="/settings/general"
          search={{}}
          hash="speech-narration"
          onClick={() => controller.stop()}
        >
          Fix credentials
        </Link>
      ) : null}
      {error ? (
        <span role="alert" className="text-xs text-destructive-foreground">
          {error}
        </span>
      ) : null}
    </div>
  );
}
