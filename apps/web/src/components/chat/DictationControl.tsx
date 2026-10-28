import { useEffect, useRef } from "react";
import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { useWebDictation } from "./useWebDictation";

function RecordingWaveform({ recorder }: Pick<ReturnType<typeof useWebDictation>, "recorder">) {
  const ref = useRef<HTMLCanvasElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- samples the live microphone analyser only while the recording waveform is mounted
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const timer = setInterval(() => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = getComputedStyle(canvas).color;
      const levels = recorder.levels();
      for (let index = 0; index < 24; index++) {
        const height = Math.max(2, ((levels[index] ?? 0) / 255) * 24);
        context.fillRect(index * 4, (28 - height) / 2, 2, height);
      }
    }, 100);
    return () => clearInterval(timer);
  }, [recorder]);
  return (
    <canvas
      ref={ref}
      width={96}
      height={28}
      className="w-16 text-muted-foreground sm:w-24"
      aria-hidden
    />
  );
}

export function DictationControl({
  voice,
  disabled,
}: {
  readonly voice: ReturnType<typeof useWebDictation>;
  readonly disabled: boolean;
}) {
  if (!voice.available) return null;
  const recording = voice.state.phase === "recording";
  const active = voice.isBusy;
  const label = active ? "Cancel dictation" : "Dictate";
  return (
    <div className="flex items-center gap-1">
      {voice.state.error ? (
        <span role="alert" className="max-w-48 text-xs text-destructive-foreground">
          {voice.state.error}
        </span>
      ) : null}
      {recording ? <RecordingWaveform recorder={voice.recorder} /> : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-sm"
              aria-label={label}
              disabled={!active && disabled}
              onClick={active ? voice.cancel : voice.start}
            />
          }
        >
          {active ? <XIcon /> : <MicIcon />}
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      {active ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={recording ? "Finish dictation" : "Transcribing recording"}
          disabled={!recording}
          onClick={voice.stop}
        >
          {recording ? <CheckIcon /> : <Spinner />}
        </Button>
      ) : null}
    </div>
  );
}
