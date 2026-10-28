import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import { PauseIcon, PlayIcon, Volume2Icon, XIcon } from "lucide-react";
import { narrationAtom } from "~/state/narration";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

export function NarrationPlayer() {
  const controller = useAtomValue(narrationAtom);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  if (state.phase === "idle" && !state.error) return null;
  const elapsed = `${Math.floor(state.elapsedSeconds / 60)}:${String(state.elapsedSeconds % 60).padStart(2, "0")}`;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-4">
      <div
        role="region"
        aria-label="Read aloud player"
        className={cn(
          "pointer-events-auto flex w-full max-w-md items-center gap-2 border border-border bg-popover px-3 py-2 text-popover-foreground shadow-lg",
          state.error ? "rounded-2xl" : "rounded-full",
        )}
      >
        {state.error ? (
          <div className="min-w-0 flex-1 py-1 pl-2 text-xs">
            <p role="alert" className="text-destructive-foreground">
              {state.error}
            </p>
            {state.errorAction === "speech-settings" ? (
              <Link
                to="/settings/general"
                search={{}}
                hash="speech-narration"
                onClick={() => controller.stop()}
              >
                Fix credentials
              </Link>
            ) : null}
          </div>
        ) : (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={state.paused ? "Resume narration" : "Pause narration"}
              onClick={() => controller.togglePaused()}
            >
              {state.paused ? <PlayIcon /> : <PauseIcon />}
            </Button>
            <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
              {state.phase === "loading" ? (
                <Spinner />
              ) : (
                <Volume2Icon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">
                {state.paused
                  ? "Paused"
                  : state.phase === "loading"
                    ? "Preparing audio…"
                    : "Read aloud"}
              </span>
            </div>
            <span className="text-xs tabular-nums text-muted-foreground" aria-label="Playback time">
              {elapsed}
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Playback speed ${state.rate}x`}
              onClick={() => controller.cycleRate()}
            >
              {state.rate}x
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close narration"
          onClick={() => controller.stop()}
        >
          <XIcon />
        </Button>
      </div>
    </div>
  );
}
