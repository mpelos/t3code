import { useAtomValue } from "@effect/atom-react";
import { useSyncExternalStore } from "react";
import { type EnvironmentId } from "@t3tools/contracts";
import { speechContextAtom } from "../../state/speech";
import { narrationAtom } from "./narration";
import { IconButton } from "../../components/ui/IconButton";

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
  const configured = speech.narration?.credential;
  const allowed = speech.canOperate;
  const key = `${speechEnvironmentId}:${environmentId}:${owner}`;
  const active = useSyncExternalStore(controller.subscribe, () => {
    const snapshot = controller.getSnapshot();
    return snapshot.owner === key && snapshot.phase !== "idle";
  });
  if (!configured || speechEnvironmentId === null) return null;
  return (
    <IconButton
      icon={active ? "stop.fill" : "headphones"}
      accessibilityLabel={active ? "Stop reading aloud" : "Read aloud"}
      disabled={!active && (!allowed || streaming || !text.trim())}
      onPress={() =>
        active ? controller.stop() : void controller.start(key, text, speechEnvironmentId)
      }
    />
  );
}
