// @effect-diagnostics nodeBuiltinImport:off -- The journal is a real file in a temporary state dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Connection from "./EditaiiConnection.ts";
import * as Connector from "./EditaiiConnector.ts";
import * as Journal from "./EditaiiJournal.ts";
import type * as Protocol from "./EditaiiProtocol.ts";
import * as Adapter from "./EditaiiT3Adapter.ts";

const ORIGIN = "https://editaii.example";
const ENVIRONMENT = EnvironmentId.make("connector-environment");
const vinculo = (maquina: string): Connection.EditaiiVinculo => ({
  origem: ORIGIN,
  maquina,
  ambiente: ENVIRONMENT,
});
const V1 = vinculo("maquina-1");
const V2 = vinculo("maquina-2");
const conectada = (maquina: string) =>
  new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      phase: "connected",
      origin: ORIGIN,
      environmentId: ENVIRONMENT,
      client_id: "machines.access",
      client_secret: "test-secret",
      credential: `credential-${maquina}`,
      machine: {
        id: maquina,
        nome: "Escritório",
        dono: "pessoa@example.com",
        ambiente_t3: ENVIRONMENT,
        emitida_em: "2026-11-01T00:00:00.000Z",
        ativada_em: "2026-11-01T00:00:00.000Z",
        revogada_em: null,
      },
    }),
  );
const pronta: Journal.Configuracao = {
  type: "pronta",
  projectId: ProjectId.make("projeto"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "modelo" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

type EstadoTrabalho =
  | "aguardando"
  | "entregue"
  | "em_execucao"
  | "aguardando_pessoa"
  | "acao_no_t3"
  | "concluido"
  | "falhou"
  | "reconciliacao";
const ATIVOS: ReadonlyArray<EstadoTrabalho> = [
  "entregue",
  "em_execucao",
  "aguardando_pessoa",
  "acao_no_t3",
];
const EM_CURSO: ReadonlyArray<EstadoTrabalho> = ["em_execucao", "aguardando_pessoa", "acao_no_t3"];
// As the Worker's APLICA_EM (src/trabalhos.ts in the editaii repository).
const APLICA_EM: Record<Protocol.Evento["tipo"], ReadonlyArray<EstadoTrabalho>> = {
  resposta: EM_CURSO,
  intervencao: ["em_execucao", "acao_no_t3"],
  acao_necessaria: ["em_execucao", "acao_no_t3"],
  retomado: EM_CURSO,
  falha: ["entregue", ...EM_CURSO],
  thread_perdida: ["entregue", ...EM_CURSO],
};

interface Trabalho {
  readonly n: number;
  readonly conversa: string;
  estado: EstadoTrabalho;
  intervencao: { readonly id: string; readonly referencia: string; aberta: boolean } | null;
}

/**
 * The Worker's side of docs/protocolo-maquinas.md, as strict as the real one (src/trabalhos.ts in
 * the editaii repository). Every event it refuses for breaking the protocol is kept in
 * `invalidos`, so a test can assert the connector never sent one.
 */
const fakeWorker = () => {
  const trabalhos = new Map<string, Trabalho>();
  const conversas = new Map<string, { thread: string | null; parada: boolean }>();
  const entregas: Array<{ readonly entrega: Protocol.Entrega; recibo: string | null }> = [];
  const vistos = new Map<string, string>();
  const ultima = new Map<string, number>();
  const w = {
    chamadas: [] as Array<string>,
    confirmacoes: [] as Array<{ readonly entregaId: string; readonly recibo: string }>,
    enviados: [] as Array<string>,
    aplicados: [] as Array<Protocol.Evento>,
    invalidos: [] as Array<{ readonly evento: Protocol.Evento; readonly motivo: string }>,
    recusados: [] as Array<Protocol.Evento>,
    /** While set, a receipt waits for it before reaching the Worker. */
    travarConfirmacao: null as Deferred.Deferred<void> | null,
    /** The next call of this kind is applied, and its reply lost. */
    perderResposta: new Set<"confirmar" | "eventos">(),
    /** Deliveries whose receipt the Worker refuses, as when it names another thread. */
    recusarRecibo: new Set<string>(),
    /** Valid events the Worker refuses anyway, as when it contradicts the machine. */
    recusar: (_evento: Protocol.Evento): boolean => false,
    trabalho: (n: number) => trabalhos.get(`trabalho-${n}`),
    estado: (n: number) => trabalhos.get(`trabalho-${n}`)?.estado,
    /** A person asks the machine; the job waits for its conversation to be free. */
    pedir: (n: number, conversa = "conversa-1") => {
      trabalhos.set(`trabalho-${n}`, { n, conversa, estado: "aguardando", intervencao: null });
      if (!conversas.has(conversa)) conversas.set(conversa, { thread: null, parada: false });
    },
    /** The person answers the job's open intervention in the Editaii. */
    responder: (n: number, respostas: Protocol.Respostas) => {
      const t = trabalhos.get(`trabalho-${n}`);
      const c = t === undefined ? undefined : conversas.get(t.conversa);
      if (t?.intervencao?.aberta !== true || c === undefined) throw new Error("nothing to answer");
      entregas.push({
        recibo: null,
        entrega: {
          versao: 1,
          entrega_id: `resposta-${t.intervencao.id}`,
          tipo: "resposta",
          trabalho_id: `trabalho-${n}`,
          conversa: { id: t.conversa, geracao: 1, thread_t3: c.thread },
          intervencao: { id: t.intervencao.id, referencia: t.intervencao.referencia, respostas },
        },
      });
    },
  };
  const trabalhoDe = (id: string) => {
    const t = trabalhos.get(id);
    if (t === undefined) throw new Error(`unknown job ${id}`);
    return t;
  };
  const parada = (t: Trabalho) => conversas.get(t.conversa)?.parada === true;
  const querida = (e: (typeof entregas)[number]) => {
    const t = trabalhoDe(e.entrega.trabalho_id);
    if (e.recibo !== null || parada(t)) return false;
    if (e.entrega.tipo === "pedido") return t.estado === "entregue";
    return t.intervencao?.id === e.entrega.intervencao.id && t.intervencao.aberta;
  };
  const proxima = (): Protocol.Entrega | null => {
    const aberta = entregas.find(querida);
    if (aberta !== undefined) return aberta.entrega;
    const livre = [...trabalhos.values()]
      .filter(
        (t) =>
          t.estado === "aguardando" &&
          !parada(t) &&
          ![...trabalhos.values()].some(
            (o) => o.conversa === t.conversa && ATIVOS.includes(o.estado),
          ),
      )
      .toSorted((a, b) => a.n - b.n)[0];
    if (livre === undefined) return null;
    livre.estado = "entregue";
    const entrega: Protocol.EntregaPedido = {
      versao: 1,
      entrega_id: `entrega-${livre.n}`,
      tipo: "pedido",
      trabalho_id: `trabalho-${livre.n}`,
      conversa: {
        id: livre.conversa,
        geracao: 1,
        thread_t3: conversas.get(livre.conversa)?.thread ?? null,
      },
      edital: { id: "edital-1", revisao: 1, ficha: { objeto: "Sistema" } },
      contexto: [],
      pedido: {
        mensagem_id: `mensagem-${livre.n}`,
        seq: livre.n,
        autor_nome: "Pessoa",
        texto: `Pedido ${livre.n}`,
      },
    };
    entregas.push({ entrega, recibo: null });
    return entrega;
  };
  const confirmar = (entregaId: string, recibo: Record<string, unknown>): number => {
    const e = entregas.find((x) => x.entrega.entrega_id === entregaId);
    if (e === undefined) return 404;
    const texto = JSON.stringify(recibo);
    w.confirmacoes.push({ entregaId, recibo: texto });
    if (e.recibo !== null) return e.recibo === texto ? 200 : 409;
    const t = trabalhoDe(e.entrega.trabalho_id);
    if (w.recusarRecibo.has(entregaId)) {
      const c = conversas.get(t.conversa);
      if (c !== undefined) c.parada = true;
      return 409;
    }
    if (e.entrega.tipo === "pedido") {
      const c = conversas.get(t.conversa);
      if (c === undefined) throw new Error("unknown conversation");
      c.thread ??= String(recibo.thread);
      if (c.thread !== recibo.thread) {
        c.parada = true;
        return 409;
      }
      if (t.estado === "entregue") t.estado = "em_execucao";
    } else if (t.intervencao?.id === e.entrega.intervencao.id) {
      // Resumes only if this answer is what the run waits on, never a newer question.
      if (t.estado === "aguardando_pessoa" && t.intervencao.aberta) t.estado = "em_execucao";
      t.intervencao.aberta = false;
    }
    e.recibo = texto;
    return 200;
  };
  const aplicar = (evento: Protocol.Evento): number => {
    const corpo = JSON.stringify(evento);
    const visto = vistos.get(evento.id);
    if (visto !== undefined) return visto === corpo ? 200 : 409;
    const t = trabalhoDe(evento.trabalho_id);
    const invalido = (motivo: string) => {
      w.invalidos.push({ evento, motivo });
      return 409;
    };
    if (!APLICA_EM[evento.tipo].includes(t.estado))
      return invalido(`${evento.tipo} in ${t.estado}`);
    if (evento.sequencia !== (ultima.get(evento.trabalho_id) ?? 0) + 1) return invalido("order");
    if (w.recusar(evento)) {
      w.recusados.push(evento);
      return 409;
    }
    vistos.set(evento.id, corpo);
    ultima.set(evento.trabalho_id, evento.sequencia);
    w.aplicados.push(evento);
    const encerrar = () => {
      if (t.intervencao !== null) t.intervencao.aberta = false;
    };
    switch (evento.tipo) {
      case "resposta":
        t.estado = "concluido";
        encerrar();
        break;
      case "intervencao":
        t.estado = "aguardando_pessoa";
        t.intervencao = { id: `i-${evento.id}`, referencia: evento.referencia, aberta: true };
        break;
      case "acao_necessaria":
        t.estado = "acao_no_t3";
        break;
      case "retomado":
        t.estado = "em_execucao";
        encerrar();
        break;
      case "falha":
        t.estado = "falhou";
        encerrar();
        break;
      case "thread_perdida": {
        t.estado = "reconciliacao";
        const c = conversas.get(t.conversa);
        if (c !== undefined) c.parada = true;
        break;
      }
    }
    return 200;
  };
  const perdida = (tipo: "confirmar" | "eventos") => w.perderResposta.delete(tipo);
  const reply = Effect.fn("test.fakeWorker.reply")(function* (
    request: HttpClientRequest.HttpClientRequest,
  ) {
    if (request.body._tag !== "Uint8Array") throw new Error("Expected a JSON request");
    const body = JSON.parse(new TextDecoder().decode(request.body.body));
    const path = new URL(request.url).pathname.replace(/^\/api\//, "");
    w.chamadas.push(path);
    if (path === "maquina/entregas/proxima") return Response.json({ entrega: proxima() });
    const confirmacao = /^maquina\/entregas\/([^/]+)\/confirmar$/.exec(path)?.[1];
    if (confirmacao !== undefined) {
      if (w.travarConfirmacao !== null) yield* Deferred.await(w.travarConfirmacao);
      const status = confirmar(decodeURIComponent(confirmacao), body.recibo);
      if (status === 200 && perdida("confirmar")) return new Response("lost", { status: 502 });
      return status === 200 ? Response.json({ ok: true }) : new Response("", { status });
    }
    if (path === "maquina/eventos") {
      const eventos: Array<Protocol.Evento> = body.eventos;
      for (const evento of eventos) {
        w.enviados.push(JSON.stringify(evento));
        const status = aplicar(evento);
        if (status !== 200) return new Response("", { status });
      }
      if (perdida("eventos")) return new Response("lost", { status: 502 });
      return Response.json({ aplicados: eventos.length });
    }
    return new Response("", { status: 404 });
  });
  return Object.assign(w, { reply });
};

type Fato = Adapter.Observation extends infer O
  ? O extends Adapter.Observation
    ? Omit<O, "sequence" | "key">
    : never
  : never;
type Invocacao = "aceitar" | "recusar" | "travar_antes" | "travar_depois";

/**
 * The T3 as the adapter shows it. An invocation may hang before or after it takes effect, as a
 * crash would leave it. Each accepted run is a log the test appends facts to; `observe` replays it
 * after the cursor and follows it to its final fact, as the real adapter does.
 */
const fakeT3 = () => {
  const aceitos = new Map<string, Adapter.Acceptance>();
  const planos: Array<Adapter.RequestPlan> = [];
  const respostas = new Map<string, Adapter.AnswerPlan>();
  const runs = new Map<
    string,
    SubscriptionRef.SubscriptionRef<ReadonlyArray<Adapter.Observation>>
  >();
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
  /** Appends what the T3 did in the run of request `n`. */
  const fato = Effect.fn("test.fakeT3.fato")(function* (n: number, f: (run: RunId) => Fato) {
    const plano = planos.find((p) => p.text.endsWith(`Pedido ${n}`));
    const aceitacao = plano === undefined ? undefined : aceitos.get(plano.commandId);
    if (aceitacao === undefined) throw new Error(`request ${n} was not accepted`);
    sequence += 1;
    const observacao: Adapter.Observation = {
      ...f(aceitacao.runId),
      sequence,
      key: `fato:${sequence}`,
    };
    yield* SubscriptionRef.update(yield* run(aceitacao.runId), (log) => [...log, observacao]);
  });
  const FINAIS: ReadonlyArray<Adapter.Observation["type"]> = ["answer", "failure", "thread_lost"];
  const adapter = Adapter.EditaiiT3Adapter.of({
    accept: (plan) =>
      Effect.gen(function* () {
        t.chamadasAccept += 1;
        planos.push(plan);
        if (t.aceitar === "recusar") {
          return yield* new Adapter.AcceptRefused({ commandId: plan.commandId });
        }
        if (t.aceitar === "travar_antes") return yield* Effect.never;
        const aceitacao: Adapter.Acceptance = {
          threadId: plan.threadId,
          messageId: plan.messageId,
          runId: RunId.make(`run:${plan.commandId}`),
          commandIds: [plan.commandId],
        };
        aceitos.set(plan.commandId, aceitacao);
        if (t.aceitar === "travar_depois") return yield* Effect.never;
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
          let visto = after ?? 0;
          return SubscriptionRef.changes(yield* run(acceptance.runId)).pipe(
            Stream.flatMap((log) => {
              const novos = log.filter((o) => o.sequence > visto);
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
        if (t.responder === "recusar") return { type: "not_resumable" } as const;
        if (t.responder === "travar_antes") return yield* Effect.never;
        respostas.set(plan.commandId, plan);
        if (t.responder === "travar_depois") return yield* Effect.never;
        return { type: "accepted", commandId: plan.commandId } as const;
      }),
    inspectAnswer: (plan) =>
      Effect.succeed<Adapter.AnswerInspection>(
        respostas.has(plan.commandId)
          ? { type: "found", commandId: plan.commandId }
          : { type: "absent" },
      ),
  });
  return { t, adapter, fato };
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

/**
 * One machine: its saved connection, the journal's state dir, the Worker and the T3. `ligar`
 * starts the T3 server's part over them; `parar` stops it at once, which for the journal is a
 * crash, since every step it took is already durable.
 */
const maquina = Effect.gen(function* () {
  const base = yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-editaii-connector-"))),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );
  const worker = fakeWorker();
  const t3 = fakeT3();
  let salvo: Uint8Array | undefined = conectada("maquina-1");
  // The journal as it is, but for the next call of each operation named here, which fails.
  const falhar = new Set<"observar" | "proximoEvento">();
  const falha = (operacao: "observar" | "proximoEvento") =>
    falhar.delete(operacao)
      ? Effect.fail(new Journal.EditaiiJournalError({ reason: "storage", detail: operacao }))
      : Effect.void;
  const journal = Layer.effect(
    Journal.EditaiiJournal,
    Effect.gen(function* () {
      const j = yield* Journal.EditaiiJournal;
      return Journal.EditaiiJournal.of({
        ...j,
        observar: (v, trabalhoId, o) =>
          falha("observar").pipe(Effect.andThen(j.observar(v, trabalhoId, o))),
        proximoEvento: (v) => falha("proximoEvento").pipe(Effect.andThen(j.proximoEvento(v))),
      });
    }),
  ).pipe(Layer.provide(Journal.layer));
  const deps = Layer.mergeAll(
    NodeServices.layer,
    ServerConfig.layerTest(process.cwd(), base).pipe(Layer.provide(NodeServices.layer)),
    Layer.succeed(HostProcess.Platform, "linux"),
    Layer.succeed(HostProcess.Environment, {}),
    Layer.succeed(ProcessRunner.ProcessRunner, { run: () => Effect.die("unused platform probe") }),
    Layer.succeed(
      ServerSecretStore.ServerSecretStore,
      ServerSecretStore.ServerSecretStore.of({
        get: () => Effect.succeed(Option.fromUndefinedOr(salvo)),
        set: (_name, bytes) =>
          Effect.sync(() => {
            salvo = bytes;
          }),
        create: () => Effect.die("unused create"),
        getOrCreateRandom: () => Effect.die("unused random"),
        remove: () =>
          Effect.sync(() => {
            salvo = undefined;
          }),
      }),
    ),
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(ENVIRONMENT),
      getDescriptor: Effect.die("unused descriptor"),
    }),
    Layer.succeed(ExternalLauncher.ExternalLauncher, {
      resolveAvailableEditors: () => Effect.succeed([]),
      resolveFileManagerRevealKind: () => Effect.succeed("finder"),
      launchEditor: () => Effect.void,
      launchBrowser: () => Effect.die("unused browser"),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        worker.reply(request).pipe(Effect.map((r) => HttpClientResponse.fromWeb(request, r))),
      ),
    ),
    Layer.succeed(Adapter.EditaiiT3Adapter, t3.adapter),
  );
  const servidor = Connector.layer(Effect.succeed(pronta)).pipe(
    Layer.provideMerge(Layer.mergeAll(Connection.layer, journal)),
    Layer.provideMerge(deps),
  );
  const ligar = Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const context = yield* Layer.build(servidor).pipe(Effect.provideService(Scope.Scope, scope));
    const connection = Context.get(context, Connection.EditaiiConnection);
    return {
      parar: Scope.close(scope, Exit.void),
      connector: Context.get(context, Connector.EditaiiConnector),
      journal: Context.get(context, Journal.EditaiiJournal),
      vinculo: connection.state.pipe(Effect.map(Connection.vinculoDo)),
    };
  });
  return {
    worker,
    t3: t3.t,
    fato: t3.fato,
    ligar,
    falhar,
    /** The machine saved as connected the next time the T3 starts. */
    salvar: (maquinaId: string) => {
      salvo = conectada(maquinaId);
    },
  };
});

const vez = Effect.yieldNow;
/** Lets the connector run, the test clock moving as it waits, until `condicao` holds. */
const ate = Effect.fn("test.ate")(function* (
  descricao: string,
  condicao: () => boolean | Effect.Effect<boolean>,
) {
  for (let i = 0; i < 300; i++) {
    const valor = condicao();
    if (typeof valor === "boolean" ? valor : yield* valor) return;
    yield* vez;
    yield* TestClock.adjust("1 second");
  }
  return yield* Effect.die(new Error(`timed out waiting for ${descricao}`));
});
/** Lets the connector run with the clock stopped: what it records goes out without waiting. */
const semEsperar = Effect.fn("test.semEsperar")(function* (
  descricao: string,
  condicao: () => boolean,
) {
  for (let i = 0; i < 300; i++) {
    if (condicao()) return;
    yield* vez;
  }
  return yield* Effect.die(new Error(`${descricao} waited for the clock`));
});
/** Lets the connector run for a while, to show that something does not happen. */
const passar = Effect.fn("test.passar")(function* (segundos: number) {
  for (let i = 0; i < segundos; i++) {
    yield* vez;
    yield* TestClock.adjust("1 second");
  }
});
const tipos = (eventos: ReadonlyArray<Protocol.Evento>) =>
  eventos.map((e) => `${e.trabalho_id}:${e.sequencia}:${e.tipo}`);

/** Request 1 accepted, confirmed and asking question `x`, which the person sees. */
const perguntando = Effect.fn("test.perguntando")(function* (m: Effect.Success<typeof maquina>) {
  m.worker.pedir(1);
  const t3 = yield* m.ligar;
  yield* ate("the request to start", () => m.worker.estado(1) === "em_execucao");
  yield* m.fato(1, pergunta("x"));
  yield* ate("the question to reach the person", () => m.worker.estado(1) === "aguardando_pessoa");
  return t3;
});

describe("EditaiiConnector", () => {
  it.effect("carries a request, a question, its answer and the result, each invoked once", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      yield* perguntando(m);
      m.worker.responder(1, SIM);
      yield* ate("the answer to resume the job", () => m.worker.estado(1) === "em_execucao");
      yield* m.fato(1, resolvida("x"));
      yield* m.fato(1, resposta("Pronto"));
      yield* ate("the job to end", () => m.worker.estado(1) === "concluido");

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
      const trava = yield* Deferred.make<void>();
      m.worker.travarConfirmacao = trava;
      m.worker.pedir(1);
      yield* m.ligar;
      yield* ate("the request to be accepted", () => m.t3.chamadasAccept === 1);
      yield* m.fato(1, pergunta("x"));
      yield* passar(60);
      assert.equal(m.worker.estado(1), "entregue");
      assert.deepEqual(m.worker.enviados, []);

      m.worker.travarConfirmacao = null;
      yield* Deferred.succeed(trava, undefined);
      yield* ate(
        "the question to reach the person",
        () => m.worker.estado(1) === "aguardando_pessoa",
      );
      assert.deepEqual(tipos(m.worker.aplicados), ["trabalho-1:1:intervencao"]);
      assert.deepEqual(m.worker.invalidos, []);
    }).pipe(Effect.scoped),
  );

  it.effect("a request the T3 refuses fails its job, and the next one runs", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      m.t3.aceitar = "recusar";
      m.worker.pedir(1, "conversa-1");
      yield* m.ligar;
      yield* semEsperar("the failure", () => m.worker.estado(1) === "falhou");
      m.t3.aceitar = "aceitar";
      m.worker.pedir(2, "conversa-1");
      yield* ate("the next request to start", () => m.worker.estado(2) === "em_execucao");
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
      yield* ate("the answer to reach the T3", () => m.t3.chamadasRespond === 1);
      yield* semEsperar("the failure", () => m.worker.estado(1) === "falhou");
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
      yield* ate("the other request to start", () => m.worker.estado(2) === "em_execucao");
      yield* passar(60);
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
      yield* ate("the receipt to be taken", () => m.worker.estado(1) === "em_execucao");
      yield* antes.parar;

      yield* m.ligar;
      yield* m.fato(1, resposta("Pronto"));
      yield* ate("the job to end", () => m.worker.estado(1) === "concluido");
      assert.deepEqual(
        m.worker.confirmacoes.map((c) => c.entregaId),
        ["entrega-1", "entrega-1"],
      );
      assert.equal(m.t3.chamadasAccept, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("a journal failure while following a job starts the work again from the journal", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      m.falhar.add("observar");
      yield* perguntando(m);
      assert.isFalse(m.falhar.has("observar"));
      assert.deepEqual(tipos(m.worker.aplicados), ["trabalho-1:1:intervencao"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a journal failure while sending starts the work again from the journal", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      m.falhar.add("proximoEvento");
      yield* perguntando(m);
      assert.isFalse(m.falhar.has("proximoEvento"));
      assert.deepEqual(tipos(m.worker.aplicados), ["trabalho-1:1:intervencao"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a receipt whose reply was lost is sent again, the same", () =>
    Effect.gen(function* () {
      const m = yield* maquina;
      m.worker.perderResposta.add("confirmar");
      yield* perguntando(m);
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
      const trava = yield* Deferred.make<void>();
      m.worker.travarConfirmacao = trava;
      m.worker.responder(1, SIM);
      yield* ate("the answer to reach the T3", () => m.t3.chamadasRespond === 1);
      // The T3 goes on and asks again while the answer's receipt is stuck.
      yield* m.fato(1, resolvida("x"));
      yield* m.fato(1, pergunta("y"));
      yield* ate(
        "the new question to reach the person",
        () => m.worker.trabalho(1)?.intervencao?.referencia === "y",
      );

      m.worker.travarConfirmacao = null;
      yield* Deferred.succeed(trava, undefined);
      yield* ate("the answer's receipt", () =>
        m.worker.confirmacoes.some((c) => c.entregaId.startsWith("resposta-")),
      );
      yield* passar(10);
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

  describe("after a crash, an invoked delivery is only inspected", () => {
    it.effect("a request the T3 never took: the conversation stops for reconciliation", () =>
      Effect.gen(function* () {
        const m = yield* maquina;
        m.t3.aceitar = "travar_antes";
        m.worker.pedir(1);
        const antes = yield* m.ligar;
        yield* ate("the request to be invoked", () => m.t3.chamadasAccept === 1);
        yield* antes.parar;

        m.t3.aceitar = "aceitar";
        yield* m.ligar;
        yield* semEsperar("the lost thread", () => m.worker.estado(1) === "reconciliacao");
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
        yield* ate("the request to be invoked", () => m.t3.chamadasAccept === 1);
        yield* antes.parar;

        m.t3.aceitar = "aceitar";
        yield* m.ligar;
        yield* ate("the request to start", () => m.worker.estado(1) === "em_execucao");
        yield* m.fato(1, resposta("Pronto"));
        yield* ate("the job to end", () => m.worker.estado(1) === "concluido");
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
        yield* ate("the answer to be invoked", () => m.t3.chamadasRespond === 1);
        yield* antes.parar;

        m.t3.responder = "aceitar";
        yield* m.ligar;
        yield* semEsperar("the lost thread", () => m.worker.estado(1) === "reconciliacao");
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
        yield* ate("the answer to be invoked", () => m.t3.chamadasRespond === 1);
        yield* antes.parar;

        m.t3.responder = "aceitar";
        yield* m.ligar;
        yield* ate("the answer to resume the job", () => m.worker.estado(1) === "em_execucao");
        yield* m.fato(1, resolvida("x"));
        yield* m.fato(1, resposta("Pronto"));
        yield* ate("the job to end", () => m.worker.estado(1) === "concluido");
        assert.equal(m.t3.chamadasRespond, 1);
        assert.deepEqual(m.worker.invalidos, []);
      }).pipe(Effect.scoped),
    );
  });

  describe("desligar", () => {
    it.effect("returns while the Worker is unreachable, and the link says nothing more", () =>
      Effect.gen(function* () {
        const m = yield* maquina;
        const trava = yield* Deferred.make<void>();
        m.worker.travarConfirmacao = trava;
        m.worker.pedir(1);
        const t3 = yield* m.ligar;
        yield* ate("the receipt to be on its way", () =>
          m.worker.chamadas.some((c) => c.endsWith("/confirmar")),
        );

        yield* t3.connector.desligar(V1);
        assert.isNull(yield* t3.vinculo);
        const chamadas = m.worker.chamadas.length;
        m.worker.travarConfirmacao = null;
        yield* Deferred.succeed(trava, undefined);
        yield* passar(60);
        assert.equal(m.worker.chamadas.length, chamadas);
        assert.deepEqual(m.worker.confirmacoes, []);
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
        yield* ate("the link to be disconnected", () =>
          depois.vinculo.pipe(Effect.map((v) => v === null)),
        );
        yield* passar(30);
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
        yield* ate("the request to start", () => m.worker.estado(1) === "em_execucao");
        yield* m.fato(1, resposta("Pronto"));
        yield* ate("the job to end", () => m.worker.estado(1) === "concluido");
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
      yield* ate(
        "both requests to start",
        () => m.worker.estado(1) === "em_execucao" && m.worker.estado(2) === "em_execucao",
      );
      yield* m.fato(1, resposta("Um"));
      yield* m.fato(2, resposta("Dois"));
      yield* ate("the other job to end", () => m.worker.estado(2) === "concluido");
      yield* passar(60);
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
      yield* ate("the request to start", () => m.worker.estado(1) === "em_execucao");
      m.worker.perderResposta.add("eventos");
      yield* m.fato(1, resposta("Pronto"));
      yield* ate("the job to end", () => m.worker.estado(1) === "concluido");
      yield* passar(30);
      const [primeiro, segundo, ...outros] = m.worker.enviados;
      assert.deepEqual(outros, []);
      assert.include(primeiro, '"tipo":"resposta"');
      assert.equal(segundo, primeiro);
      assert.deepEqual(tipos(m.worker.aplicados), ["trabalho-1:1:resposta"]);
    }).pipe(Effect.scoped),
  );
});
