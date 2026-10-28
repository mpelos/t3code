import { useAtomValue } from "@effect/atom-react";
import { useSyncExternalStore } from "react";
import { SquareIcon, Volume2Icon } from "lucide-react";
import { isNarrationConfigured, type EnvironmentId } from "@t3tools/contracts";
import { speechContextAtom } from "~/state/speech";
import { narrationAtom } from "~/state/narration";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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
  const speech = useAtomValue(speechContextAtom);
  const speechEnvironmentId = speech.environmentId;
  const configured = isNarrationConfigured(speech.narration);
  const allowed = speech.canOperate;
  const key = `${speechEnvironmentId}:${environmentId}:${owner}`;
  const state = useSyncExternalStore(controller.subscribe, () => {
    const snapshot = controller.getSnapshot();
    return snapshot.owner === key ? snapshot : null;
  });
  const active = state !== null && state.phase !== "idle";
  const error = state?.error;
  if (!configured || speechEnvironmentId === null) return null;
  const label = active ? "Stop reading aloud" : "Read aloud";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            aria-label={label}
            data-speech-active={active || Boolean(error) ? "true" : undefined}
            disabled={!active && (!allowed || streaming || !text.trim())}
            onClick={() =>
              active
                ? controller.stop()
                : void controller.start(key, text, speechEnvironmentId, speech.narration?.provider)
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
  );
}
