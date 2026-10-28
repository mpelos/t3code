import { useAtomValue } from "@effect/atom-react";
import { getDefaultHeaderHeight } from "@react-navigation/elements";
import { useSyncExternalStore } from "react";
import { Platform, Pressable, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";
import { AppText } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";
import { Button } from "../../components/ui/Button";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { narrationAtom } from "./narration";
import { cn } from "../../lib/cn";
import { useToolbarLayout } from "../../components/ui/useToolbarLayout";
import { rootNavigationRef, whenRootNavigationReady } from "../../lib/rootNavigation";
import { openSettings } from "../settings/settings-navigation";

export function NarrationPlayer() {
  const controller = useAtomValue(narrationAtom);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const toolbar = useToolbarLayout();
  const headerHeight =
    Platform.OS === "ios"
      ? getDefaultHeaderHeight(dimensions, false, insets.top)
      : toolbar.paddingTop + toolbar.height + toolbar.paddingBottom;
  if (state.phase === "idle" && !state.error) return null;
  const elapsed = `${Math.floor(state.elapsedSeconds / 60)}:${String(state.elapsedSeconds % 60).padStart(2, "0")}`;
  const player = (
    <View pointerEvents="box-none" className="absolute inset-0">
      <View
        pointerEvents="box-none"
        style={{
          position: "absolute",
          top: headerHeight + 8,
          left: insets.left + 12,
          right: insets.right + 12,
        }}
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
                  label="Speech settings"
                  tone="text"
                  onPress={() => {
                    controller.stop();
                    whenRootNavigationReady(() =>
                      openSettings(rootNavigationRef, "SettingsSpeech", { role: "narration" }),
                    );
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
    </View>
  );
  return Platform.OS === "ios" ? <FullWindowOverlay>{player}</FullWindowOverlay> : player;
}
