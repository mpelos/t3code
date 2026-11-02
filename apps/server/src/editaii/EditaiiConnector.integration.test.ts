/**
 * The connector over the real T3: orchestrator, receipts, thread launch and management, with a
 * scripted provider (EditaiiT3Adapter.testkit.ts), and the strict fake Worker
 * (EditaiiConnector.testkit.ts). The T3's effect worker moves only when a test drains it, after
 * the mark that says there is work for it.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as Maquinas from "./EditaiiConnector.testkit.ts";
import type * as Journal from "./EditaiiJournal.ts";
import * as T3 from "./EditaiiT3Adapter.testkit.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";

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
});
