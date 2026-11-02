// @effect-diagnostics nodeBuiltinImport:off -- The journal is a real file in a temporary state dir.
/**
 * A machine for tests of the Editaii connector: its saved connection, the real journal in a
 * temporary state dir, and a Worker as strict as the real one. The T3 comes from the test, fake
 * or real, at each start. Nothing here waits on time: `quando` waits for the next change, and
 * the clock moves only when a test moves it.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
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
import * as Protocol from "./EditaiiProtocol.ts";
import * as Painel from "./EditaiiPainel.ts";
import * as Runtime from "./EditaiiRuntime.ts";
import type * as Adapter from "./EditaiiT3Adapter.ts";

const ORIGIN = "https://editaii.example";
const ENVIRONMENT = EnvironmentId.make("connector-environment");
const vinculo = (maquina: string): Connection.EditaiiVinculo => ({
  origem: ORIGIN,
  maquina,
  ambiente: ENVIRONMENT,
});
export const V1 = vinculo("maquina-1");
export const V2 = vinculo("maquina-2");
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
export type Sinal = ReturnType<typeof sinal>;

// What the connector sends the Worker: a receipt, or events.
const lerCorpo = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      recibo: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      eventos: Schema.optional(Schema.Array(Protocol.Evento)),
    }),
  ),
);
const textoDoEvento = Schema.encodeSync(Schema.fromJsonString(Protocol.Evento));

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
    /** An event for which this gives a gate waits for it before reaching the Worker. */
    travarEvento: (_evento: Protocol.Evento): Deferred.Deferred<void> | undefined => undefined,
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
    const body = lerCorpo(new TextDecoder().decode(request.body.body));
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
      const status = confirmar(entregaId, body.recibo ?? {});
      if (status === 200 && perdida("confirmar")) return new Response("lost", { status: 502 });
      return status === 200 ? Response.json({ ok: true }) : new Response("", { status });
    }
    if (path === "maquina/eventos") {
      const eventos = body.eventos ?? [];
      for (const evento of eventos) {
        const trava = w.travarEvento(evento);
        if (trava !== undefined) yield* Deferred.await(trava);
        w.enviados.push(textoDoEvento(evento));
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

/** The connector's pause before it tries again; the tests let it pass only once it has begun. */
const PAUSA = Duration.seconds(5);

/**
 * One machine: its saved connection, the journal's state dir, the Worker and the T3. `ligar`
 * starts the T3 server's part over them; `parar` stops it at once, which for the journal is a
 * crash, since every step it took is already durable. Nothing here waits on time: `quando` waits
 * for the next change, and the clock moves only when a test moves it.
 */
export const make = Effect.fn("EditaiiMaquina.make")(function* () {
  const base = yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-editaii-connector-"))),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );
  const mudou = sinal();
  const worker = fakeWorker(mudou);
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
  type Operacao = "observar" | "proximoEvento" | "resolver";
  const falhar = new Set<Operacao>();
  const falha = (operacao: Operacao) =>
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
        resolver: (v, entregaId, desfecho) =>
          falha("resolver").pipe(Effect.andThen(j.resolver(v, entregaId, desfecho))),
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
  );
  /** Starts `servidor`, the T3 server's part, over the machine. */
  const subir = Effect.fn("EditaiiMaquina.subir")(function* <ROut, E>(
    servidor: Layer.Layer<ROut | Connection.EditaiiConnection, E>,
  ) {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const context = yield* Layer.build(servidor).pipe(Effect.provideService(Scope.Scope, scope));
    const connection = Context.get(context, Connection.EditaiiConnection);
    return {
      parar: Scope.close(scope, Exit.void),
      context,
      connection,
      vinculo: connection.state.pipe(Effect.map(Connection.vinculoDo)),
      /** Waits until no link is connected. */
      desconectado: connection.changes.pipe(
        Stream.filter((s) => Connection.vinculoDo(s) === null),
        Stream.take(1),
        Stream.runDrain,
      ),
    };
  });
  /**
   * Starts the connector over the machine, with the T3 that `t3` builds and new conversations
   * configured by `configuracao`.
   */
  const ligar = <ROut, E>(
    t3: Layer.Layer<Adapter.EditaiiT3Adapter | ROut, E>,
    configuracao: Effect.Effect<Journal.Configuracao, Journal.EditaiiConfiguracaoIlegivel>,
  ) =>
    subir(
      Connector.layer(configuracao).pipe(
        Layer.provideMerge(Layer.mergeAll(Connection.layer, journal)),
        Layer.provideMerge(Layer.merge(deps, t3)),
      ),
    ).pipe(
      Effect.map((ligado) => ({
        ...ligado,
        connector: Context.get(ligado.context, Connector.EditaiiConnector),
        journal: Context.get(ligado.context, Journal.EditaiiJournal),
      })),
    );
  type ServicosDoT3 = Exclude<Layer.Services<typeof Runtime.layer>, Layer.Success<typeof deps>>;
  /**
   * Starts the Editaii over the machine as the T3 server mounts it (EditaiiRuntime.ts), with the
   * services of the T3 that `t3` builds; the journal is the real one, with no failures injected.
   */
  const montar = <ROut, E>(t3: Layer.Layer<ServicosDoT3 | ROut, E>) =>
    subir(Runtime.layer.pipe(Layer.provideMerge(Layer.merge(deps, t3)))).pipe(
      Effect.map((montado) => ({
        ...montado,
        painel: Context.get(montado.context, Painel.EditaiiPainel),
      })),
    );
  return {
    worker,
    mudou,
    ligar,
    montar,
    falhar,
    desligar,
    quando: mudou.quando,
    eventosGravados: () => eventosGravados,
    /** Waits until the connector is in a pause, which lasts until the test moves the clock. */
    pausado: mudou.quando(() => emPausa > 0),
    /** Lets the connector's pause pass, once it has begun one. */
    pausa: mudou.quando(() => emPausa > 0).pipe(Effect.andThen(TestClock.adjust(PAUSA))),
    /** The connection's record as saved now. */
    registro: (): unknown =>
      salvo === undefined ? undefined : JSON.parse(new TextDecoder().decode(salvo)),
    /** The machine saved as connected the next time the T3 starts. */
    salvar: (maquinaId: string) => {
      salvo = conectada(maquinaId);
    },
  };
});
export type Maquina = Effect.Success<ReturnType<typeof make>>;

/** Long enough for any pause and retry to run, to show that something does not happen. */
export const umMinuto = TestClock.adjust("1 minute");
export const tipos = (eventos: ReadonlyArray<Protocol.Evento>) =>
  eventos.map((e) => `${e.trabalho_id}:${e.sequencia}:${e.tipo}`);

/** The receipts of the deliveries chosen wait for the gate returned before reaching the Worker. */
export const travar = (m: Pick<Maquina, "worker">, entregaId: (id: string) => boolean) =>
  Effect.gen(function* () {
    const trava = yield* Deferred.make<void>();
    m.worker.travarRecibo = (id) => (entregaId(id) ? trava : undefined);
    return trava;
  });

/** The events chosen wait for the gate returned before reaching the Worker. */
export const travarEventos = (
  m: Pick<Maquina, "worker">,
  escolhido: (evento: Protocol.Evento) => boolean,
) =>
  Effect.gen(function* () {
    const trava = yield* Deferred.make<void>();
    m.worker.travarEvento = (evento) => (escolhido(evento) ? trava : undefined);
    return trava;
  });
