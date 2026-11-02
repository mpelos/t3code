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
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
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
 * Tells the test that something changed, so it waits for the state it expects without polling:
 * `ate` checks, and checks again only after the next change.
 */
const sinal = () => {
  let proxima = Deferred.makeUnsafe<void>();
  const ate = <A>(valor: () => A | null | undefined): Effect.Effect<A> =>
    Effect.suspend(() => {
      const v = valor();
      if (v !== null && v !== undefined) return Effect.succeed(v);
      return Deferred.await(proxima).pipe(Effect.andThen(ate(valor)));
    });
  return {
    avisar: () => {
      const mudou = proxima;
      proxima = Deferred.makeUnsafe<void>();
      Deferred.doneUnsafe(mudou, Effect.void);
    },
    ate,
    quando: (condicao: () => boolean) => ate(() => condicao() || undefined).pipe(Effect.asVoid),
  };
};
type Sinal = ReturnType<typeof sinal>;

/**
 * The Worker's side of docs/protocolo-maquinas.md, as strict as the real one (src/trabalhos.ts in
 * the editaii repository). Every event it refuses for breaking the protocol is kept in
 * `invalidos`, so a test can assert the connector never sent one. A poll is answered once there is
 * work, so no test depends on the poll interval.
 */
const fakeWorker = (mudou: Sinal) => {
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
    /** A receipt for which this gives a gate waits for it before reaching the Worker. */
    travarRecibo: (_entregaId: string): Deferred.Deferred<void> | undefined => undefined,
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
      mudou.avisar();
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
      mudou.avisar();
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
  const atender = Effect.fn("test.fakeWorker.atender")(function* (
    request: HttpClientRequest.HttpClientRequest,
  ) {
    if (request.body._tag !== "Uint8Array") throw new Error("Expected a JSON request");
    const body = JSON.parse(new TextDecoder().decode(request.body.body));
    const path = new URL(request.url).pathname.replace(/^\/api\//, "");
    w.chamadas.push(path);
    mudou.avisar();
    if (path === "maquina/entregas/proxima")
      return Response.json({ entrega: yield* mudou.ate(proxima) });
    const confirmacao = /^maquina\/entregas\/([^/]+)\/confirmar$/.exec(path)?.[1];
    if (confirmacao !== undefined) {
      const entregaId = decodeURIComponent(confirmacao);
      const trava = w.travarRecibo(entregaId);
      if (trava !== undefined) yield* Deferred.await(trava);
      const status = confirmar(entregaId, body.recibo);
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
  // Whatever the Worker did, the test hears of it before the machine reads the reply.
  const reply = (request: HttpClientRequest.HttpClientRequest) =>
    atender(request).pipe(Effect.tap(() => Effect.sync(mudou.avisar)));
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
 * crash would leave it. Each accepted run is a log the test appends facts to. Like the real
 * adapter, `observe` shows the whole run again and then follows it to its final fact; a run whose
 * thread is gone shows only that.
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
  return { t, adapter, fato, perder };
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

/** The connector's pause before it tries again; the tests let it pass only once it has begun. */
const PAUSA = Duration.seconds(5);

/**
 * One machine: its saved connection, the journal's state dir, the Worker and the T3. `ligar`
 * starts the T3 server's part over them; `parar` stops it at once, which for the journal is a
 * crash, since every step it took is already durable. Nothing here waits on time: `quando` waits
 * for the next change, and the clock moves only when a test moves it.
 */
const maquina = Effect.gen(function* () {
  const base = yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-editaii-connector-"))),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );
  const mudou = sinal();
  const worker = fakeWorker(mudou);
  const t3 = fakeT3(mudou);
  let salvo: Uint8Array | undefined = conectada("maquina-1");
  // The test clock, telling the test when the connector begins a pause.
  const relogio = yield* Clock.Clock;
  let emPausa = 0;
  const clock: Clock.Clock = {
    ...relogio,
    sleep: (duration) =>
      Duration.equals(duration, PAUSA)
        ? Effect.sync(() => {
            emPausa += 1;
            mudou.avisar();
          }).pipe(
            Effect.andThen(relogio.sleep(duration)),
            Effect.ensuring(Effect.sync(() => (emPausa -= 1))),
          )
        : relogio.sleep(duration),
  };
  // The journal as it is, but for the next call of each operation named in `falhar`, which fails,
  // and for `desligar`, which holds after writing the intent while `segurarDesligar` is set.
  const falhar = new Set<"observar" | "proximoEvento">();
  const falha = (operacao: "observar" | "proximoEvento") =>
    falhar.delete(operacao)
      ? Effect.fail(new Journal.EditaiiJournalError({ reason: "storage", detail: operacao }))
      : Effect.void;
  const desligar = {
    segurar: null as Deferred.Deferred<void> | null,
    escritos: 0,
  };
  // How many events the journal recorded as answered by the Worker.
  let eventosGravados = 0;
  const journal = Layer.effect(
    Journal.EditaiiJournal,
    Effect.gen(function* () {
      const j = yield* Journal.EditaiiJournal;
      return Journal.EditaiiJournal.of({
        ...j,
        observar: (v, trabalhoId, o) =>
          falha("observar").pipe(Effect.andThen(j.observar(v, trabalhoId, o))),
        proximoEvento: (v) => falha("proximoEvento").pipe(Effect.andThen(j.proximoEvento(v))),
        eventoEnviado: (v, evento, resultado) =>
          j.eventoEnviado(v, evento, resultado).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                eventosGravados += 1;
                mudou.avisar();
              }),
            ),
          ),
        desligar: (v) =>
          j.desligar(v).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                desligar.escritos += 1;
                mudou.avisar();
              }),
            ),
            Effect.andThen(
              Effect.suspend(() =>
                desligar.segurar === null ? Effect.void : Deferred.await(desligar.segurar),
              ),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(Journal.layer));
  const deps = Layer.mergeAll(
    NodeServices.layer,
    ServerConfig.layerTest(process.cwd(), base).pipe(Layer.provide(NodeServices.layer)),
    Layer.succeed(Clock.Clock, clock),
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
      /** Waits until no link is connected. */
      desconectado: connection.changes.pipe(
        Stream.filter((s) => Connection.vinculoDo(s) === null),
        Stream.take(1),
        Stream.runDrain,
      ),
    };
  });
  return {
    worker,
    t3: t3.t,
    fato: t3.fato,
    perder: t3.perder,
    ligar,
    falhar,
    desligar,
    quando: mudou.quando,
    eventosGravados: () => eventosGravados,
    /** Lets the connector's pause pass, once it has begun one. */
    pausa: mudou.quando(() => emPausa > 0).pipe(Effect.andThen(TestClock.adjust(PAUSA))),
    /** The machine saved as connected the next time the T3 starts. */
    salvar: (maquinaId: string) => {
      salvo = conectada(maquinaId);
    },
  };
});
type Maquina = Effect.Success<typeof maquina>;

/** Long enough for any pause and retry to run, to show that something does not happen. */
const umMinuto = TestClock.adjust("1 minute");
const tipos = (eventos: ReadonlyArray<Protocol.Evento>) =>
  eventos.map((e) => `${e.trabalho_id}:${e.sequencia}:${e.tipo}`);

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

/** The receipts of the deliveries chosen wait for the gate returned before reaching the Worker. */
const travar = (m: Maquina, entregaId: (id: string) => boolean) =>
  Effect.gen(function* () {
    const trava = yield* Deferred.make<void>();
    m.worker.travarRecibo = (id) => (entregaId(id) ? trava : undefined);
    return trava;
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
