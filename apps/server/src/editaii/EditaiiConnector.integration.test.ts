/**
 * The connector over the real T3: orchestrator, receipts, thread launch and management, with a
 * scripted provider (EditaiiT3Adapter.testkit.ts), and the strict fake Worker
 * (EditaiiConnector.testkit.ts). The T3's effect worker moves only when a test drains it, after
 * the mark that says there is work for it.
 */
import { assert, describe, it } from "@effect/vitest";
import { CommandId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as Maquinas from "./EditaiiConnector.testkit.ts";
import type * as Journal from "./EditaiiJournal.ts";
import * as T3 from "./EditaiiT3Adapter.testkit.ts";
import * as Adapter from "./EditaiiT3Adapter.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

const configuracao: Journal.Configuracao = {
  type: "pronta",
  projectId: T3.projectId,
  modelSelection: T3.modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
};

/** Runs `efeito` in the T3 a start built. */
const noT3 =
  <S>(t3: { readonly context: Context.Context<S> }) =>
  <A, E, R>(efeito: Effect.Effect<A, E, R>) =>
    efeito.pipe(Effect.provide(t3.context));

/**
 * The T3's adapter, counting the calls that change the T3: the T3 takes a repeated command as the
 * same one, so only here does a second call show.
 */
const contando = (chamadas: { accept: number; respond: number }) =>
  Layer.effect(
    Adapter.EditaiiT3Adapter,
    Effect.gen(function* () {
      const adapter = yield* Adapter.EditaiiT3Adapter;
      return Adapter.EditaiiT3Adapter.of({
        ...adapter,
        accept: (plano) =>
          Effect.suspend(() => {
            chamadas.accept += 1;
            return adapter.accept(plano);
          }),
        respond: (plano) =>
          Effect.suspend(() => {
            chamadas.respond += 1;
            return adapter.respond(plano);
          }),
      });
    }),
  );

/**
 * Request 1 runs on the T3 of `h` to its answer, the journal records that the Worker has it, and
 * the T3 stops. With `copia`, the T3's database is backed up there while the run is still live.
 * Says the turn and the thread's last event sequence.
 */
const primeiroPedido = Effect.fn("test.primeiroPedido")(function* (
  m: Maquinas.Maquina,
  h: Effect.Success<ReturnType<typeof T3.harness>>,
  copia?: string,
) {
  const t3 = yield* m.ligar(h.layer);
  const liberado = yield* noT3(t3)(h.release());
  m.worker.pedir(1);
  const turn = yield* noT3(t3)(h.beginTurn(liberado));
  yield* m.quando(() => m.worker.estado(1) === "em_execucao");
  if (copia !== undefined) {
    yield* noT3(t3)(SqlClient.SqlClient.use((sql) => sql`VACUUM INTO ${copia}`));
  }
  yield* noT3(t3)(h.finish(turn, "Um"));
  yield* m.quando(() => m.eventosGravados() === 1);
  const sequencia = yield* noT3(t3)(
    Orchestrator.OrchestratorV2.use((engine) => engine.getThreadEventSequence(turn.threadId)),
  );
  yield* t3.parar;
  return { turn, sequencia };
});

describe("EditaiiConnector over the real T3", () => {
  it.effect("a request, a question with native values and its answer, through to the result", () =>
    Effect.gen(function* () {
      const h = yield* T3.harness("editaii-connector-ponta");
      const m = yield* Maquinas.make(configuracao);
      const t3 = yield* m.ligar(h.layer);
      const worker = Context.get(t3.context, Worker.OrchestrationEffectWorkerV2);

      // Watch for the release before the person asks, so it cannot pass unseen.
      const liberado = yield* noT3(t3)(h.release());
      m.worker.pedir(1);
      const turn = yield* noT3(t3)(h.beginTurn(liberado));
      yield* m.quando(() => m.worker.estado(1) === "em_execucao");

      // Same labels, values with spaces: only the option ids tell them apart.
      yield* noT3(t3)(
        h.question(turn, "question", "escolha", [
          {
            id: "escolha",
            header: "Proposta",
            question: "Qual caminho?",
            options: [
              { label: "Sim", description: "Com espaços", value: "  sim, com espaços  " },
              { label: "Sim", description: "Sem espaços", value: "sim" },
            ],
            multiSelect: false,
            allowCustomAnswer: false,
          },
        ]),
      );
      yield* m.quando(() => m.worker.estado(1) === "aguardando_pessoa");
      const [intervencao] = m.worker.aplicados;
      assert.strictEqual(intervencao?.tipo, "intervencao");
      if (intervencao?.tipo !== "intervencao") return;
      const [pergunta] = intervencao.perguntas;
      assert.deepInclude(pergunta, { titulo: "Proposta", pergunta: "Qual caminho?" });
      assert.deepEqual(
        pergunta?.opcoes.map((o) => o.rotulo),
        ["Sim", "Sim"],
      );
      const primeira = pergunta?.opcoes[0]?.id;
      if (pergunta === undefined || primeira === undefined) return;

      m.worker.responder(1, { [pergunta.id]: { opcoes: [primeira] } });
      // The answer's receipt reached the Worker: the T3 took the answer.
      yield* m.quando(() => m.worker.estado(1) === "em_execucao");
      yield* worker.drain();
      assert.deepEqual(
        h.responses.map((r) => r.answers),
        [{ escolha: "  sim, com espaços  " }],
      );

      yield* noT3(t3)(h.finish(turn, "Pronto, com o caminho escolhido."));
      yield* m.quando(() => m.worker.estado(1) === "concluido");
      assert.deepEqual(Maquinas.tipos(m.worker.aplicados), [
        "trabalho-1:1:intervencao",
        "trabalho-1:2:retomado",
        "trabalho-1:3:resposta",
      ]);
      const resposta = m.worker.aplicados[2];
      assert.strictEqual(
        resposta?.tipo === "resposta" ? resposta.texto : undefined,
        "Pronto, com o caminho escolhido.",
      );
      // One receipt per delivery, the request's naming the T3's thread and run.
      const recibos = m.worker.confirmacoes.map((c) => ({ ...c, recibo: JSON.parse(c.recibo) }));
      assert.deepEqual(
        recibos.map((c) => c.entregaId),
        ["entrega-1", `resposta-${m.worker.trabalho(1)?.intervencao?.id}`],
      );
      assert.include(recibos[0]?.recibo, { thread: turn.threadId, run: turn.runId });
      assert.deepEqual(m.worker.invalidos, []);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "an approval is an action in the T3: once given there, the job goes on to its end",
    () =>
      Effect.gen(function* () {
        const h = yield* T3.harness("editaii-connector-aprovacao");
        const m = yield* Maquinas.make(configuracao);
        const t3 = yield* m.ligar(h.layer);
        const worker = Context.get(t3.context, Worker.OrchestrationEffectWorkerV2);
        const liberado = yield* noT3(t3)(h.release());
        m.worker.pedir(1);
        const turn = yield* noT3(t3)(h.beginTurn(liberado));
        yield* m.quando(() => m.worker.estado(1) === "em_execucao");

        const aprovacao = yield* noT3(t3)(h.question(turn, "approval", "a"));
        yield* m.quando(() => m.worker.estado(1) === "acao_no_t3");
        // The person approves in the T3, as its interface does.
        yield* noT3(t3)(
          Orchestrator.OrchestratorV2.use((engine) =>
            engine.dispatch({
              type: "runtime-request.respond",
              commandId: CommandId.make("aprovada-no-t3"),
              threadId: turn.threadId,
              requestId: aprovacao,
              decision: "accept",
            }),
          ),
        );
        yield* m.quando(() => m.worker.estado(1) === "em_execucao");
        yield* worker.drain();
        assert.deepEqual(
          h.responses.map((r) => r.decision),
          ["accept"],
        );

        yield* noT3(t3)(h.finish(turn, "Feito, com a aprovação."));
        yield* m.quando(() => m.worker.estado(1) === "concluido");
        assert.deepEqual(Maquinas.tipos(m.worker.aplicados), [
          "trabalho-1:1:acao_necessaria",
          "trabalho-1:2:retomado",
          "trabalho-1:3:resposta",
        ]);
        assert.deepEqual(m.worker.invalidos, []);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a question answered in the T3 first: the Editaii's answer calls nothing, and the next stays open",
    () =>
      Effect.gen(function* () {
        const h = yield* T3.harness("editaii-connector-superada");
        const m = yield* Maquinas.make(configuracao);
        const chamadas = { accept: 0, respond: 0 };
        const t3 = yield* m.ligar(contando(chamadas).pipe(Layer.provideMerge(h.layer)));
        const worker = Context.get(t3.context, Worker.OrchestrationEffectWorkerV2);
        const liberado = yield* noT3(t3)(h.release());
        m.worker.pedir(1);
        const turn = yield* noT3(t3)(h.beginTurn(liberado));
        yield* m.quando(() => m.worker.estado(1) === "em_execucao");
        const caminho = (id: string) => ({
          id,
          header: "Caminho",
          question: "Qual caminho?",
          options: [],
          allowCustomAnswer: true,
        });

        const pergunta = yield* noT3(t3)(h.question(turn, "question", "x", [caminho("x")]));
        yield* m.quando(() => m.worker.estado(1) === "aguardando_pessoa");
        const [intervencao] = m.worker.aplicados;
        if (intervencao?.tipo !== "intervencao") return assert.fail("expected the intervention");
        // The end of the wait is held from the Worker, which still serves the Editaii's answer.
        const retomado = yield* Maquinas.travarEventos(m, (e) => e.tipo === "retomado");
        const eventos = () => m.worker.chamadas.filter((c) => c === "maquina/eventos").length;
        const antes = eventos();
        yield* noT3(t3)(
          Orchestrator.OrchestratorV2.use((engine) =>
            engine.dispatch({
              type: "runtime-request.respond",
              commandId: CommandId.make("respondida-no-t3"),
              threadId: turn.threadId,
              requestId: pergunta,
              answers: { x: "pela T3" },
            }),
          ),
        );
        // The journal saw the T3 close it: the end of the wait is on its way.
        yield* m.quando(() => eventos() > antes);
        m.worker.responder(1, { [intervencao.perguntas[0]?.id ?? ""]: { texto: "pelo Editaii" } });
        // Settled without a receipt, the delivery waits for the event the Worker is owed.
        yield* m.pausa;
        yield* Deferred.succeed(retomado, undefined);
        yield* m.quando(() => m.worker.estado(1) === "em_execucao");
        yield* worker.drain();
        assert.deepEqual(chamadas, { accept: 1, respond: 0 });
        assert.deepEqual(
          h.responses.map((r) => r.answers),
          [{ x: "pela T3" }],
        );

        yield* noT3(t3)(h.question(turn, "question", "y", [caminho("y")]));
        yield* m.quando(() => m.worker.estado(1) === "aguardando_pessoa");
        assert.deepEqual(Maquinas.tipos(m.worker.aplicados), [
          "trabalho-1:1:intervencao",
          "trabalho-1:2:retomado",
          "trabalho-1:3:intervencao",
        ]);
        assert.strictEqual(m.worker.confirmacoes.length, 1);
        assert.deepEqual(m.worker.invalidos, []);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a T3 restart with a question pending: it is answered by message, and the job ends",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const h = yield* T3.harness("editaii-connector-reinicio", `${dir}/t3.sqlite`, {
          recoverOnStartup: true,
        });
        const m = yield* Maquinas.make(configuracao);
        const antes = yield* m.ligar(h.layer);
        const liberado = yield* noT3(antes)(h.release());
        m.worker.pedir(1);
        const turn = yield* noT3(antes)(h.beginTurn(liberado));
        yield* m.quando(() => m.worker.estado(1) === "em_execucao");
        yield* noT3(antes)(h.question(turn, "question", "x"));
        yield* m.quando(() => m.worker.estado(1) === "aguardando_pessoa");
        yield* antes.parar;

        // The T3 starts again on its file: the live run is gone, and the question is answered by
        // message. The Editaii still offers it.
        const depois = yield* m.ligar(h.layer);
        const [intervencao] = m.worker.aplicados;
        if (intervencao?.tipo !== "intervencao") return assert.fail("expected the intervention");
        m.worker.responder(
          1,
          Object.fromEntries(intervencao.perguntas.map((p) => [p.id, { texto: `sim, ${p.id}` }])),
        );
        // The answer's receipt reached the Worker: the T3 took the message.
        yield* m.quando(() => m.worker.estado(1) === "em_execucao");
        const continuacao = yield* noT3(depois)(h.nextTurn());
        assert.notStrictEqual(continuacao.runId, turn.runId);
        assert.deepEqual(h.responses, []);
        for (const p of intervencao.perguntas)
          assert.include(continuacao.message.text, `sim, ${p.id}`);

        yield* noT3(depois)(h.finish(continuacao, "Pronto, com a resposta por mensagem."));
        yield* m.quando(() => m.worker.estado(1) === "concluido");
        assert.deepEqual(Maquinas.tipos(m.worker.aplicados), [
          "trabalho-1:1:intervencao",
          "trabalho-1:2:retomado",
          "trabalho-1:3:resposta",
        ]);
        assert.deepEqual(m.worker.invalidos, []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "the connector alone fails after the T3 took the request, then the answer: reading decides",
    () =>
      Effect.gen(function* () {
        const h = yield* T3.harness("editaii-connector-queda");
        const m = yield* Maquinas.make(configuracao);
        const chamadas = { accept: 0, respond: 0 };
        const t3 = yield* m.ligar(contando(chamadas).pipe(Layer.provideMerge(h.layer)));
        const worker = Context.get(t3.context, Worker.OrchestrationEffectWorkerV2);
        const recibo = (n: number) => JSON.parse(m.worker.confirmacoes[n]?.recibo ?? "null");

        // The T3 takes the request and the journal fails to record it; the next period reads it.
        const liberado = yield* noT3(t3)(h.release());
        m.falhar.add("resolver");
        m.worker.pedir(1);
        yield* m.pausa;
        yield* m.quando(() => m.worker.estado(1) === "em_execucao");
        const turn = yield* noT3(t3)(h.beginTurn(liberado));
        assert.include(recibo(0), { thread: turn.threadId, run: turn.runId });

        yield* noT3(t3)(h.question(turn, "question", "x"));
        yield* m.quando(() => m.worker.estado(1) === "aguardando_pessoa");
        const [intervencao] = m.worker.aplicados;
        if (intervencao?.tipo !== "intervencao") return assert.fail("expected the intervention");
        // The same with the answer. The end of the wait the T3 shows is held from the Worker,
        // which serves an answer again only while it waits for it.
        const retomado = yield* Maquinas.travarEventos(m, (e) => e.tipo === "retomado");
        m.falhar.add("resolver");
        m.worker.responder(
          1,
          Object.fromEntries(intervencao.perguntas.map((p) => [p.id, { texto: `sim, ${p.id}` }])),
        );
        yield* m.pausa;
        yield* m.quando(() => m.worker.confirmacoes.length === 2);
        yield* Deferred.succeed(retomado, undefined);
        assert.isFalse(m.falhar.has("resolver"));
        yield* worker.drain();
        assert.deepEqual(chamadas, { accept: 1, respond: 1 });
        assert.strictEqual(h.responses.length, 1);
        const comando = recibo(1)?.comando;
        const tomado = yield* noT3(t3)(
          Receipts.CommandReceiptStoreV2.use((r) => r.getByCommandId(CommandId.make(comando))),
        );
        assert.isTrue(Option.isSome(tomado));

        yield* noT3(t3)(h.finish(turn, "Pronto."));
        yield* m.quando(() => m.worker.estado(1) === "concluido");
        const { projection } = yield* noT3(t3)(
          Orchestrator.OrchestratorV2.use((engine) => engine.getThreadSnapshot(turn.threadId)),
        );
        assert.deepEqual(
          projection.runs.map((r) => r.id),
          [turn.runId],
        );
        assert.strictEqual(yield* Queue.size(h.started), 0);
        assert.deepEqual(Maquinas.tipos(m.worker.aplicados), [
          "trabalho-1:1:intervencao",
          "trabalho-1:2:retomado",
          "trabalho-1:3:resposta",
        ]);
        assert.deepEqual(m.worker.invalidos, []);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a T3 restored to before an answered question stops the job, though its events went past",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const restaurado = `${dir}/restaurado.sqlite`;
        const h = yield* T3.harness("editaii-connector-respondida", `${dir}/t3.sqlite`, {
          recoverOnStartup: true,
        });
        const m = yield* Maquinas.make(configuracao);
        const t3 = yield* m.ligar(h.layer);
        const liberado = yield* noT3(t3)(h.release());
        m.worker.pedir(1);
        const turn = yield* noT3(t3)(h.beginTurn(liberado));
        yield* m.quando(() => m.worker.estado(1) === "em_execucao");
        yield* noT3(t3)(h.question(turn, "question", "x"));
        yield* m.quando(() => m.worker.estado(1) === "aguardando_pessoa");
        // The backup is taken with the question pending; the answer comes after it.
        yield* noT3(t3)(SqlClient.SqlClient.use((sql) => sql`VACUUM INTO ${restaurado}`));
        const [intervencao] = m.worker.aplicados;
        if (intervencao?.tipo !== "intervencao") return assert.fail("expected the intervention");
        m.worker.responder(
          1,
          Object.fromEntries(intervencao.perguntas.map((p) => [p.id, { texto: `sim, ${p.id}` }])),
        );
        // The Worker has the end of the wait: the journal saw the T3 close the question.
        yield* m.quando(() => m.eventosGravados() === 2);
        const sequencia = yield* noT3(t3)(
          Orchestrator.OrchestratorV2.use((engine) => engine.getThreadEventSequence(turn.threadId)),
        );
        yield* t3.parar;

        // The restored T3 restarts: the run ends and the same question is pending again, to be
        // answered by message, at a sequence past where the journal stopped.
        const r = yield* T3.harness("editaii-connector-antes-da-resposta", restaurado, {
          recoverOnStartup: true,
        });
        const depois = yield* m.ligar(r.layer);
        const { snapshotSequence, projection } = yield* noT3(depois)(
          Orchestrator.OrchestratorV2.use((engine) => engine.getThreadSnapshot(turn.threadId)),
        );
        assert.isAtLeast(snapshotSequence, sequencia);
        assert.deepEqual(
          projection.runtimeRequests.map((q) => [q.id, q.status, q.responseCapability.type]),
          [[intervencao.referencia, "pending", "message"]],
        );

        yield* m.quando(() => m.worker.estado(1) === "reconciliacao");
        assert.deepEqual(Maquinas.tipos(m.worker.aplicados), [
          "trabalho-1:1:intervencao",
          "trabalho-1:2:retomado",
          "trabalho-1:3:thread_perdida",
        ]);
        assert.strictEqual(yield* Queue.size(r.started), 0);
        assert.deepEqual(m.worker.invalidos, []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  describe("after a restart, the next request of a conversation", () => {
    it.effect("runs when the T3 still has the end of its last job", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const h = yield* T3.harness("editaii-connector-intacto", `${dir}/t3.sqlite`, {
          recoverOnStartup: true,
        });
        const m = yield* Maquinas.make(configuracao);
        const { turn } = yield* primeiroPedido(m, h);

        const t3 = yield* m.ligar(h.layer);
        m.worker.pedir(2);
        // The request's receipt reached the Worker: the T3 took it, on the conversation's thread.
        yield* m.quando(() => m.worker.estado(2) === "em_execucao");
        const seguinte = yield* noT3(t3)(h.nextTurn());
        assert.strictEqual(seguinte.threadId, turn.threadId);
        assert.deepEqual(m.worker.invalidos, []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect(
      "waits and stops when the T3 was restored to before that end, even with new events since",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped();
          const restaurado = `${dir}/restaurado.sqlite`;
          const h = yield* T3.harness("editaii-connector-original", `${dir}/t3.sqlite`, {
            recoverOnStartup: true,
          });
          const m = yield* Maquinas.make(configuracao);
          // The backup is taken while the run is live; the end comes after it.
          const { turn, sequencia } = yield* primeiroPedido(m, h, restaurado);

          // The T3 runs on the backup, without the connector, and someone writes in the thread:
          // its events go past where the journal stopped.
          const r = yield* T3.harness("editaii-connector-restaurado", restaurado, {
            recoverOnStartup: true,
          });
          yield* Effect.gen(function* () {
            const adapter = yield* Adapter.EditaiiT3Adapter;
            const engine = yield* Orchestrator.OrchestratorV2;
            yield* adapter.accept({ ...T3.plan("alguem", false), threadId: turn.threadId });
            const outro = yield* r.nextTurn();
            yield* r.finish(outro, "Outra conversa no T3.");
            assert.isAtLeast(yield* engine.getThreadEventSequence(turn.threadId), sequencia);
          }).pipe(Effect.provide(r.layer), Effect.scoped);

          yield* m.ligar(r.layer);
          m.worker.pedir(2);
          yield* m.quando(() => m.worker.estado(2) === "reconciliacao");
          assert.strictEqual(yield* Queue.size(r.started), 0);
          assert.strictEqual(m.worker.estado(1), "concluido");
          assert.deepEqual(Maquinas.tipos(m.worker.aplicados), [
            "trabalho-1:1:resposta",
            "trabalho-2:1:thread_perdida",
          ]);
          assert.deepEqual(m.worker.invalidos, []);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });
});
