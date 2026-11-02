import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  type EditaiiPanel,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { AsyncResult, type Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { act, render } from "../../../test/render";
import { EditaiiSettings } from "./EditaiiSettings";

const environmentId = EnvironmentId.make("escritorio");
const LICITACOES = ProjectId.make("licitacoes");
const CONTRATOS = ProjectId.make("contratos");
const maquina = (id: string) => ({
  id,
  nome: "Escritório",
  dono: "pessoa@example.com",
  ambiente_t3: "ambiente-1",
  emitida_em: "2026-11-01T00:00:00.000Z",
  ativada_em: "2026-11-01T00:00:00.000Z",
  revogada_em: null,
});
const LINK = {
  origin: "https://editaii.example",
  machineId: "maquina-1",
  environmentId: "ambiente-1",
};
const conectado: EditaiiPanel = {
  connection: {
    status: "connected",
    origin: "https://editaii.example",
    machine: maquina("maquina-1"),
    problem: null,
    canReopen: false,
    projectId: LICITACOES,
    attempt: null,
  },
  configuration: {
    type: "ready",
    projectId: LICITACOES,
    projectTitle: "Licitações",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
  },
  connector: { journal: null },
  activity: {
    type: "available",
    link: LINK,
    abandoning: false,
    jobs: [
      {
        jobId: "trabalho-1",
        conversationId: "conversa-1",
        threadId: "thread-1",
        state: "waiting_for_person",
        pendingEvents: 2,
        held: false,
        receiptPending: false,
      },
    ],
    blockedConversations: [{ conversationId: "conversa-2", threadId: null, reason: "thread_lost" }],
  },
};

const state = vi.hoisted(() => ({
  panel: null as unknown as Atom.Writable<AsyncResult.AsyncResult<EditaiiPanel, never>>,
  disconnect: vi.fn(),
  chooseProject: vi.fn(),
}));

vi.mock(import("../../state/editaii"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { AsyncResult } = await import("effect/reactivity");
  state.panel = Atom.make<AsyncResult.AsyncResult<EditaiiPanel, never>>(AsyncResult.initial()).pipe(
    Atom.keepAlive,
  );
  const allowed = Atom.make(true);
  const command = <C extends object>(c: C, label: string) => ({
    ...c,
    label,
    permissionAtom: () => allowed,
  });
  const e = actual.editaiiEnvironment;
  return {
    editaiiEnvironment: {
      ...e,
      state: (() => state.panel) as never,
      configure: command(e.configure, "configure"),
      startPairing: command(e.startPairing, "start"),
      reopenBrowser: command(e.reopenBrowser, "reopen"),
      disconnect: command(e.disconnect, "disconnect"),
      chooseProject: command(e.chooseProject, "choose-project"),
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label?: string }) =>
    ({ disconnect: state.disconnect, "choose-project": state.chooseProject })[
      command.label ?? ""
    ] ?? vi.fn()) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({ environment: { environmentId, label: "Escritório" } })) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [
    { id: LICITACOES, environmentId, title: "Licitações" },
    { id: CONTRATOS, environmentId, title: "Contratos" },
    { id: ProjectId.make("rascunho"), environmentId, title: "Rascunho", isScratch: true },
    { id: ProjectId.make("outro"), environmentId: EnvironmentId.make("outro"), title: "Outro" },
  ]) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));

const mostrar = (panel: EditaiiPanel) =>
  act(async () => appAtomRegistry.set(state.panel, AsyncResult.success(panel)));
/** The page for this environment, showing `panel`, with commands that succeed. */
const abrir = async (panel: EditaiiPanel) => {
  state.disconnect.mockReset().mockResolvedValue(AsyncResult.success("disconnected"));
  state.chooseProject.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  await mostrar(panel);
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <EditaiiSettings />
    </RegistryContext.Provider>,
  );
};

describe("EditaiiSettings", () => {
  it("asks before disconnecting, showing the work under way and what disconnecting means", async () => {
    await using _screen = await abrir(conectado);
    await expect
      .element(page.getByText("Waiting for an answer in Editaii").first())
      .toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Disconnect" }));

    const dialog = page.getByRole("alertdialog");
    await expect.element(dialog.getByText("2 updates not yet returned to Editaii")).toBeVisible();
    await expect.element(dialog.getByText("Blocked: its T3 thread was lost")).toBeVisible();
    await expect
      .element(dialog.getByRole("link", { name: "Open thread" }))
      .toHaveAttribute("href", "/escritorio/thread-1");
    await expect.element(dialog.getByText(/keep running/)).toBeVisible();
    await expect.element(dialog.getByText(/Revoke it there/)).toBeVisible();
    expect(state.disconnect).not.toHaveBeenCalled();

    await userEvent.click(dialog.getByRole("button", { name: "Disconnect" }));
    expect(state.disconnect).toHaveBeenCalledWith({
      environmentId,
      input: {
        target: {
          type: "link",
          origin: "https://editaii.example",
          machineId: "maquina-1",
          environmentId: "ambiente-1",
        },
      },
    });
  });

  it("says when the work under way cannot be verified, and why requests wait", async () => {
    await using _screen = await abrir({
      ...conectado,
      connector: { journal: "future_version" },
      activity: { type: "unavailable", link: LINK, reason: "future_version" },
    });
    await expect.element(page.getByText(/requests wait on this computer/)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Disconnect" }));
    await expect
      .element(page.getByRole("alertdialog").getByText(/Could not verify the Editaii work/))
      .toBeVisible();
  });

  it("the question goes away when the link it asked about is no longer the one shown", async () => {
    await using _screen = await abrir(conectado);
    await userEvent.click(page.getByRole("button", { name: "Disconnect" }));
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await mostrar({
      ...conectado,
      connection: { ...conectado.connection, machine: maquina("maquina-2") },
    });
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    expect(state.disconnect).not.toHaveBeenCalled();
  });

  it("a pairing attempt is cancelled at once, by the attempt shown", async () => {
    await using _screen = await abrir({
      ...conectado,
      connection: {
        ...conectado.connection,
        status: "pairing",
        machine: null,
        attempt: "tentativa-1",
      },
      activity: null,
    });
    await userEvent.click(page.getByRole("button", { name: "Cancel pairing" }));
    expect(state.disconnect).toHaveBeenCalledWith({
      environmentId,
      input: { target: { type: "attempt", attempt: "tentativa-1" } },
    });
  });

  it("chooses this computer's project for new conversations and says what is missing", async () => {
    await using _screen = await abrir({
      ...conectado,
      configuration: { type: "incomplete", reason: "no_model", projectTitle: "Licitações" },
    });
    await expect
      .element(page.getByText('Set a default model for "Licitações" in T3.'))
      .toBeVisible();
    await userEvent.click(page.getByRole("combobox"));
    await expect.element(page.getByRole("option", { name: "Rascunho" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("option", { name: "Outro" })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("option", { name: "Contratos" }));
    expect(state.chooseProject).toHaveBeenCalledWith({
      environmentId,
      input: { projectId: CONTRATOS },
    });
  });

  it("shows what new conversations run with once the project is ready", async () => {
    await using _screen = await abrir(conectado);
    await expect.element(page.getByText(/New conversations run in Licitações with/)).toBeVisible();
    await expect.element(page.getByText(/full access/)).toBeVisible();
  });
});
