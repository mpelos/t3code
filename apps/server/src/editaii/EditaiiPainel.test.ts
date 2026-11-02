import { assert, describe, it } from "@effect/vitest";
import {
  type ApplicationProjectEvent,
  type EditaiiConnectionState,
  type EditaiiJournalProblem,
  type EditaiiPanel,
  EventId,
  type Project,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Connection from "./EditaiiConnection.ts";
import * as Connector from "./EditaiiConnector.ts";
import * as Journal from "./EditaiiJournal.ts";
import * as Painel from "./EditaiiPainel.ts";

const ORIGIN = "https://editaii.example";
const AMBIENTE = "ambiente-1";
const PROJETO = ProjectId.make("projeto-editaii");
const GLOBAL = { instanceId: ProviderInstanceId.make("codex"), model: "global" };
const projeto: Project = {
  id: PROJETO,
  title: "Licitações",
  workspaceRoot: "/tmp/licitacoes",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  deletedAt: null,
};
const conectada = (maquina: string): EditaiiConnectionState => ({
  status: "connected",
  origin: ORIGIN,
  machine: {
    id: maquina,
    nome: "Escritório",
    dono: "pessoa@example.com",
    ambiente_t3: AMBIENTE,
    emitida_em: "2026-11-01T00:00:00.000Z",
    ativada_em: "2026-11-01T00:00:00.000Z",
    revogada_em: null,
  },
  problem: null,
  canReopen: false,
  projectId: PROJETO,
  attempt: null,
});
const vazia: Journal.Situacao = { desligando: false, trabalhos: [], conversasBloqueadas: [] };
const projetoApagado: ApplicationProjectEvent = {
  sequence: 1,
  eventId: EventId.make("evento-1"),
  aggregateKind: "project",
  aggregateId: PROJETO,
  occurredAt: "2026-11-02T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "project.deleted",
  payload: { projectId: PROJETO, deletedAt: "2026-11-02T00:00:00.000Z" },
};

/**
 * A T3 whose Editaii parts the test moves: the connection, the connector's problem, the
 * journal's version and situation, the projects and their events. `painel` follows the panel,
 * each emission in order.
 */
const maquina = Effect.gen(function* () {
  const conexao = yield* SubscriptionRef.make(conectada("maquina-1"));
  const problema = yield* SubscriptionRef.make<EditaiiJournalProblem | null>(null);
  const versao = yield* SubscriptionRef.make(0);
  const eventos = yield* Queue.unbounded<ApplicationProjectEvent>();
  const projetos = new Map([[PROJETO, projeto]]);
  const t = {
    projetosIlegiveis: false,
    situacao: (
      _v: Connection.EditaiiVinculo,
    ): Effect.Effect<Journal.Situacao, Journal.EditaiiJournalError> => Effect.succeed(vazia),
    desligado: true,
    desligados: [] as Array<Connection.EditaiiVinculo>,
    cancelados: [] as Array<string>,
  };
  const layer = Painel.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Connection.EditaiiConnection)({
          state: SubscriptionRef.get(conexao),
          changes: SubscriptionRef.changes(conexao),
          cancelPairing: (attempt) =>
            Effect.sync(() => {
              t.cancelados.push(attempt);
              return false;
            }),
        }),
        Layer.mock(Connector.EditaiiConnector)({
          problema: SubscriptionRef.changes(problema),
          desligar: (v) =>
            Effect.sync(() => {
              t.desligados.push(v);
              return t.desligado;
            }),
        }),
        Layer.mock(Journal.EditaiiJournal)({
          mudancas: SubscriptionRef.changes(versao),
          situacao: (v) => Effect.suspend(() => t.situacao(v)),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            t.projetosIlegiveis
              ? Effect.fail(
                  new ProjectService.ProjectOperationError({
                    operation: "read-project",
                    projectId: id,
                    cause: new Error("database locked"),
                  }),
                )
              : Effect.succeed(Option.fromUndefinedOr(projetos.get(id))),
        }),
        ServerSettings.ServerSettingsService.layerTest({ defaultModelSelection: GLOBAL }),
        Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
          latestApplicationSequence: Effect.succeed(0),
          streamApplicationEvents: () => Stream.fromQueue(eventos),
        }),
      ),
    ),
  );
  const painel = yield* Effect.service(Painel.EditaiiPainel).pipe(Effect.provide(layer));
  const emitidos = yield* Queue.unbounded<EditaiiPanel>();
  yield* painel.estado.pipe(
    Stream.runForEach((p) => Queue.offer(emitidos, p)),
    Effect.forkScoped,
  );
  /** Takes emissions in order until one satisfies `condicao`, and returns it. */
  const ate = (condicao: (p: EditaiiPanel) => boolean): Effect.Effect<EditaiiPanel> =>
    Queue.take(emitidos).pipe(Effect.filterOrElse(condicao, () => ate(condicao)));
  return {
    t,
    painel,
    conexao,
    problema,
    versao,
    eventos,
    projetos,
    proximo: Queue.take(emitidos),
    ate,
    mexerNoJournal: SubscriptionRef.update(versao, (n) => n + 1),
  };
});

describe("EditaiiPainel", () => {
  it.effect("reads the panel together, the activity for the link it shows", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      m.t.situacao = () =>
        Effect.succeed({
          desligando: false,
          trabalhos: [
            {
              trabalhoId: "trabalho-1",
              conversaId: "conversa-1",
              threadId: "thread-1",
              estado: "aguardando_pessoa",
              eventosPendentes: 2,
              retido: false,
              reciboPendente: false,
            },
          ],
          conversasBloqueadas: [{ conversaId: "conversa-2", threadId: null, bloqueio: "conflito" }],
        });
      yield* m.mexerNoJournal;
      const p = yield* m.ate((p) => p.activity?.type === "available" && p.activity.jobs.length > 0);
      assert.deepEqual(p.configuration, {
        type: "ready",
        projectId: PROJETO,
        projectTitle: "Licitações",
        modelSelection: GLOBAL,
        runtimeMode: "full-access",
      });
      assert.deepEqual(p.connector, { journal: null });
      assert.deepEqual(p.activity, {
        type: "available",
        link: { origin: ORIGIN, machineId: "maquina-1", environmentId: AMBIENTE },
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
        blockedConversations: [
          { conversationId: "conversa-2", threadId: null, reason: "conflict" },
        ],
      });
      // No machine connected: no activity to show.
      yield* SubscriptionRef.set(m.conexao, {
        ...conectada("maquina-1"),
        status: "disconnected",
        machine: null,
      });
      yield* m.ate((p) => p.connection.status === "disconnected" && p.activity === null);
    }).pipe(Effect.scoped),
  );

  it.effect("a part that cannot be read is shown as such, the rest still is, and it recovers", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      m.t.projetosIlegiveis = true;
      m.t.situacao = () =>
        Effect.fail(new Journal.EditaiiJournalError({ reason: "future_version", detail: "v99" }));
      yield* SubscriptionRef.set(m.problema, "future_version");
      const p = yield* m.ate((p) => p.connector.journal === "future_version");
      assert.deepEqual(p.configuration, { type: "unavailable", reason: "read_error" });
      assert.deepEqual(p.activity, {
        type: "unavailable",
        link: { origin: ORIGIN, machineId: "maquina-1", environmentId: AMBIENTE },
        reason: "future_version",
      });
      assert.strictEqual(p.connection.status, "connected");

      m.t.projetosIlegiveis = false;
      m.t.situacao = () => Effect.succeed(vazia);
      yield* m.mexerNoJournal;
      yield* m.ate((p) => p.configuration.type === "ready" && p.activity?.type === "available");
    }).pipe(Effect.scoped),
  );

  it.effect("deleting the chosen project shows it missing, with no other change", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      yield* m.ate((p) => p.configuration.type === "ready");
      m.projetos.delete(PROJETO);
      yield* Queue.offer(m.eventos, projetoApagado);
      const p = yield* m.ate((p) => p.configuration.type !== "ready");
      assert.deepEqual(p.configuration, {
        type: "incomplete",
        reason: "project_missing",
        projectTitle: null,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("a change that comes while it reads is read after it", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      yield* m.proximo;
      const lendo = yield* Deferred.make<void>();
      const solta = yield* Deferred.make<void>();
      m.t.situacao = () =>
        Deferred.succeed(lendo, undefined).pipe(
          Effect.andThen(Deferred.await(solta)),
          Effect.as(vazia),
        );
      yield* m.mexerNoJournal;
      yield* Deferred.await(lendo);
      m.t.situacao = () => Effect.succeed(vazia);
      yield* SubscriptionRef.set(m.problema, "storage");
      yield* Deferred.succeed(solta, undefined);
      yield* m.ate((p) => p.connector.journal === "storage");
    }).pipe(Effect.scoped),
  );

  it.effect("under steady journal activity it still shows each new state", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      // Every read finds the journal changed again, as during a long run.
      let leituras = 0;
      m.t.situacao = () =>
        m.mexerNoJournal.pipe(
          Effect.as({
            ...vazia,
            trabalhos: [
              {
                trabalhoId: "trabalho-1",
                conversaId: "conversa-1",
                threadId: null,
                estado: "em_execucao",
                eventosPendentes: ++leituras,
                retido: false,
                reciboPendente: false,
              },
            ],
          }),
        );
      const pendentes = (p: EditaiiPanel) =>
        p.activity?.type === "available" ? (p.activity.jobs[0]?.pendingEvents ?? 0) : 0;
      const vistos: Array<number> = [];
      while (vistos.length < 3) {
        const n = pendentes(yield* m.proximo);
        if (n > 0) vistos.push(n);
      }
      // Three readings, each of a newer state.
      assert.deepEqual(
        vistos,
        vistos.toSorted((a, b) => a - b),
      );
      assert.strictEqual(new Set(vistos).size, 3);
    }).pipe(Effect.scoped),
  );

  it.effect("the connection, activity and configuration shown come from the same reading", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      yield* m.proximo;
      const lendo = yield* Deferred.make<void>();
      const solta = yield* Deferred.make<void>();
      m.t.situacao = (v) =>
        v.maquina === "maquina-1"
          ? Deferred.succeed(lendo, undefined).pipe(
              Effect.andThen(Deferred.await(solta)),
              Effect.as(vazia),
            )
          : Effect.succeed(vazia);
      yield* m.mexerNoJournal;
      yield* Deferred.await(lendo);
      // Another machine and another project while the first one's activity is read.
      const outro = ProjectId.make("projeto-2");
      m.projetos.set(outro, { ...projeto, id: outro, title: "Contratos" });
      yield* SubscriptionRef.set(m.conexao, { ...conectada("maquina-2"), projectId: outro });
      yield* Deferred.succeed(solta, undefined);
      const coerente = (p: EditaiiPanel) => {
        assert.strictEqual(p.activity?.link.machineId, p.connection.machine?.id);
        assert.strictEqual(
          p.configuration.type === "ready" ? p.configuration.projectId : null,
          p.connection.projectId,
        );
        return p.connection.machine?.id === "maquina-2";
      };
      yield* m.ate(coerente);
    }).pipe(Effect.scoped),
  );

  it.effect("ends only what the person saw: the link, or the pairing attempt", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      const link = {
        type: "link",
        origin: ORIGIN,
        machineId: "maquina-1",
        environmentId: AMBIENTE,
      } as const;
      assert.strictEqual(yield* m.painel.desligar(link), "disconnected");
      m.t.desligado = false;
      assert.strictEqual(yield* m.painel.desligar(link), "not_current");
      assert.deepEqual(m.t.desligados, [
        { origem: ORIGIN, maquina: "maquina-1", ambiente: AMBIENTE },
        { origem: ORIGIN, maquina: "maquina-1", ambiente: AMBIENTE },
      ]);
      assert.strictEqual(
        yield* m.painel.desligar({ type: "attempt", attempt: "tentativa-1" }),
        "not_current",
      );
      assert.deepEqual(m.t.cancelados, ["tentativa-1"]);
    }).pipe(Effect.scoped),
  );
});
