import { EnvironmentId, SpeechError, AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "../../index.css";
import narrationSample from "../../assets/notification-completion.mp3?url";

const state = vi.hoisted(() => ({
  selected: "speech-host",
  listeners: new Set<() => void>(),
  synthesize: vi.fn(),
  transcribe: vi.fn(),
  commit: vi.fn(),
}));
vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => ({ speechEnvironmentId: EnvironmentId.make(state.selected) }),
  getClientSettingsHydratedSnapshot: () => true,
  subscribeClientSettings: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
  subscribeClientSettingsHydration: () => () => {},
  updateClientSettings: async ({ speechEnvironmentId }: { speechEnvironmentId: EnvironmentId }) => {
    state.selected = speechEnvironmentId;
    for (const listener of state.listeners) listener();
  },
}));
vi.mock("~/state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make(EnvironmentId.make("agent-host")) };
});
vi.mock("~/connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/speech", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/speech")>()),
  createSpeechEnvironmentCommands: () => ({
    narrate: { run: (...args: unknown[]) => state.synthesize(...args) },
    transcribe: {},
  }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.transcribe }));
vi.mock("~/state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const configValueAtom = Atom.family((id: string) =>
    Atom.make(
      id === "speech-host" || id === "qwen-host"
        ? {
            settings: {
              speech: {
                dictation: { provider: "openai", credential: "stored", language: "pt-BR" },
                narration:
                  id === "qwen-host"
                    ? {
                        provider: "qwen",
                        baseUrl: "http://127.0.0.1:18320",
                        voice: "Ryan",
                        language: "Portuguese",
                      }
                    : { provider: "elevenlabs", credential: "stored", voice: "voice-id" },
              },
            },
          }
        : null,
    ),
  );
  return { serverEnvironment: { configValueAtom } };
});
vi.mock("~/state/session", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    environmentSession: {
      sessionStateAtom: () =>
        Atom.make(
          AsyncResult.success({
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "test",
            },
            permissions: [AuthOrchestrationOperateScope],
            scopes: [AuthOrchestrationOperateScope],
          }),
        ),
    },
  };
});
vi.mock("./webVoiceRecorder", () => ({
  WebVoiceRecorder: class {
    uri = "test:recording";
    requestPermission = async () => ({ granted: true, canAskAgain: true });
    prepareToRecordAsync = vi.fn();
    record = vi.fn();
    stop = vi.fn();
    release = vi.fn();
    delete = vi.fn();
    read = () => ({ blob: new Blob([new Uint8Array([1, 2, 3])]), format: "wav" });
    levels = () => new Uint8Array(24);
  },
}));

import { NarrationPlayer } from "./NarrationPlayer";
import { ReadAloudButton } from "./ReadAloudButton";
import { DictationControl } from "./DictationControl";
import { useWebDictation } from "./useWebDictation";
import { selectSpeechEnvironment } from "~/state/speech";

function setup() {
  state.selected = "speech-host";
  for (const listener of state.listeners) listener();
  state.commit.mockReset();
  state.transcribe.mockReset().mockResolvedValue(AsyncResult.success({ text: "spoken words" }));
  state.synthesize.mockReset().mockResolvedValue(
    AsyncResult.failure(
      Cause.fail(
        new SpeechError({
          reason: "invalid-credential",
          provider: "elevenlabs",
          role: "narration",
        }),
      ),
    ),
  );
}
function Dictation() {
  const voice = useWebDictation({
    ownerKey: "agent-host:thread",
    readDraft: () => ({
      ownerKey: "agent-host:thread",
      text: "",
      revision: 0,
      selection: { start: 0, end: 0 },
    }),
    commitDraft: state.commit,
  });
  return <DictationControl voice={voice} disabled={false} />;
}

it("dictates through the selected Speech host and commits to a chat running elsewhere", async () => {
  setup();
  await using screen = await render(<Dictation />);
  await userEvent.click(screen.getByRole("button", { name: "Dictate" }));
  await userEvent.click(screen.getByRole("button", { name: "Finish dictation" }));
  await vi.waitFor(() =>
    expect(state.commit).toHaveBeenCalledWith("spoken words", { start: 12, end: 12 }),
  );
  expect(state.transcribe).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("speech-host"),
    input: {
      audio: new Uint8Array([1, 2, 3]),
      format: "wav",
      signal: expect.any(AbortSignal),
    },
  });
});

it("narrates through the selected Speech host and opens global narration settings on rejection", async () => {
  setup();
  await using screen = await render(
    <>
      <NarrationPlayer />
      <ReadAloudButton
        environmentId={EnvironmentId.make("agent-host")}
        owner="reply"
        text="Hello"
        streaming={false}
      />
    </>,
    { router: "/threads/test" },
  );
  await userEvent.click(screen.getByRole("button", { name: "Read aloud" }));
  await expect
    .element(screen.getByRole("alert"))
    .toMatchTextContent(/ElevenLabs narration: The API key is invalid or expired/);
  expect(state.synthesize).toHaveBeenCalledWith(expect.anything(), {
    environmentId: EnvironmentId.make("speech-host"),
    input: { text: "Hello", signal: expect.any(AbortSignal) },
  });
  const fix = screen.getByRole("link", { name: "Speech settings" });
  await expect.element(fix).toHaveAttribute("href", "/settings/general#speech-narration");
  await userEvent.click(fix);
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  expect(screen.router?.state.location.pathname).toBe("/settings/general");
});

it("hides both controls when the chosen Speech host is unconfigured, even if another host is configured", async () => {
  setup();
  await selectSpeechEnvironment(EnvironmentId.make("empty-host"));
  await using screen = await render(
    <>
      <Dictation />
      <ReadAloudButton
        environmentId={EnvironmentId.make("agent-host")}
        owner="reply"
        text="Hello"
        streaming={false}
      />
    </>,
  );
  await expect.element(screen.getByRole("button", { name: "Dictate" })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Read aloud" })).not.toBeInTheDocument();
});

it.each([
  { ending: "completion", source: "speech-host" },
  { ending: "close", source: "speech-host" },
  { ending: "seek", source: "speech-host" },
  { ending: "environment change", source: "speech-host" },
  { ending: "completion", source: "qwen-host" },
])("keeps the player when its message unmounts and cleans up on %j", async ({ ending, source }) => {
  setup();
  await selectSpeechEnvironment(EnvironmentId.make(source));
  state.synthesize.mockResolvedValue(AsyncResult.success(new Uint8Array([1, 2, 3])));
  const audio = document.createElement("audio");
  await using screen = await render(
    <>
      <NarrationPlayer />
      <ReadAloudButton
        environmentId={EnvironmentId.make("agent-host")}
        owner="reply"
        text="Hello"
        streaming={false}
      />
    </>,
  );
  using play = vi.spyOn(audio, "play").mockResolvedValue();
  using _metadata = vi.spyOn(audio, "readyState", "get").mockReturnValue(4);
  using _decode = vi
    .spyOn(OfflineAudioContext.prototype, "decodeAudioData")
    .mockResolvedValue(
      new AudioBuffer({ length: 8000 * 120, sampleRate: 8000, numberOfChannels: 1 }),
    );
  using pause = vi.spyOn(audio, "pause").mockImplementation(() => {});
  using load = vi.spyOn(audio, "load").mockImplementation(() => {});
  using _audio = vi.spyOn(window, "Audio").mockImplementation(function () {
    return audio;
  });
  using revoke = vi.spyOn(URL, "revokeObjectURL");
  await expect
    .element(screen.getByRole("region", { name: "Read aloud player" }))
    .not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Read aloud", exact: true }));
  await expect.element(screen.getByRole("button", { name: "Pause narration" })).toBeInTheDocument();
  await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));
  expect(state.synthesize).toHaveBeenCalledWith(expect.anything(), {
    environmentId: EnvironmentId.make(source),
    input: { text: "Hello", signal: expect.any(AbortSignal) },
  });
  await screen.rerender(<NarrationPlayer />);
  await expect
    .element(screen.getByRole("region", { name: "Read aloud player" }))
    .toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Pause narration" }));
  expect(pause).toHaveBeenCalledTimes(1);
  await expect
    .element(screen.getByRole("button", { name: "Resume narration" }))
    .toBeInTheDocument();
  let rate = 1;
  for (const next of [1.25, 1.5, 1.75, 2, 1]) {
    await userEvent.click(screen.getByRole("button", { name: `Playback speed ${rate}x` }));
    expect(audio.playbackRate).toBe(next);
    rate = next;
  }
  await userEvent.click(screen.getByRole("button", { name: "Resume narration" }));
  expect(play).toHaveBeenCalledTimes(2);
  audio.currentTime = 65;
  audio.dispatchEvent(new Event("timeupdate"));
  await expect.element(screen.getByLabelText("Playback time")).toHaveTextContent("1:05");
  if (ending === "seek") {
    using _capture = vi
      .spyOn(HTMLElement.prototype, "setPointerCapture")
      .mockImplementation(() => {});
    const slider = screen.getByRole("slider", { name: "Narration position" }).element();
    const bounds = slider.getBoundingClientRect();
    const at = (seconds: number) => ({
      bubbles: true,
      pointerId: 1,
      buttons: 1,
      clientX: bounds.left + (bounds.width * seconds) / 120,
    });
    slider.dispatchEvent(new PointerEvent("pointerdown", at(65)));
    slider.dispatchEvent(new PointerEvent("pointermove", at(30)));
    await expect.element(screen.getByLabelText("Playback time")).toHaveTextContent("0:30");
    expect(audio.currentTime).toBe(65);
    expect(play).toHaveBeenCalledTimes(2);
    await expect
      .element(screen.getByRole("button", { name: "Resume narration" }))
      .toBeInTheDocument();
    slider.dispatchEvent(new PointerEvent("pointerup", at(30)));
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(3));
    expect(audio.currentTime).toBe(30);
    expect(state.synthesize).toHaveBeenCalledTimes(1);
  }
  if (ending === "completion") audio.dispatchEvent(new Event("ended"));
  else if (ending === "close" || ending === "seek")
    await userEvent.click(screen.getByRole("button", { name: "Close narration" }));
  else await selectSpeechEnvironment(EnvironmentId.make("empty-host"));
  await expect
    .element(screen.getByRole("region", { name: "Read aloud player" }))
    .not.toBeInTheDocument();
  expect(revoke).toHaveBeenCalledTimes(ending === "seek" ? 2 : 1);
  expect(load).toHaveBeenCalledTimes(ending === "seek" ? 2 : 1);
});

it("decodes a real MP3 into a seekable waveform and supports keyboard seeking", async () => {
  setup();
  const audio = new Uint8Array(await (await fetch(narrationSample)).arrayBuffer());
  state.synthesize.mockResolvedValue(AsyncResult.success(audio));
  await using screen = await render(
    <>
      <NarrationPlayer />
      <ReadAloudButton
        environmentId={EnvironmentId.make("agent-host")}
        owner="reply"
        text="Hello"
        streaming={false}
      />
    </>,
  );
  using play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  await userEvent.click(screen.getByRole("button", { name: "Read aloud", exact: true }));
  const position = screen.getByRole("slider", { name: "Narration position" });
  await expect.element(position).toBeInTheDocument();
  const duration = Number(position.element().getAttribute("max"));
  expect(duration).toBeGreaterThan(0.5);
  expect(duration).toBeLessThan(1);
  await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));
  position.element().focus();
  await userEvent.keyboard("{ArrowRight}");
  await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
  expect(Number(position.element().getAttribute("value"))).toBeGreaterThan(0);
  expect(state.synthesize).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Close narration" }));
});

it("closes and cancels narration while audio is still being prepared", async () => {
  setup();
  const generated = Promise.withResolvers<ReturnType<typeof AsyncResult.success<Uint8Array>>>();
  state.synthesize.mockReturnValue(generated.promise);
  await using screen = await render(
    <>
      <NarrationPlayer />
      <ReadAloudButton
        environmentId={EnvironmentId.make("agent-host")}
        owner="reply"
        text="Hello"
        streaming={false}
      />
    </>,
  );
  using createUrl = vi.spyOn(URL, "createObjectURL");
  await userEvent.click(screen.getByRole("button", { name: "Read aloud", exact: true }));
  await expect
    .element(screen.getByRole("region", { name: "Read aloud player" }))
    .toMatchTextContent(/Preparing audio/);
  await userEvent.click(screen.getByRole("button", { name: "Close narration" }));
  await expect
    .element(screen.getByRole("region", { name: "Read aloud player" }))
    .not.toBeInTheDocument();
  const request = state.synthesize.mock.calls[0]?.[1];
  expect(request.input.signal.aborted).toBe(true);
  generated.resolve(AsyncResult.success(new Uint8Array([1, 2, 3])));
  await generated.promise;
  expect(createUrl).not.toHaveBeenCalled();
});
