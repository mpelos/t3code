import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as Journal from "./EditaiiJournal.ts";
import type * as Protocol from "./EditaiiProtocol.ts";
import * as Adapter from "./EditaiiT3Adapter.ts";
import * as Maquinas from "./EditaiiConnector.testkit.ts";
import { V1, V2, tipos, travar, umMinuto, type Sinal } from "./EditaiiConnector.testkit.ts";

const pronta: Journal.Configuracao = {
  type: "pronta",
  projectId: ProjectId.make("projeto"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "modelo" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

type Fato = Adapter.Observation extends infer O
  ? O extends Adapter.Observation
    ? Omit<O, "sequence" | "key">
    : never
  : never;
type Invocacao = "aceitar" | "recusar" | "travar_antes" | "travar_depois";

/**
 * The T3 as the adapter shows it. An invocation may hang before or after it takes effect, as a
 * crash would leave it. Each accepted run is a log the test appends facts to. Like the real
 * adapter, `observe` shows the whole run again, each request as it is now, and then follows it to
 * its final fact; a run whose thread is gone shows only that.
 */
const fakeT3 = (mudou: Sinal) => {
  const aceitos = new Map<string, Adapter.Acceptance>();
  const planos: Array<Adapter.RequestPlan> = [];
  const respostas = new Map<string, Adapter.AnswerPlan>();
  const runs = new Map<
    string,
    SubscriptionRef.SubscriptionRef<ReadonlyArray<Adapter.Observation>>
  >();
  const perdidos = new Set<string>();
  let sequence = 0;
  const t = {
    chamadasAccept: 0,
    chamadasRespond: 0,
    aceitar: "aceitar" as Invocacao,
    responder: "aceitar" as Invocacao,
    respostas,
  };
  const run = Effect.fn("test.fakeT3.run")(function* (runId: RunId) {
    const existente = runs.get(runId);
    if (existente !== undefined) return existente;
    const criado = yield* SubscriptionRef.make<ReadonlyArray<Adapter.Observation>>([]);
    runs.set(runId, criado);
    return criado;
  });
  const aceitacaoDe = (n: number) => {
    const plano = planos.find((p) => p.text.endsWith(`Pedido ${n}`));
    const aceitacao = plano === undefined ? undefined : aceitos.get(plano.commandId);
    if (aceitacao === undefined) throw new Error(`request ${n} was not accepted`);
    return aceitacao;
  };
  /** Appends what the T3 did in the run of request `n`. */
  const fato = Effect.fn("test.fakeT3.fato")(function* (n: number, f: (run: RunId) => Fato) {
    const { runId } = aceitacaoDe(n);
    sequence += 1;
    const observacao: Adapter.Observation = { ...f(runId), sequence, key: `fato:${sequence}` };
    yield* SubscriptionRef.update(yield* run(runId), (log) => [...log, observacao]);
  });
  /** The T3 lost the last fact of the run of request `n`, as a restored backup would. */
  const esquecer = Effect.fn("test.fakeT3.esquecer")(function* (n: number) {
    yield* SubscriptionRef.update(yield* run(aceitacaoDe(n).runId), (log) => log.slice(0, -1));
  });
  /** The thread of request `n` is gone from the T3. */
  const perder = Effect.fn("test.fakeT3.perder")(function* (n: number) {
    perdidos.add(aceitacaoDe(n).runId);
    yield* fato(n, () => ({ type: "thread_lost", reason: "thread" }));
  });
  const FINAIS: ReadonlyArray<Adapter.Observation["type"]> = ["answer", "failure", "thread_lost"];
  const adapter = Adapter.EditaiiT3Adapter.of({
    accept: (plan) =>
      Effect.gen(function* () {
        t.chamadasAccept += 1;
        planos.push(plan);
        const aceitacao: Adapter.Acceptance = {
          threadId: plan.threadId,
          messageId: plan.messageId,
          runId: RunId.make(`run:${plan.commandId}`),
          commandIds: [plan.commandId],
        };
        const toma = t.aceitar === "aceitar" || t.aceitar === "travar_depois";
        if (toma) aceitos.set(plan.commandId, aceitacao);
        mudou.avisar();
        if (t.aceitar === "recusar") {
          return yield* new Adapter.AcceptRefused({ commandId: plan.commandId });
        }
        if (t.aceitar !== "aceitar") return yield* Effect.never;
        return aceitacao;
      }),
    inspect: (plan) => {
      const found = aceitos.get(plan.commandId);
      return Effect.succeed<Adapter.Inspection>(
        found === undefined ? { type: "absent" } : { type: "found", acceptance: found },
      );
    },
    observe: (acceptance, after) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (perdidos.has(acceptance.runId)) {
            const perdida: Adapter.Observation = {
              type: "thread_lost",
              reason: "thread",
              sequence: after ?? 0,
              key: "lost:thread",
            };
            return Stream.succeed(perdida);
          }
          let visto = 0;
          return SubscriptionRef.changes(yield* run(acceptance.runId)).pipe(
            Stream.flatMap((log) => {
              const agora = log.filter(
                (o, i) =>
                  !("requestId" in o) ||
                  log.findLastIndex((p) => "requestId" in p && p.requestId === o.requestId) === i,
              );
              const novos = agora.filter((o) => o.sequence > visto);
              visto = Math.max(visto, ...novos.map((o) => o.sequence));
              return Stream.fromIterable(novos);
            }),
            Stream.takeUntil((o) => FINAIS.includes(o.type)),
          );
        }),
      ),
    respond: (plan) =>
      Effect.gen(function* () {
        t.chamadasRespond += 1;
        const toma = t.responder === "aceitar" || t.responder === "travar_depois";
        if (toma) respostas.set(plan.commandId, plan);
        mudou.avisar();
        if (t.responder === "recusar") return { type: "not_resumable" } as const;
        if (t.responder !== "aceitar") return yield* Effect.never;
        return { type: "accepted", commandId: plan.commandId } as const;
      }),
    inspectAnswer: (plan) =>
      Effect.succeed<Adapter.AnswerInspection>(
        respostas.has(plan.commandId)
          ? { type: "found", commandId: plan.commandId }
          : { type: "absent" },
      ),
  });
  return { t, adapter, fato, esquecer, perder };
};

const pergunta =
  (requestId: string) =>
  (runId: RunId): Fato => ({
    type: "question",
    runId,
    requestId: RuntimeRequestId.make(requestId),
    questions: [{ id: `q-${requestId}`, header: "Proposta", question: "Seguimos?", options: [] }],
    capability: "live",
  });
const resolvida = (requestId: string) => (): Fato => ({
  type: "resolved",
  requestId: RuntimeRequestId.make(requestId),
  status: "resolved",
});
const resposta =
  (texto: string) =>
  (runId: RunId): Fato => ({
    type: "answer",
    runId,
    text: texto,
    messageId: MessageId.make(`resposta:${texto}`),
  });
// The fake T3's questions have no options, so the person writes the answer.
const SIM: Protocol.Respostas = { p1: { texto: "Sim" } };

/** A machine whose fake T3 lives as long as the test, so a restart keeps its runs. */
const maquinaCom = Effect.fn("test.maquinaCom")(function* (
  configuracao: Effect.Effect<Journal.Configuracao, Journal.EditaiiConfiguracaoIlegivel>,
) {
  const m = yield* Maquinas.make();
  const t3 = fakeT3(m.mudou);
  return {
    ...m,
    ligar: m.ligar(Layer.succeed(Adapter.EditaiiT3Adapter, t3.adapter), configuracao),
    t3: t3.t,
    fato: t3.fato,
    esquecer: t3.esquecer,
    perder: t3.perder,
  };
});
const maquina = maquinaCom(Effect.succeed(pronta));
type Maquina = Effect.Success<typeof maquina>;

/** Request 1 accepted, confirmed and asking question `x`, which the person sees. */
const perguntando = Effect.fn("test.perguntando")(function* (m: Maquina) {
  m.worker.pedir(1);
  const t3 = yield* m.ligar;
  yield* m.quando(() => m.worker.estado(1) === "em_execucao");
  yield* m.fato(1, pergunta("x"));
  yield* m.quando(() => m.worker.estado(1) === "aguardando_pessoa");
  return t3;
});

/** Request 1 ran to its answer, the machine recorded the Worker has it, and the T3 stopped. */
const concluido = Effect.fn("test.concluido")(function* (m: Maquina) {
  m.worker.pedir(1);
  const antes = yield* m.ligar;
  yield* m.quando(() => m.worker.estado(1) === "em_execucao");
  yield* m.fato(1, resposta("Um"));
  yield* m.quando(() => m.eventosGravados() === 1);
  yield* antes.parar;
});

describe("EditaiiConnector", () => {
  it.effect("carries a request, a question, its answer and the result, each invoked once", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      yield* perguntando(m);
      m.worker.responder(1, SIM);
      yield* m.quando(() => m.worker.estado(1) === "em_execucao");
      yield* m.fato(1, resolvida("x"));
      yield* m.fato(1, resposta("Pronto"));
      yield* m.quando(() => m.worker.estado(1) === "concluido");

      assert.equal(m.t3.chamadasAccept, 1);
      assert.equal(m.t3.chamadasRespond, 1);
      assert.deepEqual(
        [...m.t3.respostas.values()].map((p) => ({ requestId: p.requestId, answers: p.answers })),
        [{ requestId: RuntimeRequestId.make("x"), answers: { "q-x": "Sim" } }],
      );
      assert.deepEqual(tipos(m.worker.aplicados), [
        "trabalho-1:1:intervencao",
        "trabalho-1:2:retomado",
        "trabalho-1:3:resposta",
      ]);
      assert.deepEqual(m.worker.invalidos, []);
    }).pipe(Effect.scoped),
  );

  it.effect("tells nothing of a job until the Worker takes the request's receipt", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      const trava = yield* travar(m, (id) => id === "entrega-1");
      m.worker.pedir(1);
      yield* m.ligar;
      yield* m.quando(() => m.t3.chamadasAccept === 1);
      yield* m.fato(1, pergunta("x"));
      yield* umMinuto;
      assert.equal(m.worker.estado(1), "entregue");
      assert.deepEqual(m.worker.enviados, []);

      yield* Deferred.succeed(trava, undefined);
      yield* m.quando(() => m.worker.estado(1) === "aguardando_pessoa");
      assert.deepEqual(tipos(m.worker.aplicados), ["trabalho-1:1:intervencao"]);
      assert.deepEqual(m.worker.invalidos, []);
    }).pipe(Effect.scoped),
  );

  it.effect("settings that cannot be read hold the request until they can, then it runs", () =>
    Effect.gen(function* () {
      let ilegiveis = 1;
      const m = yield* maquinaCom(
        Effect.suspend(() =>
          ilegiveis-- > 0
            ? Effect.fail(new Journal.EditaiiConfiguracaoIlegivel({ cause: "settings unreadable" }))
            : Effect.succeed(pronta),
        ),
      );
      m.worker.pedir(1);
      yield* m.ligar;
      yield* m.pausa;
      yield* m.quando(() => m.worker.estado(1) === "em_execucao");
      assert.equal(m.t3.chamadasAccept, 1);
      assert.deepEqual(tipos(m.worker.aplicados), []);
      assert.deepEqual(m.worker.invalidos, []);
    }).pipe(Effect.scoped),
  );

  it.effect("a request the T3 refuses fails its job, and the next one runs at once", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      m.t3.aceitar = "recusar";
      m.worker.pedir(1, "conversa-1");
      yield* m.ligar;
      yield* m.quando(() => m.worker.estado(1) === "falhou");
      m.t3.aceitar = "aceitar";
      m.worker.pedir(2, "conversa-1");
      yield* m.quando(() => m.worker.estado(2) === "em_execucao");
      assert.deepEqual(tipos(m.worker.aplicados), ["trabalho-1:1:falha"]);
      assert.deepEqual(m.worker.invalidos, []);
    }).pipe(Effect.scoped),
  );

  it.effect("an answer the T3 can no longer take fails its job", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      yield* perguntando(m);
      m.t3.responder = "recusar";
      m.worker.responder(1, SIM);
      yield* m.quando(() => m.worker.estado(1) === "falhou");
      assert.equal(m.t3.chamadasRespond, 1);
      assert.deepEqual(tipos(m.worker.aplicados), [
        "trabalho-1:1:intervencao",
        "trabalho-1:2:falha",
      ]);
      assert.deepEqual(m.worker.invalidos, []);
    }).pipe(Effect.scoped),
  );

  it.effect("a refused receipt is not sent again, and other conversations go on", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      m.worker.recusarRecibo.add("entrega-1");
      m.worker.pedir(1, "conversa-1");
      m.worker.pedir(2, "conversa-2");
      yield* m.ligar;
      yield* m.quando(() => m.worker.estado(2) === "em_execucao");
      yield* umMinuto;
      assert.deepEqual(
        m.worker.confirmacoes.map((c) => c.entregaId),
        ["entrega-1", "entrega-2"],
      );
      assert.equal(m.t3.chamadasAccept, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("a receipt the Worker took right before a crash is sent again after it", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      m.worker.perderResposta.add("confirmar");
      m.worker.pedir(1);
      const antes = yield* m.ligar;
      yield* m.quando(() => m.worker.estado(1) === "em_execucao");
      yield* antes.parar;

      yield* m.ligar;
      yield* m.fato(1, resposta("Pronto"));
      yield* m.quando(() => m.worker.estado(1) === "concluido");
      assert.deepEqual(
        m.worker.confirmacoes.map((c) => c.entregaId),
        ["entrega-1", "entrega-1"],
      );
      assert.equal(m.t3.chamadasAccept, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("a receipt whose reply was lost is sent again, the same, after a pause", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      m.worker.perderResposta.add("confirmar");
      m.worker.pedir(1);
      yield* m.ligar;
      yield* m.quando(() => m.worker.estado(1) === "em_execucao");
      yield* m.pausa;
      yield* m.quando(() => m.worker.confirmacoes.length === 2);
      yield* m.fato(1, pergunta("x"));
      yield* m.quando(() => m.worker.estado(1) === "aguardando_pessoa");
      const [primeira, segunda, ...outras] = m.worker.confirmacoes;
      assert.deepEqual(outras, []);
      assert.equal(primeira?.entregaId, "entrega-1");
      assert.deepEqual(segunda, primeira);
      assert.equal(m.t3.chamadasAccept, 1);
      assert.deepEqual(m.worker.invalidos, []);
    }).pipe(Effect.scoped),
  );

  it.effect("a late answer receipt leaves the next question waiting for the person", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      yield* perguntando(m);
      const trava = yield* travar(m, (id) => id.startsWith("resposta-"));
      m.worker.responder(1, SIM);
      yield* m.quando(() => m.t3.chamadasRespond === 1);
      // The T3 goes on and asks again while the answer's receipt is stuck.
      yield* m.fato(1, resolvida("x"));
      yield* m.fato(1, pergunta("y"));
      yield* m.quando(() => m.worker.trabalho(1)?.intervencao?.referencia === "y");

      yield* Deferred.succeed(trava, undefined);
      yield* m.quando(() => m.worker.confirmacoes.some((c) => c.entregaId.startsWith("resposta-")));
      yield* umMinuto;
      assert.equal(m.worker.estado(1), "aguardando_pessoa");
      assert.isTrue(m.worker.trabalho(1)?.intervencao?.aberta);
      assert.deepEqual(tipos(m.worker.aplicados), [
        "trabalho-1:1:intervencao",
        "trabalho-1:2:retomado",
        "trabalho-1:3:intervencao",
      ]);
      assert.deepEqual(m.worker.invalidos, []);
    }).pipe(Effect.scoped),
  );

  it.effect("a receipt the Worker does not take yet holds back no job already followed", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      yield* travar(m, (id) => id === "entrega-2");
      m.worker.pedir(1, "conversa-1");
      m.worker.pedir(2, "conversa-2");
      const antes = yield* m.ligar;
      yield* m.quando(
        () =>
          m.worker.estado(1) === "em_execucao" &&
          m.worker.chamadas.includes("maquina/entregas/entrega-2/confirmar"),
      );
      yield* antes.parar;

      // After the restart, the receipt of request 2 is still on its way when request 1 answers.
      yield* m.ligar;
      yield* m.fato(1, resposta("Um"));
      yield* m.quando(() => m.worker.estado(1) === "concluido");
      assert.equal(m.worker.estado(2), "entregue");
      assert.equal(m.t3.chamadasAccept, 2);
    }).pipe(Effect.scoped),
  );

  describe("a journal failure starts the work again from the journal, after a pause", () => {
    it.effect.each(["observar", "proximoEvento"] as const)("in %s", (operacao) =>
      Effect.gen(function* () {
        const m = yield* maquina;
        m.worker.pedir(1);
        yield* m.ligar;
        yield* m.quando(() => m.worker.estado(1) === "em_execucao");
        m.falhar.add(operacao);
        yield* m.fato(1, pergunta("x"));
        yield* m.pausa;
        yield* m.quando(() => m.worker.estado(1) === "aguardando_pessoa");
        assert.isFalse(m.falhar.has(operacao));
        assert.deepEqual(tipos(m.worker.aplicados), ["trabalho-1:1:intervencao"]);
        assert.equal(m.t3.chamadasAccept, 1);
      }).pipe(Effect.scoped),
    );
  });

  describe("after a restart, a conversation goes on only from a job the T3 still has", () => {
    it.effect("the T3 still has it: the next request runs", () =>
      Effect.gen(function* () {
        const m = yield* maquina;
        yield* concluido(m);

        yield* m.ligar;
        m.worker.pedir(2);
        yield* m.quando(() => m.worker.estado(2) === "em_execucao");
        assert.equal(m.t3.chamadasAccept, 2);
        assert.deepEqual(tipos(m.worker.aplicados), ["trabalho-1:1:resposta"]);
        assert.deepEqual(m.worker.invalidos, []);
      }).pipe(Effect.scoped),
    );

    it.effect("the T3 lost its end: the next request waits, and stops on another end", () =>
      Effect.gen(function* () {
        const m = yield* maquina;
        yield* concluido(m);
        yield* m.esquecer(1);

        yield* m.ligar;
        m.worker.pedir(2);
        yield* m.quando(() => m.worker.estado(2) === "entregue");
        yield* umMinuto;
        assert.equal(m.worker.estado(2), "entregue");
        assert.equal(m.t3.chamadasAccept, 1);

        yield* m.fato(1, resposta("Outra"));
        yield* m.quando(() => m.worker.estado(2) === "reconciliacao");
        assert.equal(m.t3.chamadasAccept, 1);
        assert.equal(m.worker.estado(1), "concluido");
        assert.deepEqual(m.worker.invalidos, []);
      }).pipe(Effect.scoped),
    );

    it.effect("the T3 lost it: the conversation stops, and that job's result stays", () =>
      Effect.gen(function* () {
        const m = yield* maquina;
        yield* concluido(m);
        yield* m.perder(1);

        yield* m.ligar;
        m.worker.pedir(2);
        yield* m.quando(() => m.worker.estado(2) === "reconciliacao");
        assert.equal(m.t3.chamadasAccept, 1);
        assert.equal(m.worker.estado(1), "concluido");
        assert.deepEqual(tipos(m.worker.aplicados), [
          "trabalho-1:1:resposta",
          "trabalho-2:1:thread_perdida",
        ]);
        assert.deepEqual(m.worker.invalidos, []);
      }).pipe(Effect.scoped),
    );
  });

  describe("after a crash, an invoked delivery is only inspected", () => {
    it.effect("a request the T3 never took: the conversation stops for reconciliation", () =>
      Effect.gen(function* () {
        const m = yield* maquina;
        m.t3.aceitar = "travar_antes";
        m.worker.pedir(1);
        const antes = yield* m.ligar;
        yield* m.quando(() => m.t3.chamadasAccept === 1);
        yield* antes.parar;

        m.t3.aceitar = "aceitar";
        yield* m.ligar;
        yield* m.quando(() => m.worker.estado(1) === "reconciliacao");
        assert.equal(m.t3.chamadasAccept, 1);
        assert.deepEqual(tipos(m.worker.aplicados), ["trabalho-1:1:thread_perdida"]);
        assert.deepEqual(m.worker.invalidos, []);
      }).pipe(Effect.scoped),
    );

    it.effect("a request the T3 took: its receipt goes and the job runs", () =>
      Effect.gen(function* () {
        const m = yield* maquina;
        m.t3.aceitar = "travar_depois";
        m.worker.pedir(1);
        const antes = yield* m.ligar;
        yield* m.quando(() => m.t3.chamadasAccept === 1);
        yield* antes.parar;

        m.t3.aceitar = "aceitar";
        yield* m.ligar;
        yield* m.quando(() => m.worker.estado(1) === "em_execucao");
        yield* m.fato(1, resposta("Pronto"));
        yield* m.quando(() => m.worker.estado(1) === "concluido");
        assert.equal(m.t3.chamadasAccept, 1);
        assert.deepEqual(m.worker.invalidos, []);
      }).pipe(Effect.scoped),
    );

    it.effect("an answer the T3 never took: the conversation stops for reconciliation", () =>
      Effect.gen(function* () {
        const m = yield* maquina;
        const antes = yield* perguntando(m);
        m.t3.responder = "travar_antes";
        m.worker.responder(1, SIM);
        yield* m.quando(() => m.t3.chamadasRespond === 1);
        yield* antes.parar;

        m.t3.responder = "aceitar";
        yield* m.ligar;
        yield* m.quando(() => m.worker.estado(1) === "reconciliacao");
        assert.equal(m.t3.chamadasRespond, 1);
        assert.deepEqual(m.worker.invalidos, []);
      }).pipe(Effect.scoped),
    );

    it.effect("an answer the T3 took: its receipt goes and the job resumes", () =>
      Effect.gen(function* () {
        const m = yield* maquina;
        const antes = yield* perguntando(m);
        m.t3.responder = "travar_depois";
        m.worker.responder(1, SIM);
        yield* m.quando(() => m.t3.chamadasRespond === 1);
        yield* antes.parar;

        m.t3.responder = "aceitar";
        yield* m.ligar;
        yield* m.quando(() => m.worker.estado(1) === "em_execucao");
        yield* m.fato(1, resolvida("x"));
        yield* m.fato(1, resposta("Pronto"));
        yield* m.quando(() => m.worker.estado(1) === "concluido");
        assert.equal(m.t3.chamadasRespond, 1);
        assert.deepEqual(m.worker.invalidos, []);
      }).pipe(Effect.scoped),
    );
  });

  describe("desligar", () => {
    it.effect("returns while the Worker is unreachable, and the link says nothing more", () =>
      Effect.gen(function* () {
        const m = yield* maquina;
        const trava = yield* travar(m, () => true);
        m.worker.pedir(1);
        const t3 = yield* m.ligar;
        yield* m.quando(() => m.worker.chamadas.some((c) => c.endsWith("/confirmar")));

        yield* t3.connector.desligar(V1);
        assert.isNull(yield* t3.vinculo);
        const chamadas = m.worker.chamadas.length;
        yield* Deferred.succeed(trava, undefined);
        yield* umMinuto;
        assert.equal(m.worker.chamadas.length, chamadas);
        assert.deepEqual(m.worker.confirmacoes, []);
      }).pipe(Effect.scoped),
    );

    it.effect("once the intent is written, disconnects even if its caller goes away", () =>
      Effect.gen(function* () {
        const m = yield* maquina;
        const segurar = yield* Deferred.make<void>();
        m.desligar.segurar = segurar;
        const t3 = yield* m.ligar;
        const desligando = yield* Effect.forkChild(t3.connector.desligar(V1));
        yield* m.quando(() => m.desligar.escritos === 1);

        // The caller goes away while the intent is written and the disconnect has not run yet.
        yield* Effect.sync(() => desligando.interruptUnsafe());
        yield* Deferred.succeed(segurar, undefined);
        assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(desligando)));
        assert.isNull(yield* t3.vinculo);
      }).pipe(Effect.scoped),
    );

    it.effect("an intent that survived a crash disconnects before any Worker call", () =>
      Effect.gen(function* () {
        const m = yield* maquina;
        const antes = yield* perguntando(m);
        yield* antes.journal.desligar(V1);
        yield* antes.parar;

        const chamadas = m.worker.chamadas.length;
        const depois = yield* m.ligar;
        yield* depois.desconectado;
        yield* umMinuto;
        assert.equal(m.worker.chamadas.length, chamadas);
      }).pipe(Effect.scoped),
    );

    it.effect("a late request for an old link leaves the connected one working", () =>
      Effect.gen(function* () {
        const m = yield* maquina;
        m.salvar("maquina-2");
        const t3 = yield* m.ligar;
        yield* t3.connector.desligar(V1);
        assert.deepEqual(yield* t3.vinculo, V2);

        m.worker.pedir(1);
        yield* m.quando(() => m.worker.estado(1) === "em_execucao");
        yield* m.fato(1, resposta("Pronto"));
        yield* m.quando(() => m.worker.estado(1) === "concluido");
      }).pipe(Effect.scoped),
    );
  });

  it.effect("an event the Worker refuses holds its job only, and is not sent again", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      m.worker.recusar = (e) => e.trabalho_id === "trabalho-1";
      m.worker.pedir(1, "conversa-1");
      m.worker.pedir(2, "conversa-2");
      yield* m.ligar;
      yield* m.quando(
        () => m.worker.estado(1) === "em_execucao" && m.worker.estado(2) === "em_execucao",
      );
      yield* m.fato(1, resposta("Um"));
      yield* m.fato(2, resposta("Dois"));
      yield* m.quando(() => m.worker.estado(2) === "concluido");
      yield* umMinuto;
      assert.deepEqual(tipos(m.worker.recusados), ["trabalho-1:1:resposta"]);
      assert.equal(m.worker.estado(1), "em_execucao");
      assert.deepEqual(m.worker.invalidos, []);
    }).pipe(Effect.scoped),
  );

  it.effect("an event whose reply was lost is sent again, the same, and applied once", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      m.worker.pedir(1);
      yield* m.ligar;
      yield* m.quando(() => m.worker.estado(1) === "em_execucao");
      m.worker.perderResposta.add("eventos");
      yield* m.fato(1, resposta("Pronto"));
      yield* m.quando(() => m.worker.estado(1) === "concluido");
      yield* m.pausa;
      yield* m.quando(() => m.worker.enviados.length === 2);
      yield* umMinuto;
      const [primeiro, segundo, ...outros] = m.worker.enviados;
      assert.deepEqual(outros, []);
      assert.include(primeiro, '"tipo":"resposta"');
      assert.equal(segundo, primeiro);
      assert.deepEqual(tipos(m.worker.aplicados), ["trabalho-1:1:resposta"]);
    }).pipe(Effect.scoped),
  );
});
