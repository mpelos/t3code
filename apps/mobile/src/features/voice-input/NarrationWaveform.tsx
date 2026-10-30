import { useId, useMemo } from "react";
import { PanResponder, View, type LayoutChangeEvent } from "react-native";
import Svg, { ClipPath, Defs, Path, Rect } from "react-native-svg";
import {
  formatNarrationTime,
  narrationWaveformPath,
  type NarrationController,
  type NarrationState,
} from "@t3tools/client-runtime/voice-input";
import { useControlTheme } from "../../components/ui/useControlTheme";

function createNarrationGesture<Context>(controller: NarrationController<Context>) {
  let width = 1;
  let origin = 0;
  const move = (position: number) =>
    controller.seekTo((position / width) * controller.getSnapshot().durationSeconds);
  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => {
      origin = event.nativeEvent.locationX;
      controller.beginSeek();
      move(origin);
    },
    onPanResponderMove: (_event, gesture) => move(origin + gesture.dx),
    onPanResponderRelease: () => controller.endSeek(),
    onPanResponderTerminate: () => controller.cancelSeek(),
    onPanResponderTerminationRequest: () => false,
  });
  return {
    ...responder.panHandlers,
    onLayout: (event: LayoutChangeEvent) => {
      width = Math.max(1, event.nativeEvent.layout.width);
    },
  };
}

export function NarrationWaveform<Context>({
  controller,
  state,
}: {
  readonly controller: NarrationController<Context>;
  readonly state: NarrationState;
}) {
  const { colors } = useControlTheme();
  const id = useId();
  const path = useMemo(() => narrationWaveformPath(state.waveform), [state.waveform]);
  const gesture = useMemo(() => createNarrationGesture(controller), [controller]);
  const progress = Math.min(1, state.elapsedSeconds / state.durationSeconds);
  return (
    <View
      {...gesture}
      accessibilityRole="adjustable"
      accessibilityLabel="Narration position"
      accessibilityValue={{
        min: 0,
        max: state.durationSeconds,
        now: state.elapsedSeconds,
        text: `${formatNarrationTime(state.elapsedSeconds)} of ${formatNarrationTime(state.durationSeconds)}${state.complete ? "" : " prepared"}`,
      }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(event) => {
        controller.beginSeek();
        controller.seekTo(
          state.elapsedSeconds + (event.nativeEvent.actionName === "increment" ? 5 : -5),
        );
        controller.endSeek();
      }}
      className="h-10 min-w-0 flex-1 justify-center"
    >
      <Svg
        width="100%"
        height={28}
        viewBox="0 0 256 28"
        preserveAspectRatio="none"
        pointerEvents="none"
      >
        <Defs>
          <ClipPath id={id}>
            <Rect x={0} y={0} width={256 * progress} height={28} />
          </ClipPath>
        </Defs>
        <Path
          d={path}
          stroke={colors["--color-foreground"]}
          strokeWidth={2}
          strokeLinecap="round"
          opacity={0.25}
        />
        <Path
          d={path}
          stroke={colors["--color-foreground"]}
          strokeWidth={2}
          strokeLinecap="round"
          clipPath={`url(#${id})`}
        />
      </Svg>
    </View>
  );
}
