// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  type OrchestrationV2UserInputQuestion,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as EditaiiJournal from "./EditaiiJournal.ts";
import type * as Protocol from "./EditaiiProtocol.ts";
import type * as Adapter from "./EditaiiT3Adapter.ts";

/** A state dir of its own, removed at the end; `arquivo` is where the journal lives in it. */
const ambiente = Effect.gen(function* () {
  const base = yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-editaii-journal-"))),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );
  const config = ServerConfig.layerTest(process.cwd(), base).pipe(
    Layer.provide(NodeServices.layer),
  );
  const { stateDir } = yield* Effect.service(ServerConfig.ServerConfig).pipe(
    Effect.provide(config),
  );
  return {
    arquivo: NodePath.join(stateDir, "editaii.sqlite"),
    stateDir,
    abrir: <A, E>(efeito: Effect.Effect<A, E, EditaiiJournal.EditaiiJournal>) =>
      efeito.pipe(
        Effect.provide(
          EditaiiJournal.layer.pipe(Layer.provide(Layer.merge(config, NodeServices.layer))),
        ),
      ),
  };
});

/** Each call opens the journal afresh, as a T3 restart does. */
const usar = <A, E>(
  a: Effect.Success<typeof ambiente>,
  f: (j: EditaiiJournal.EditaiiJournalShape) => Effect.Effect<A, E>,
) => a.abrir(Effect.flatMap(Effect.service(EditaiiJournal.EditaiiJournal), f));

const ler = <T>(arquivo: string, consulta: string): T[] => {
  const db = new NodeSqlite.DatabaseSync(arquivo);
  try {
    return db.prepare(consulta).all() as T[];
  } finally {
    db.close();
  }
};
const versao = (arquivo: string) =>
  ler<{ user_version: number }>(arquivo, "PRAGMA user_version")[0]?.user_version;
const tabelas = (arquivo: string) =>
  ler<{ name: string }>(arquivo, "SELECT name FROM sqlite_schema WHERE type = 'table'")
    .map((t) => t.name)
    .toSorted();
const preparar = (stateDir: string, arquivo: string, comandos: string) => {
  NodeFS.mkdirSync(stateDir, { recursive: true });
  const db = new NodeSqlite.DatabaseSync(arquivo);
  db.exec(comandos);
  db.close();
};

describe("EditaiiJournal format", () => {
  it.effect("opens its own WAL file at the current version, and reopens it as it is", () => {
    return Effect.gen(function* () {
      const a = yield* ambiente;
      yield* a.abrir(Effect.void);
      yield* a.abrir(Effect.void);
      assert.equal(
        ler<{ journal_mode: string }>(a.arquivo, "PRAGMA journal_mode")[0]?.journal_mode,
        "wal",
      );
      assert.equal(versao(a.arquivo), 1);
      assert.deepEqual(tabelas(a.arquivo), [
        "conversas",
        "desligamentos",
        "entregas",
        "eventos",
        "pendencias",
        "trabalhos",
        "vinculos",
      ]);
    }).pipe(Effect.scoped);
  });

  it.effect("a journal from a newer T3 fails visibly and stays as it was", () => {
    return Effect.gen(function* () {
      const a = yield* ambiente;
      preparar(a.stateDir, a.arquivo, "CREATE TABLE futuro (x); PRAGMA user_version = 2;");
      const exit = yield* Effect.exit(a.abrir(Effect.void));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "future_version");
      assert.equal(versao(a.arquivo), 2);
      assert.deepEqual(tabelas(a.arquivo), ["futuro"]);
    }).pipe(Effect.scoped);
  });

  it.effect("an interrupted upgrade leaves the previous version whole", () => {
    return Effect.gen(function* () {
      const a = yield* ambiente;
      // The upgrade fails halfway, when it reaches a table that is already there.
      preparar(a.stateDir, a.arquivo, "CREATE TABLE eventos (x);");
      const exit = yield* Effect.exit(a.abrir(Effect.void));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "storage");
      assert.equal(versao(a.arquivo), 0);
      assert.deepEqual(tabelas(a.arquivo), ["eventos"]);
    }).pipe(Effect.scoped);
  });
});

const V1 = { origem: "https://editaii.example", maquina: "maquina-1", ambiente: "ambiente-1" };
const V2 = { ...V1, maquina: "maquina-2" };
const pronta: EditaiiJournal.Configuracao = {
  type: "pronta",
  projectId: ProjectId.make("projeto"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "modelo" },
  runtimeMode: "full-access",
  interactionMode: "default",
};
const indisponivel: EditaiiJournal.Configuracao = {
  type: "indisponivel",
  motivo: "Escolha um projeto do T3 para o Editaii.",
};

const pedido = (
  n: number,
  conversa: Partial<Protocol.Conversa> = {},
  texto = `Pedido ${n}`,
): Protocol.EntregaPedido => ({
  versao: 1,
  entrega_id: `entrega-${n}`,
  tipo: "pedido",
  trabalho_id: `trabalho-${n}`,
  conversa: { id: "conversa-1", geracao: 1, thread_t3: null, ...conversa },
  edital: { id: "edital-1", revisao: 1, ficha: { objeto: "Sistema" } },
  contexto: [],
  pedido: { mensagem_id: `mensagem-${n}`, seq: n, autor_nome: "Pessoa", texto },
});
const resposta = (
  n: number,
  trabalho: number,
  referencia: string,
  respostas: Protocol.Respostas,
  // The Worker sends the conversation's thread, which its first request associated.
  thread: string,
): Protocol.EntregaResposta => ({
  versao: 1,
  entrega_id: `resposta-${n}`,
  tipo: "resposta",
  trabalho_id: `trabalho-${trabalho}`,
  conversa: { id: "conversa-1", geracao: 1, thread_t3: thread },
  intervencao: { id: `intervencao-${n}`, referencia, respostas },
});
const aceitacao = (plano: Adapter.RequestPlan): Adapter.Acceptance => ({
  threadId: plano.threadId,
  messageId: plano.messageId,
  runId: RunId.make(`run:${plano.commandId}`),
  commandIds: [plano.commandId],
});

let sequence = 0;
const origem = (key: string) => ({ sequence: ++sequence, key });
const run = RunId.make("run");
const pergunta = (id = "q", options: OrchestrationV2UserInputQuestion["options"] = []) => ({
  id,
  header: "Proposta",
  question: `Pergunta ${id}?`,
  options,
});
const question = (
  requestId: string,
  capability: "live" | "message" | "not_resumable" = "live",
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion> = [pergunta()],
): Adapter.Observation => ({
  ...origem(`q:${requestId}:${capability}`),
  type: "question",
  runId: run,
  requestId: RuntimeRequestId.make(requestId),
  questions,
  capability,
});
const approval = (requestId: string): Adapter.Observation => ({
  ...origem(`a:${requestId}`),
  type: "approval",
  runId: run,
  requestId: RuntimeRequestId.make(requestId),
  description: `Aprovar ${requestId}`,
  capability: "live",
});
const resolved = (
  requestId: string,
  status: "resolved" | "cancelled" | "expired" = "resolved",
): Adapter.Observation => ({
  ...origem(`r:${requestId}`),
  type: "resolved",
  requestId: RuntimeRequestId.make(requestId),
  status,
});
const perdida = (): Adapter.Observation => ({
  ...origem("lost"),
  type: "thread_lost",
  reason: "cursor",
});
const answer = (text: string): Adapter.Observation => ({
  ...origem("answer"),
  type: "answer",
  runId: run,
  text,
  messageId: MessageId.make("answer"),
});
const failure = (message: string): Adapter.Observation => ({
  ...origem("failure"),
  type: "failure",
  runId: run,
  reason: "run-ended",
  message,
});

const executar = (passo: EditaiiJournal.Passo) => {
  if (passo.type !== "executar") throw new Error(`expected executar, got ${passo.type}`);
  return passo.execucao;
};
const planoDoPedido = (passo: EditaiiJournal.Passo) => {
  const execucao = executar(passo);
  if (execucao.tipo !== "pedido") throw new Error("expected a request");
  return execucao.plano;
};
/** A request through to its confirmed start, as the connector drives it. */
const iniciar = (j: EditaiiJournal.EditaiiJournalShape, v = V1, entrega = pedido(1)) =>
  Effect.gen(function* () {
    const plano = planoDoPedido(yield* j.receber(v, entrega, pronta));
    yield* j.resolver(v, entrega.entrega_id, { tipo: "aceita", aceitacao: aceitacao(plano) });
    const observado = yield* j.confirmada(v, entrega.entrega_id, "ok");
    return { plano, observado };
  });
/** Sends everything owed, as the Worker would take it, and says what went. */
const enviar = (j: EditaiiJournal.EditaiiJournalShape, v = V1) =>
  Effect.gen(function* () {
    const enviados: Array<Protocol.Evento> = [];
    for (;;) {
      const evento = yield* j.proximoEvento(v);
      if (evento === null) return enviados;
      enviados.push(evento);
      yield* j.eventoEnviado(v, evento, "ok");
    }
  });
const tipos = (eventos: ReadonlyArray<Protocol.Evento>) =>
  eventos.map((e) => `${e.trabalho_id}:${e.sequencia}:${e.tipo}`);

describe("EditaiiJournal deliveries", () => {
  it.effect("a request is frozen and marked invoked once; only its receipt starts the job", () =>
    Effect.gen(function* () {
      const a = yield* ambiente;
      const plano = yield* usar(a, (j) =>
        j.receber(V1, pedido(1), pronta).pipe(Effect.map(planoDoPedido)),
      );
      assert.isNotNull(plano.newThread);
      assert.include(plano.text, "Pedido 1");
      // Repeated after a restart, with other settings: the same plan, only to inspect.
      const repetida = yield* usar(a, (j) => j.receber(V1, pedido(1), indisponivel));
      assert.deepEqual(repetida, {
        type: "inspecionar",
        execucao: { tipo: "pedido", entregaId: "entrega-1", plano },
      });

      const recibo: Protocol.Recibo = {
        thread: plano.threadId,
        mensagem: plano.messageId,
        run: `run:${plano.commandId}`,
        comandos: [plano.commandId],
      };
      yield* usar(a, (j) =>
        Effect.gen(function* () {
          const passo = yield* j.resolver(V1, "entrega-1", {
            tipo: "aceita",
            aceitacao: aceitacao(plano),
          });
          assert.deepEqual(passo, { type: "confirmar", entregaId: "entrega-1", recibo });
          assert.deepEqual(yield* j.receber(V1, pedido(1), pronta), passo);
          // Before the receipt, the Worker takes no other event of the job.
          assert.isNull(yield* j.proximoEvento(V1));
          const observado = yield* j.confirmada(V1, "entrega-1", "ok");
          assert.deepEqual(observado, {
            trabalhoId: "trabalho-1",
            aceitacao: aceitacao(plano),
            cursor: null,
          });
          assert.isNull(yield* j.confirmada(V1, "entrega-1", "ok"));
          // The conversation's next request continues its thread, with the thread's own settings.
          const seguinte = planoDoPedido(
            yield* j.receber(V1, pedido(2, { thread_t3: plano.threadId }), indisponivel),
          );
          assert.strictEqual(seguinte.threadId, plano.threadId);
          assert.isNull(seguinte.newThread);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a delivery that comes back with other content is a conflict and overwrites nothing; links stay apart",
    () =>
      Effect.gen(function* () {
        const a = yield* ambiente;
        yield* usar(a, (j) =>
          Effect.gen(function* () {
            const plano = planoDoPedido(yield* j.receber(V1, pedido(1), pronta));
            const exit = yield* Effect.exit(j.receber(V1, pedido(1, {}, "Outro texto"), pronta));
            assert.include(String(exit), "conflict");
            assert.deepEqual(executarOuInspecionar(yield* j.receber(V1, pedido(1), pronta)), plano);
            // The same remote ids under another link are another delivery, with other T3 ids.
            const outro = planoDoPedido(yield* j.receber(V2, pedido(1), pronta));
            assert.notStrictEqual(outro.threadId, plano.threadId);
            assert.notStrictEqual(outro.commandId, plano.commandId);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a conversation the Worker and the journal disagree on stops, and runs nothing more",
    () =>
      Effect.gen(function* () {
        const a = yield* ambiente;
        yield* usar(a, (j) =>
          Effect.gen(function* () {
            const { plano } = yield* iniciar(j);
            yield* j.observar(V1, "trabalho-1", answer("Pronto"));
            // Another generation of a known conversation: no thread swap in this pass.
            assert.deepEqual(
              yield* j.receber(V1, pedido(2, { geracao: 2, thread_t3: plano.threadId }), pronta),
              { type: "aguardar" },
            );
            // Stopped, even for an envelope that agrees.
            assert.deepEqual(
              yield* j.receber(V1, pedido(3, { thread_t3: plano.threadId }), pronta),
              { type: "aguardar" },
            );
            // A thread the journal never associated.
            assert.deepEqual(
              yield* j.receber(V1, pedido(4, { id: "conversa-2", thread_t3: "alheia" }), pronta),
              { type: "aguardar" },
            );
            assert.deepEqual(tipos(yield* enviar(j)), [
              "trabalho-1:1:resposta",
              "trabalho-2:1:thread_perdida",
              "trabalho-3:1:thread_perdida",
              "trabalho-4:1:thread_perdida",
            ]);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "without an acceptance: refused fails, a missing thread or uncertainty stops, no settings fail before the T3",
    () =>
      Effect.gen(function* () {
        const a = yield* ambiente;
        yield* usar(a, (j) =>
          Effect.gen(function* () {
            yield* j.receber(V1, pedido(1), pronta);
            assert.deepEqual(yield* j.resolver(V1, "entrega-1", { tipo: "recusada" }), {
              type: "aguardar",
            });
            yield* j.receber(V1, pedido(2, { id: "conversa-2" }), pronta);
            yield* j.resolver(V1, "entrega-2", { tipo: "incerta" });
            assert.deepEqual(yield* j.receber(V1, pedido(3, { id: "conversa-2" }), pronta), {
              type: "aguardar",
            });
            yield* j.receber(V1, pedido(4, { id: "conversa-3" }), pronta);
            yield* j.resolver(V1, "entrega-4", { tipo: "thread_ausente" });
            assert.deepEqual(yield* j.receber(V1, pedido(5, { id: "conversa-4" }), indisponivel), {
              type: "aguardar",
            });
            const enviados = yield* enviar(j);
            assert.deepEqual(tipos(enviados), [
              "trabalho-1:1:falha",
              "trabalho-2:1:thread_perdida",
              "trabalho-3:1:thread_perdida",
              "trabalho-4:1:thread_perdida",
              "trabalho-5:1:falha",
            ]);
            assert.deepEqual(enviados.at(-1), {
              id: "editaii:trabalho-5:1",
              trabalho_id: "trabalho-5",
              sequencia: 1,
              tipo: "falha",
              motivo: indisponivel.type === "indisponivel" ? indisponivel.motivo : "",
            });
            // An outcome of the other kind, or another outcome later, is refused.
            assert.include(
              String(yield* Effect.exit(j.resolver(V1, "entrega-1", { tipo: "superada" }))),
              "conflict",
            );
            assert.include(
              String(yield* Effect.exit(j.resolver(V1, "entrega-1", { tipo: "incerta" }))),
              "conflict",
            );
            yield* j.receber(V1, pedido(6, { id: "conversa-5" }), pronta);
            const comando = CommandId.make("comando");
            assert.include(
              String(
                yield* Effect.exit(j.resolver(V1, "entrega-6", { tipo: "respondida", comando })),
              ),
              "conflict",
            );
            assert.strictEqual(
              (yield* j.receber(V1, pedido(6, { id: "conversa-5" }), pronta)).type,
              "inspecionar",
            );
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "after a restart, an invoked delivery is only inspected; receipts and followed jobs come back",
    () =>
      Effect.gen(function* () {
        const a = yield* ambiente;
        const plano = yield* usar(a, (j) =>
          j.receber(V1, pedido(1), pronta).pipe(Effect.map(planoDoPedido)),
        );
        assert.strictEqual(
          (yield* usar(a, (j) => j.receber(V1, pedido(1), pronta))).type,
          "inspecionar",
        );
        yield* usar(a, (j) =>
          j.resolver(V1, "entrega-1", { tipo: "aceita", aceitacao: aceitacao(plano) }),
        );
        const antes = yield* usar(a, (j) => j.partida(V1));
        assert.deepEqual(antes.type === "retomar" ? antes.confirmar.map((c) => c.entregaId) : [], [
          "entrega-1",
        ]);
        yield* usar(a, (j) => j.confirmada(V1, "entrega-1", "ok"));
        yield* usar(a, (j) => j.observar(V1, "trabalho-1", question("X")));
        const depois = yield* usar(a, (j) => j.partida(V1));
        assert.deepEqual(depois, {
          type: "retomar",
          confirmar: [],
          observar: [{ trabalhoId: "trabalho-1", aceitacao: aceitacao(plano), cursor: sequence }],
        });
      }).pipe(Effect.scoped),
  );

  it.effect("a receipt the Worker refuses stops the job and its conversation, for good", () =>
    Effect.gen(function* () {
      const a = yield* ambiente;
      yield* usar(a, (j) =>
        Effect.gen(function* () {
          const plano = planoDoPedido(yield* j.receber(V1, pedido(1), pronta));
          yield* j.resolver(V1, "entrega-1", { tipo: "aceita", aceitacao: aceitacao(plano) });
          assert.isNull(yield* j.confirmada(V1, "entrega-1", "conflito"));
        }),
      );
      // After a restart the refused receipt is not sent again, not even if the delivery comes back.
      const partida = yield* usar(a, (j) => j.partida(V1));
      assert.deepEqual(partida, { type: "retomar", confirmar: [], observar: [] });
      yield* usar(a, (j) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* j.receber(V1, pedido(1), pronta), { type: "aguardar" });
          assert.strictEqual(yield* j.observar(V1, "trabalho-1", answer("Pronto")), "fim");
          assert.deepEqual(yield* j.receber(V1, pedido(2), pronta), { type: "aguardar" });
          assert.deepEqual(tipos(yield* enviar(j)), ["trabalho-2:1:thread_perdida"]);
          const outro = yield* Effect.flip(j.confirmada(V1, "entrega-1", "ok"));
          assert.strictEqual(outro.reason, "conflict");
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "after a restart, a conversation goes on only once the T3 is seen to still have its last job",
    () =>
      Effect.gen(function* () {
        const a = yield* ambiente;
        const plano = yield* usar(a, (j) =>
          Effect.gen(function* () {
            const { plano } = yield* iniciar(j);
            yield* j.observar(V1, "trabalho-1", answer("Pronto"));
            // Seen ending in this period: the conversation goes on at once.
            const seguinte = pedido(2, { thread_t3: plano.threadId });
            assert.strictEqual((yield* j.receber(V1, seguinte, pronta)).type, "executar");
            return plano;
          }),
        );
        yield* usar(a, (j) =>
          Effect.gen(function* () {
            yield* j.resolver(V1, "entrega-2", { tipo: "recusada" });
            yield* enviar(j);
            yield* j.partida(V1);
            const terceiro = pedido(3, { thread_t3: plano.threadId });
            // Job 2 never reached the T3, so job 1 is the base to check.
            const conferir: EditaiiJournal.Passo = {
              type: "conferir",
              observado: {
                trabalhoId: "trabalho-1",
                aceitacao: aceitacao(plano),
                cursor: sequence,
              },
            };
            assert.deepEqual(yield* j.receber(V1, terceiro, pronta), conferir);
            assert.deepEqual(yield* j.receber(V1, terceiro, pronta), conferir);
            assert.strictEqual(yield* j.observar(V1, "trabalho-1", answer("Pronto")), "fim");
            assert.strictEqual((yield* j.receber(V1, terceiro, pronta)).type, "executar");
            // Its result stays as it was.
            assert.deepEqual(tipos(yield* enviar(j)), []);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("a conversation whose last job the T3 lost stops; that job's result stays", () =>
    Effect.gen(function* () {
      const a = yield* ambiente;
      const plano = yield* usar(a, (j) =>
        Effect.gen(function* () {
          const { plano } = yield* iniciar(j);
          yield* j.observar(V1, "trabalho-1", answer("Pronto"));
          yield* enviar(j);
          return plano;
        }),
      );
      yield* usar(a, (j) =>
        Effect.gen(function* () {
          yield* j.partida(V1);
          const seguinte = pedido(2, { thread_t3: plano.threadId });
          assert.strictEqual((yield* j.receber(V1, seguinte, pronta)).type, "conferir");
          assert.strictEqual(yield* j.observar(V1, "trabalho-1", perdida()), "fim");
          assert.deepEqual(yield* j.receber(V1, seguinte, pronta), { type: "aguardar" });
          assert.deepEqual(tipos(yield* enviar(j)), ["trabalho-2:1:thread_perdida"]);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { fim: "answer", observacao: () => answer("Pronto") },
    { fim: "failure", observacao: () => failure("Caiu") },
  ])("a job seen ending by its $fim lets its conversation go on at once", ({ observacao }) =>
    Effect.gen(function* () {
      const a = yield* ambiente;
      yield* usar(a, (j) =>
        Effect.gen(function* () {
          yield* j.partida(V1);
          const { plano } = yield* iniciar(j);
          yield* j.observar(V1, "trabalho-1", observacao());
          const seguinte = pedido(2, { thread_t3: plano.threadId });
          assert.strictEqual((yield* j.receber(V1, seguinte, pronta)).type, "executar");
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("after a restart, the job checked is the conversation's latest one the T3 took", () =>
    Effect.gen(function* () {
      const a = yield* ambiente;
      const plano = yield* usar(a, (j) =>
        Effect.gen(function* () {
          const { plano } = yield* iniciar(j);
          yield* j.observar(V1, "trabalho-1", answer("Um"));
          yield* iniciar(j, V1, pedido(2, { thread_t3: plano.threadId }));
          yield* j.observar(V1, "trabalho-2", answer("Dois"));
          yield* enviar(j);
          return plano;
        }),
      );
      yield* usar(a, (j) =>
        Effect.gen(function* () {
          yield* j.partida(V1);
          const passo = yield* j.receber(V1, pedido(3, { thread_t3: plano.threadId }), pronta);
          assert.strictEqual(passo.type === "conferir" && passo.observado.trabalhoId, "trabalho-2");
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("an answer that disagrees with its conversation after the job ended stops it", () =>
    Effect.gen(function* () {
      const a = yield* ambiente;
      yield* usar(a, (j) =>
        Effect.gen(function* () {
          const { plano } = yield* iniciar(j);
          yield* j.observar(V1, "trabalho-1", question("X"));
          yield* j.observar(V1, "trabalho-1", answer("Pronto"));
          yield* enviar(j);
          const tardia = resposta(1, 1, "X", { p1: { texto: "ok" } }, "outra-thread");
          assert.deepEqual(yield* j.receber(V1, tardia, pronta), { type: "aguardar" });
          // The job's result stays; the next request finds the conversation stopped.
          assert.deepEqual(tipos(yield* enviar(j)), []);
          const seguinte = pedido(2, { thread_t3: plano.threadId });
          assert.deepEqual(yield* j.receber(V1, seguinte, pronta), { type: "aguardar" });
          assert.deepEqual(tipos(yield* enviar(j)), ["trabalho-2:1:thread_perdida"]);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("an answer for another conversation, generation or thread never reaches the T3", () =>
    Effect.gen(function* () {
      for (const conversa of [
        { id: "outra" },
        { geracao: 2 },
        { thread_t3: "outra-thread" },
      ] satisfies Array<Partial<Protocol.Conversa>>) {
        const a = yield* ambiente;
        yield* usar(a, (j) =>
          Effect.gen(function* () {
            const { plano } = yield* iniciar(j);
            yield* j.observar(V1, "trabalho-1", question("X"));
            const certa = resposta(1, 1, "X", { p1: { texto: "ok" } }, plano.threadId);
            const errada = { ...certa, conversa: { ...certa.conversa, ...conversa } };
            assert.deepEqual(yield* j.receber(V1, errada, pronta), { type: "aguardar" });
            assert.deepEqual(tipos(yield* enviar(j)), [
              "trabalho-1:1:intervencao",
              "trabalho-1:2:thread_perdida",
            ]);
            const seguinte = pedido(2, { thread_t3: plano.threadId });
            assert.deepEqual(yield* j.receber(V1, seguinte, pronta), { type: "aguardar" });
          }),
        );
      }
    }).pipe(Effect.scoped),
  );
});

const executarOuInspecionar = (passo: EditaiiJournal.Passo) => {
  if (passo.type !== "executar" && passo.type !== "inspecionar") throw new Error(passo.type);
  return passo.execucao.plano;
};

describe("EditaiiJournal requests", () => {
  it.effect(
    "requests queue durably: one is waited on, they close by explicit facts only, and never reopen",
    () =>
      Effect.gen(function* () {
        const a = yield* ambiente;
        yield* usar(a, (j) =>
          Effect.gen(function* () {
            yield* iniciar(j);
            yield* j.observar(V1, "trabalho-1", question("X"));
            yield* j.observar(V1, "trabalho-1", question("Y"));
            // Only Y changes; X is still the one waited on.
            yield* j.observar(V1, "trabalho-1", question("Y", "message"));
            assert.deepEqual(tipos(yield* enviar(j)), ["trabalho-1:1:intervencao"]);
          }),
        );
        yield* usar(a, (j) =>
          Effect.gen(function* () {
            yield* j.observar(V1, "trabalho-1", resolved("X"));
            // Late facts about X change nothing.
            yield* j.observar(V1, "trabalho-1", question("X"));
            yield* j.observar(V1, "trabalho-1", resolved("X", "cancelled"));
            const enviados = yield* enviar(j);
            assert.deepEqual(tipos(enviados), [
              "trabalho-1:2:retomado",
              "trabalho-1:3:intervencao",
            ]);
            assert.deepInclude(enviados[1], { referencia: "Y" });
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("a request that closes while queued is never offered", () =>
    Effect.gen(function* () {
      const a = yield* ambiente;
      yield* usar(a, (j) =>
        Effect.gen(function* () {
          yield* iniciar(j);
          yield* j.observar(V1, "trabalho-1", question("X"));
          yield* j.observar(V1, "trabalho-1", approval("Y"));
          yield* j.observar(V1, "trabalho-1", resolved("Y", "expired"));
          yield* j.observar(V1, "trabalho-1", resolved("X", "cancelled"));
          assert.deepEqual(tipos(yield* enviar(j)), [
            "trabalho-1:1:intervencao",
            "trabalho-1:2:retomado",
          ]);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a question that can no longer be answered here becomes an action in the T3, as approvals are",
    () =>
      Effect.gen(function* () {
        const a = yield* ambiente;
        yield* usar(a, (j) =>
          Effect.gen(function* () {
            yield* iniciar(j);
            yield* j.observar(V1, "trabalho-1", question("X"));
            yield* j.observar(V1, "trabalho-1", approval("A"));
            yield* j.observar(V1, "trabalho-1", question("X", "not_resumable"));
            yield* j.observar(V1, "trabalho-1", resolved("X"));
            yield* j.observar(V1, "trabalho-1", resolved("A"));
            const enviados = yield* enviar(j);
            assert.deepEqual(tipos(enviados), [
              "trabalho-1:1:intervencao",
              "trabalho-1:2:retomado",
              "trabalho-1:3:acao_necessaria",
              "trabalho-1:4:retomado",
              "trabalho-1:5:acao_necessaria",
              "trabalho-1:6:retomado",
            ]);
            assert.deepInclude(enviados[4], { descricao: "Aprovar A" });
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("the Editaii's answer reaches the T3 as the exact values, and the wait ends once", () =>
    Effect.gen(function* () {
      const a = yield* ambiente;
      const questions = [
        pergunta("constructor", [
          { label: "Sim", description: "com valor", value: " sim " },
          { label: "Sim", description: "sem valor" },
        ]),
        {
          ...pergunta("__proto__", [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ]),
          multiSelect: true,
        },
        pergunta("livre", [{ label: "Sim", description: "rótulo" }]),
      ];
      yield* usar(a, (j) =>
        Effect.gen(function* () {
          const { plano } = yield* iniciar(j);
          yield* j.observar(V1, "trabalho-1", question("X", "live", questions));
          const [intervencao] = yield* enviar(j);
          assert.deepInclude(intervencao, {
            perguntas: [
              {
                id: "p1",
                titulo: "Proposta",
                pergunta: "Pergunta constructor?",
                opcoes: [
                  { id: "1", rotulo: "Sim", descricao: "com valor" },
                  { id: "2", rotulo: "Sim", descricao: "sem valor" },
                ],
                multipla: false,
                livre: true,
              },
              {
                id: "p2",
                titulo: "Proposta",
                pergunta: "Pergunta __proto__?",
                opcoes: [
                  { id: "1", rotulo: "A", descricao: "a" },
                  { id: "2", rotulo: "B", descricao: "b" },
                ],
                multipla: true,
                livre: true,
              },
              {
                id: "p3",
                titulo: "Proposta",
                pergunta: "Pergunta livre?",
                opcoes: [{ id: "1", rotulo: "Sim", descricao: "rótulo" }],
                multipla: false,
                livre: true,
              },
            ],
          });
          const entrega = resposta(
            1,
            1,
            "X",
            {
              p1: { opcoes: ["1"] },
              p2: { opcoes: ["2", "1"] },
              p3: { texto: "Sim" },
            },
            plano.threadId,
          );
          const execucao = executar(yield* j.receber(V1, entrega, pronta));
          if (execucao.tipo !== "resposta") throw new Error("expected an answer");
          assert.strictEqual(execucao.plano.threadId, plano.threadId);
          assert.strictEqual(execucao.plano.requestId, "X");
          assert.strictEqual(
            JSON.stringify(execucao.plano.answers),
            '{"constructor":" sim ","__proto__":["B","A"],"livre":"Sim"}',
          );
          const passo = yield* j.resolver(V1, entrega.entrega_id, {
            tipo: "respondida",
            comando: execucao.plano.commandId,
          });
          assert.deepEqual(passo, {
            type: "confirmar",
            entregaId: entrega.entrega_id,
            recibo: { comando: execucao.plano.commandId },
          });
          assert.isNull(yield* j.confirmada(V1, entrega.entrega_id, "ok"));
          yield* j.observar(V1, "trabalho-1", resolved("X"));
          yield* j.observar(V1, "trabalho-1", resolved("X"));
          assert.deepEqual(tipos(yield* enviar(j)), ["trabalho-1:2:retomado"]);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "an answer the run went on without never reaches the T3; one the T3 took elsewhere or cannot take ends the wait",
    () =>
      Effect.gen(function* () {
        const a = yield* ambiente;
        yield* usar(a, (j) =>
          Effect.gen(function* () {
            const { plano } = yield* iniciar(j);
            yield* j.observar(V1, "trabalho-1", question("X"));
            yield* j.observar(V1, "trabalho-1", question("Y"));
            yield* j.observar(V1, "trabalho-1", resolved("X"));
            // Y is now the one waited on; X's late answer must not answer it.
            assert.deepEqual(
              yield* j.receber(
                V1,
                resposta(1, 1, "X", { p1: { texto: "tarde" } }, plano.threadId),
                pronta,
              ),
              { type: "aguardar" },
            );

            const y = resposta(2, 1, "Y", { p1: { texto: "ok" } }, plano.threadId);
            executar(yield* j.receber(V1, y, pronta));
            assert.deepEqual(yield* j.resolver(V1, y.entrega_id, { tipo: "superada" }), {
              type: "aguardar",
            });
            // The T3's own report of the same closing adds nothing.
            yield* j.observar(V1, "trabalho-1", resolved("Y"));

            yield* j.observar(V1, "trabalho-1", question("Z"));
            const z = resposta(3, 1, "Z", { p1: { texto: "ok" } }, plano.threadId);
            executar(yield* j.receber(V1, z, pronta));
            yield* j.resolver(V1, z.entrega_id, { tipo: "nao_retomavel" });
            assert.strictEqual(yield* j.observar(V1, "trabalho-1", answer("tarde")), "fim");
            assert.deepEqual(tipos(yield* enviar(j)), [
              "trabalho-1:1:intervencao",
              "trabalho-1:2:retomado",
              "trabalho-1:3:intervencao",
              "trabalho-1:4:retomado",
              "trabalho-1:5:intervencao",
              "trabalho-1:6:falha",
            ]);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("an observation that fails midway leaves state, events and cursor as they were", () =>
    Effect.gen(function* () {
      const a = yield* ambiente;
      yield* usar(a, (j) =>
        Effect.gen(function* () {
          yield* iniciar(j);
          // An empty answer cannot become an event: the whole projection rolls back.
          const exit = yield* Effect.exit(j.observar(V1, "trabalho-1", answer("")));
          assert.isTrue(Exit.isFailure(exit));
          assert.deepEqual(yield* enviar(j), []);
          const partida = yield* j.partida(V1);
          assert.deepEqual(
            partida.type === "retomar" ? partida.observar.map((o) => o.cursor) : [],
            [null],
          );
          assert.strictEqual(yield* j.observar(V1, "trabalho-1", answer("Pronto")), "fim");
          assert.deepEqual(tipos(yield* enviar(j)), ["trabalho-1:1:resposta"]);
        }),
      );
    }).pipe(Effect.scoped),
  );
});

describe("EditaiiJournal outbox and disconnect", () => {
  it.effect(
    "each job in order, jobs in turn; a lost send repeats; a refusal holds only its job",
    () =>
      Effect.gen(function* () {
        const a = yield* ambiente;
        yield* usar(a, (j) =>
          Effect.gen(function* () {
            const um = yield* iniciar(j, V1, pedido(1));
            const dois = yield* iniciar(j, V1, pedido(2, { id: "conversa-2" }));
            yield* j.observar(V1, "trabalho-1", question("X"));
            yield* j.observar(V1, "trabalho-1", resolved("X"));
            yield* j.observar(V1, "trabalho-1", answer("Um"));
            yield* j.observar(V1, "trabalho-2", answer("Dois"));

            const primeiro = yield* j.proximoEvento(V1);
            assert.deepEqual(yield* j.proximoEvento(V1), primeiro);
            if (primeiro === null) throw new Error("expected an event");
            assert.strictEqual(tipos([primeiro])[0], "trabalho-1:1:intervencao");
            yield* j.eventoEnviado(V1, primeiro, "ok");
            // The job that has not sent yet goes next.
            const segundo = yield* j.proximoEvento(V1);
            if (segundo === null) throw new Error("expected an event");
            assert.strictEqual(tipos([segundo])[0], "trabalho-2:1:resposta");
            yield* j.eventoEnviado(V1, segundo, "ok");
            const terceiro = yield* j.proximoEvento(V1);
            if (terceiro === null) throw new Error("expected an event");
            assert.strictEqual(tipos([terceiro])[0], "trabalho-1:2:retomado");
            yield* j.eventoEnviado(V1, terceiro, "conflito");
            assert.isNull(yield* j.proximoEvento(V1));
            // Its conversation runs nothing more; the other one does.
            assert.deepEqual(
              yield* j.receber(V1, pedido(3, { thread_t3: um.plano.threadId }), pronta),
              { type: "aguardar" },
            );
            assert.strictEqual(
              (yield* j.receber(
                V1,
                pedido(4, { id: "conversa-2", thread_t3: dois.plano.threadId }),
                pronta,
              )).type,
              "executar",
            );
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "after the intent to disconnect, the link starts and sends nothing, also after a restart",
    () =>
      Effect.gen(function* () {
        const a = yield* ambiente;
        yield* usar(a, (j) =>
          Effect.gen(function* () {
            yield* iniciar(j, V1, pedido(1));
            yield* j.observar(V1, "trabalho-1", answer("Um"));
            const plano = planoDoPedido(
              yield* j.receber(V1, pedido(2, { id: "conversa-2" }), pronta),
            );
            yield* j.resolver(V1, "entrega-2", { tipo: "aceita", aceitacao: aceitacao(plano) });
            yield* j.desligar(V1);
            assert.isNull(yield* j.proximoEvento(V1));
            assert.deepEqual(yield* j.receber(V1, pedido(3, { id: "conversa-3" }), pronta), {
              type: "aguardar",
            });
            // Another link is not affected.
            assert.strictEqual((yield* j.receber(V2, pedido(1), pronta)).type, "executar");
          }),
        );
        assert.deepEqual(yield* usar(a, (j) => j.partida(V1)), { type: "desligar" });
        assert.isNull(yield* usar(a, (j) => j.proximoEvento(V1)));
      }).pipe(Effect.scoped),
  );
});
