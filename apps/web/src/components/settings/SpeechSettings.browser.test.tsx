import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ServerConfig,
  type ServerSettingsPatch,
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
    update: ReturnType<
      typeof vi.fn<
        (request: {
          environmentId: EnvironmentId;
          input: { patch: ServerSettingsPatch };
        }) => Promise<unknown>
      >
    >;
  } => ({ environments: [], primaryId: null, update: vi.fn() }),
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
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.update }));
vi.mock(import("./useSettingsProjectGroups"), () => ({ useSettingsProjectGroups: () => [] }));

import { SettingsScopeProvider } from "./SettingsScopeContext";
import { SpeechSettings } from "./SpeechSettings";

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

it.each([{}, { machine: "removed" }])(
  "configures the selected environment independently of General's hidden scope %j",
  async (search) => {
    state.environments = [environment("Laptop"), environment("Server")];
    state.primaryId = EnvironmentId.make("Server");
    state.update.mockReset().mockResolvedValue(AsyncResult.success(undefined));
    await using screen = await render(
      <SettingsScopeProvider search={search} onChange={() => {}}>
        <SpeechSettings />
      </SettingsScopeProvider>,
      { router: "/settings/general" },
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
    await userEvent.click(screen.getByRole("button", { name: "Save dictation" }));
    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      environmentId: EnvironmentId.make("Laptop"),
      input: {
        patch: {
          speech: {
            dictation: { provider: "openai", credential: "laptop-key", language: "en-US" },
          },
        },
      },
    });
  },
);
