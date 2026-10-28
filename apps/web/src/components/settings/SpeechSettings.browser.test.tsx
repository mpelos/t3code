import * as Cause from "effect/Cause";
import {
  DEFAULT_QWEN_NARRATION_URL,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ServerConfig,
  SpeechError,
  type SpeechConfigureInput,
} from "@t3tools/contracts";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { EnvironmentPresentation } from "../../state/environments";
import { render } from "../../../test/render";
import "../../index.css";

const state = vi.hoisted(
  (): {
    environments: EnvironmentPresentation[];
    primaryId: EnvironmentId | null;
    selectedId: EnvironmentId | null;
    listeners: Set<() => void>;
    update: ReturnType<
      typeof vi.fn<
        (request: { environmentId: EnvironmentId; input: SpeechConfigureInput }) => Promise<unknown>
      >
    >;
  } => ({
    environments: [],
    primaryId: null,
    selectedId: null,
    listeners: new Set(),
    update: vi.fn(),
  }),
);

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: () => ({
    isReady: true,
    networkStatus: "online",
    environments: state.environments,
    presentationById: new Map(),
  }),
  usePrimaryEnvironmentId: () => state.primaryId,
  usePrimaryEnvironment: () =>
    state.environments.find((environment) => environment.environmentId === state.primaryId) ?? null,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: (environments: readonly { environmentId: EnvironmentId }[]) =>
    new Set(environments.map((environment) => environment.environmentId)),
}));
vi.mock("../../state/speech", async () => {
  const { Atom } = await import("effect/reactivity");
  const context = Atom.make((get) => {
    const publish = () => get.setSelf({ environmentId: state.selectedId });
    state.listeners.add(publish);
    get.addFinalizer(() => state.listeners.delete(publish));
    return { environmentId: state.selectedId };
  });
  return {
    speechContextAtom: context,
    selectSpeechEnvironment: async (environmentId: EnvironmentId) => {
      state.selectedId = environmentId;
      for (const listener of state.listeners) listener();
    },
    speechEnvironment: { configure: { permissionAtom: () => Atom.make(true) } },
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.update }));
vi.mock(import("./useSettingsProjectGroups"), () => ({ useSettingsProjectGroups: () => [] }));

import { SettingsScopeProvider } from "./SettingsScopeContext";
import { SpeechSettings } from "./SpeechSettings";

it("configures a local voice without credentials and preserves its voice and language", async () => {
  state.environments = [environment("Server")];
  state.primaryId = EnvironmentId.make("Server");
  state.selectedId = EnvironmentId.make("Server");
  for (const listener of state.listeners) listener();
  state.update.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  await using screen = await render(<SpeechSettings />);
  await userEvent.click(screen.getByRole("combobox", { name: "Read aloud provider" }));
  await userEvent.click(page.getByRole("option", { name: "Qwen3-TTS (local)" }));
  await expect.element(screen.getByLabelText("Read aloud credentials")).not.toBeInTheDocument();
  await expect
    .element(screen.getByLabelText("Local voice server URL"))
    .toHaveValue(DEFAULT_QWEN_NARRATION_URL);
  await userEvent.click(screen.getByRole("combobox", { name: "Narration voice" }));
  await userEvent.click(page.getByRole("option", { name: "Aiden", exact: true }));
  state.update.mockResolvedValueOnce(
    AsyncResult.failure(
      Cause.fail(new SpeechError({ provider: "qwen", role: "narration", reason: "unavailable" })),
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Validate and save read aloud" }));
  await expect
    .element(screen.getByRole("alert"))
    .toMatchTextContent(/local voice server is unavailable/);
  await expect
    .element(screen.getByRole("combobox", { name: "Narration voice" }))
    .toHaveTextContent("Aiden");
  await userEvent.click(screen.getByRole("button", { name: "Validate and save read aloud" }));
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("Local narration verified and saved.");
  expect(state.update).toHaveBeenLastCalledWith({
    environmentId: EnvironmentId.make("Server"),
    input: {
      role: "narration",
      config: {
        provider: "qwen",
        baseUrl: DEFAULT_QWEN_NARRATION_URL,
        voice: "Aiden",
        language: "Portuguese",
      },
    },
  });
});

const decodeConfig = Schema.decodeUnknownSync(ServerConfig);
function environment(id: string): EnvironmentPresentation {
  const environmentId = EnvironmentId.make(id);
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: id,
    httpBaseUrl: `http://${id}.test`,
    wsBaseUrl: `ws://${id}.test/ws`,
  });
  return {
    environmentId,
    label: id,
    displayUrl: target.httpBaseUrl,
    relayManaged: false,
    entry: { target, profile: Option.none(), enabled: true },
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig: decodeConfig({
      environment: {
        environmentId,
        label: id,
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.1.3",
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
        capabilities: {},
      },
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
      cwd: "/workspace",
      keybindingsConfigPath: "/workspace/keybindings.json",
      keybindings: [],
      issues: [],
      providers: [],
      availableEditors: [],
      observability: {
        logsDirectoryPath: "/workspace/logs",
        localTracingEnabled: false,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      },
      settings: {},
    }),
  };
}

it.each([
  { search: {}, primary: "Server", hash: "" },
  { search: { machine: "removed" }, primary: "Server", hash: "" },
  { search: { machine: "Laptop" }, primary: "Laptop", hash: "speech-dictation" },
])(
  "uses the app-selected Speech host independently of chat and Settings scope %j",
  async ({ search, primary, hash }) => {
    state.environments = [environment("Laptop"), environment("Server")];
    state.primaryId = EnvironmentId.make(primary);
    state.selectedId = EnvironmentId.make("Server");
    for (const listener of state.listeners) listener();
    state.update.mockReset().mockResolvedValue(AsyncResult.success(undefined));
    await using screen = await render(
      <SettingsScopeProvider search={search} onChange={() => {}}>
        <SpeechSettings />
      </SettingsScopeProvider>,
      { router: `/settings/general${hash ? `#${hash}` : ""}` },
    );

    await expect
      .element(screen.getByRole("combobox", { name: "Speech environment" }))
      .toHaveTextContent("Server");
    await expect
      .element(screen.getByRole("combobox", { name: "Dictation provider" }))
      .toBeVisible();
    await userEvent.click(screen.getByRole("combobox", { name: "Dictation provider" }));
    await userEvent.click(page.getByRole("option", { name: "OpenAI Whisper" }));
    await userEvent.type(screen.getByLabelText("Dictation credentials"), "unsaved-server-key");

    await userEvent.click(screen.getByRole("combobox", { name: "Speech environment" }));
    await userEvent.click(page.getByRole("option", { name: "Laptop" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Dictation provider" }));
    await userEvent.click(page.getByRole("option", { name: "OpenAI Whisper" }));
    await expect.element(screen.getByLabelText("Dictation credentials")).toHaveValue("");
    await userEvent.type(screen.getByLabelText("Dictation credentials"), "laptop-key");
    state.update.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new SpeechError({ reason: "invalid-credential", provider: "openai", role: "dictation" }),
        ),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Validate and save dictation" }));
    await expect
      .element(screen.getByRole("alert"))
      .toMatchTextContent(/OpenAI dictation: The API key is invalid or expired/);
    await expect.element(screen.getByLabelText("Dictation credentials")).toHaveValue("laptop-key");
    await userEvent.click(screen.getByRole("button", { name: "Validate and save dictation" }));
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Credentials verified and saved.");
    await expect.element(screen.getByLabelText("Dictation credentials")).toHaveValue("");
    expect(state.selectedId).toBe(EnvironmentId.make("Laptop"));
    expect(state.update).toHaveBeenCalledTimes(2);
    expect(state.update).toHaveBeenLastCalledWith({
      environmentId: EnvironmentId.make("Laptop"),
      input: {
        role: "dictation",
        config: { provider: "openai", credential: "laptop-key", language: "en-US" },
      },
    });
  },
);
