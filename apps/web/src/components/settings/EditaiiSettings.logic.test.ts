import type { EditaiiConnectionState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  configurationProblem,
  describeJob,
  sameTarget,
  shownTarget,
} from "./EditaiiSettings.logic";

const desconectada: EditaiiConnectionState = {
  status: "disconnected",
  origin: "https://editaii.example",
  machine: null,
  problem: null,
  canReopen: false,
  projectId: null,
  attempt: null,
};
const maquina = {
  id: "maquina-1",
  nome: "Escritório",
  dono: "pessoa@example.com",
  ambiente_t3: "ambiente-1",
  emitida_em: "2026-11-01T00:00:00.000Z",
  ativada_em: "2026-11-01T00:00:00.000Z",
  revogada_em: null,
};
const job = {
  jobId: "trabalho-1",
  conversationId: "conversa-1",
  threadId: null,
  state: "completed",
  pendingEvents: 0,
  held: false,
  receiptPending: false,
} as const;

describe("EditaiiSettings logic", () => {
  it("ends what is shown: the link, else the pairing attempt, else nothing", () => {
    const link = shownTarget({ ...desconectada, status: "connected", machine: maquina });
    expect(link).toEqual({
      type: "link",
      origin: "https://editaii.example",
      machineId: "maquina-1",
      environmentId: "ambiente-1",
    });
    expect(shownTarget({ ...desconectada, status: "pairing", attempt: "tentativa-1" })).toEqual({
      type: "attempt",
      attempt: "tentativa-1",
    });
    expect(shownTarget(desconectada)).toBeNull();
  });

  it("a different machine, environment or attempt is not the target shown", () => {
    const link = {
      type: "link",
      origin: "https://editaii.example",
      machineId: "maquina-1",
      environmentId: "ambiente-1",
    } as const;
    expect(sameTarget(link, { ...link })).toBe(true);
    expect(sameTarget(link, { ...link, machineId: "maquina-2" })).toBe(false);
    expect(sameTarget(link, { ...link, environmentId: "ambiente-2" })).toBe(false);
    expect(sameTarget(link, { type: "attempt", attempt: "maquina-1" })).toBe(false);
    expect(sameTarget({ type: "attempt", attempt: "a" }, { type: "attempt", attempt: "b" })).toBe(
      false,
    );
  });

  it("says why new conversations cannot start, and nothing when they can", () => {
    expect(
      configurationProblem({ type: "incomplete", reason: "no_project", projectTitle: null }),
    ).toContain("Choose a project");
    expect(
      configurationProblem({ type: "incomplete", reason: "project_missing", projectTitle: null }),
    ).toContain("no longer exists");
    expect(
      configurationProblem({ type: "incomplete", reason: "no_model", projectTitle: "Licitações" }),
    ).toContain('default model for "Licitações"');
    expect(
      configurationProblem({
        type: "incomplete",
        reason: "provider_disabled",
        projectTitle: "Licitações",
      }),
    ).toContain("disabled");
    expect(configurationProblem({ type: "unavailable", reason: "read_error" })).toContain(
      "Could not read",
    );
  });

  it("tells a job's state, then what it still owes Editaii", () => {
    expect(describeJob(job)).toEqual({ state: "Completed", owed: [] });
    expect(
      describeJob({
        ...job,
        state: "waiting_for_person",
        receiptPending: true,
        pendingEvents: 2,
        held: true,
      }),
    ).toEqual({
      state: "Waiting for an answer in Editaii",
      owed: [
        "Editaii has not been told it started",
        "2 updates not yet returned to Editaii",
        "Returns are paused: Editaii refused an update",
      ],
    });
    expect(describeJob({ ...job, pendingEvents: 1 }).owed).toEqual([
      "1 update not yet returned to Editaii",
    ]);
  });
});
