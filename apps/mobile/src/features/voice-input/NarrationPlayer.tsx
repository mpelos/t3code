import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";
import { Button } from "../../components/ui/Button";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { narrationAtom } from "./narration";
import { cn } from "../../lib/cn";

export function NarrationPlayer({
  top,
  left,
  right,
}: {
  readonly top: number;
  readonly left: number;
  readonly right: number;
}) {
  const navigation = useNavigation();
  const controller = useAtomValue(narrationAtom);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  if (state.phase === "idle" && !state.error) return null;
  const elapsed = `${Math.floor(state.elapsedSeconds / 60)}:${String(state.elapsedSeconds % 60).padStart(2, "0")}`;
  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", top: top + 8, left: left + 12, right: right + 12 }}
    >
      <View
        accessibilityLabel="Read aloud player"
        className={cn(
          "mx-auto w-full max-w-md flex-row items-center gap-1 border border-border bg-secondary px-2 shadow-lg",
          state.error ? "rounded-2xl" : "rounded-full",
        )}
      >
        {state.error ? (
          <View className="min-w-0 flex-1 gap-1 py-2 pl-2">
            <AppText accessibilityRole="alert" className="text-xs text-danger-foreground">
              {state.error}
            </AppText>
            {state.errorAction === "speech-settings" ? (
              <Button
                label="Fix credentials"
                tone="text"
                onPress={() => {
                  controller.stop();
                  navigation.navigate("SettingsSpeech", { role: "narration" });
                }}
              />
            ) : null}
          </View>
        ) : (
          <>
            <IconButton
              icon={state.paused ? "play" : "pause"}
              accessibilityLabel={state.paused ? "Resume narration" : "Pause narration"}
              onPress={() => controller.togglePaused()}
            />
            <View className="min-w-0 flex-1 flex-row items-center gap-2">
              {state.phase === "loading" ? (
                <AppActivityIndicator colorClassName="accent-foreground-muted" />
              ) : null}
              <AppText numberOfLines={1} className="shrink text-sm text-foreground">
                {state.paused
                  ? "Paused"
                  : state.phase === "loading"
                    ? "Preparing audio…"
                    : "Read aloud"}
              </AppText>
            </View>
            <AppText
              className="text-xs tabular-nums text-foreground-muted"
              accessibilityLabel="Playback time"
            >
              {elapsed}
            </AppText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Playback speed ${state.rate}x`}
              onPress={() => controller.cycleRate()}
              className="min-h-12 min-w-12 items-center justify-center rounded-full active:opacity-70"
            >
              <AppText className="text-sm font-t3-medium text-foreground">{state.rate}x</AppText>
            </Pressable>
          </>
        )}
        <IconButton
          icon="xmark"
          accessibilityLabel="Close narration"
          onPress={() => controller.stop()}
        />
      </View>
    </View>
  );
}
