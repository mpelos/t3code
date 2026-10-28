import { useAtomValue } from "@effect/atom-react";
import { useSyncExternalStore } from "react";
import { Pressable, type ColorValue } from "react-native";
import { isNarrationConfigured, type EnvironmentId } from "@t3tools/contracts";
import { speechContextAtom } from "../../state/speech";
import { narrationAtom } from "./narration";
import { SymbolView } from "../../components/ui/AppSymbol";

export function ReadAloudButton({
  environmentId,
  owner,
  text,
  streaming,
  tintColor,
}: {
  readonly environmentId: EnvironmentId;
  readonly owner: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly tintColor: ColorValue;
}) {
  const controller = useAtomValue(narrationAtom);
  const speech = useAtomValue(speechContextAtom);
  const speechEnvironmentId = speech.environmentId;
  const configured = isNarrationConfigured(speech.narration);
  const allowed = speech.canOperate;
  const key = `${speechEnvironmentId}:${environmentId}:${owner}`;
  const active = useSyncExternalStore(controller.subscribe, () => {
    const snapshot = controller.getSnapshot();
    return snapshot.owner === key && snapshot.phase !== "idle";
  });
  if (!configured || speechEnvironmentId === null) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={active ? "Stop reading aloud" : "Read aloud"}
      disabled={!active && (!allowed || streaming || !text.trim())}
      hitSlop={8}
      className="items-center justify-center active:opacity-50 disabled:opacity-40"
      style={{ width: 28, height: 28 }}
      onPress={() =>
        active
          ? controller.stop()
          : void controller.start(key, text, speechEnvironmentId, speech.narration?.provider)
      }
    >
      <SymbolView
        name={active ? "stop.fill" : "headphones"}
        size={13}
        tintColor={tintColor}
        type="monochrome"
      />
    </Pressable>
  );
}
