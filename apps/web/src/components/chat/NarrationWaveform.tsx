import { useId } from "react";
import {
  formatNarrationTime,
  narrationWaveformPath,
  type NarrationController,
  type NarrationState,
} from "@t3tools/client-runtime/voice-input";

export function NarrationWaveform<Context>({
  controller,
  state,
}: {
  readonly controller: NarrationController<Context>;
  readonly state: NarrationState;
}) {
  const id = useId();
  const path = narrationWaveformPath(state.waveform);
  const progress = Math.min(1, state.elapsedSeconds / state.durationSeconds);
  const seekAt = (element: HTMLInputElement, clientX: number) => {
    const bounds = element.getBoundingClientRect();
    if (bounds.width > 0)
      controller.seekTo(
        ((clientX - bounds.left) / bounds.width) * controller.getSnapshot().durationSeconds,
      );
  };
  return (
    <div className="relative h-8 min-w-0 flex-1 rounded-sm text-foreground focus-within:outline-2 focus-within:outline-ring">
      <svg viewBox="0 0 256 28" preserveAspectRatio="none" className="h-full w-full" aria-hidden>
        <defs>
          <clipPath id={id}>
            <rect x={0} y={0} width={256 * progress} height={28} />
          </clipPath>
        </defs>
        <path d={path} stroke="currentColor" strokeWidth={2} strokeLinecap="round" opacity={0.25} />
        <path
          d={path}
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          clipPath={`url(#${id})`}
        />
      </svg>
      <input
        type="range"
        min={0}
        max={state.durationSeconds}
        step={0.01}
        value={state.elapsedSeconds}
        aria-label="Narration position"
        aria-valuetext={`${formatNarrationTime(state.elapsedSeconds)} of ${formatNarrationTime(state.durationSeconds)}${state.complete ? "" : " prepared"}`}
        className="absolute inset-0 h-full w-full cursor-ew-resize touch-none opacity-0"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          controller.beginSeek();
          seekAt(event.currentTarget, event.clientX);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) seekAt(event.currentTarget, event.clientX);
        }}
        onChange={(event) => controller.seekTo(Number(event.currentTarget.value))}
        onPointerUp={(event) => {
          seekAt(event.currentTarget, event.clientX);
          controller.endSeek();
        }}
        onPointerCancel={() => controller.cancelSeek()}
        onLostPointerCapture={() => controller.cancelSeek()}
        onBlur={() => controller.cancelSeek()}
        onKeyDown={(event) => {
          const { durationSeconds, elapsedSeconds } = controller.getSnapshot();
          const step = durationSeconds / 100;
          let target: number;
          switch (event.key) {
            case "ArrowLeft":
            case "ArrowDown":
              target = elapsedSeconds - step;
              break;
            case "ArrowRight":
            case "ArrowUp":
              target = elapsedSeconds + step;
              break;
            case "Home":
              target = 0;
              break;
            case "End":
              target = durationSeconds;
              break;
            case "PageDown":
              target = elapsedSeconds - step * 10;
              break;
            case "PageUp":
              target = elapsedSeconds + step * 10;
              break;
            default:
              return;
          }
          event.preventDefault();
          controller.beginSeek();
          controller.seekTo(target);
        }}
        onKeyUp={() => controller.endSeek()}
      />
    </div>
  );
}
