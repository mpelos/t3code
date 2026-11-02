// @effect-diagnostics nodeBuiltinImport:off - SHA-256 of local identities, computed inside transactions.
/**
 * The Editaii connector's durable memory: deliveries, jobs, pending requests and the events owed
 * to the Worker. It lives in its own SQLite file, apart from the T3's database, and owns every
 * transition: each operation reads, decides and writes in one transaction, so the connector never
 * reads state, decides and saves. See docs/conector-t3.md in the editaii repository.
 */
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  MessageId,
  type ModelSelection,
  OrchestrationV2UserInputQuestion,
  type ProjectId,
  type ProviderInteractionMode,
  RuntimeRequestId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import type { EditaiiVinculo } from "./EditaiiConnection.ts";
import { promptFor } from "./EditaiiPrompt.ts";
import * as Protocol from "./EditaiiProtocol.ts";
import { Acceptance, AnswerPlan, type Observation, RequestPlan } from "./EditaiiT3Adapter.ts";
import { answersFor, Traducao, translateQuestions } from "./EditaiiTranslation.ts";

export class EditaiiJournalError extends Schema.TaggedError<EditaiiJournalError>()(
  "EditaiiJournalError",
  {
    /**
     * future_version: written by a newer T3. invalid_data: a stored value no longer decodes.
     * conflict: the Worker contradicts what the journal recorded; nothing was overwritten.
     */
    reason: Schema.Literals(["future_version", "invalid_data", "conflict", "storage"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Editaii journal ${this.reason}: ${this.detail}`;
  }
}

/** How a new conversation's T3 thread runs, read from the T3 settings when a request arrives. */
export type Configuracao =
  | {
      readonly type: "pronta";
      readonly projectId: ProjectId;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    }
  | { readonly type: "indisponivel"; readonly motivo: string };

/** What the T3 is asked to do for one delivery; the plan is frozen when the delivery arrives. */
export type Execucao =
  | { readonly tipo: "pedido"; readonly entregaId: string; readonly plano: RequestPlan }
  | { readonly tipo: "resposta"; readonly entregaId: string; readonly plano: AnswerPlan };

/** What the connector does next with a delivery. */
export type Passo =
  /**
   * Before the conversation goes on, follow its last ended job in the T3 until the T3 shows the
   * fact that ended it, or another end; then receive the delivery again.
   */
  | { readonly type: "conferir"; readonly observado: Observado }
  /** Invoke the T3 now. */
  | { readonly type: "executar"; readonly execucao: Execucao }
  /** The T3 was invoked and the outcome is unknown: only inspection decides, never invoking again. */
  | { readonly type: "inspecionar"; readonly execucao: Execucao }
  /** Send the receipt. */
  | { readonly type: "confirmar"; readonly entregaId: string; readonly recibo: Protocol.Recibo }
  /** Nothing to do; the outbox tells the Worker the rest. */
  | { readonly type: "aguardar" };

/** The outcome of invoking or inspecting the T3 for one delivery. */
export type Desfecho =
  | { readonly tipo: "aceita"; readonly aceitacao: Acceptance }
  | { readonly tipo: "respondida"; readonly comando: CommandId }
  | { readonly tipo: "recusada" }
  | { readonly tipo: "thread_ausente" }
  | { readonly tipo: "superada" }
  | { readonly tipo: "nao_retomavel" }
  | { readonly tipo: "incerta" };

/** A confirmed job the connector follows in the T3, from `cursor` on. */
export interface Observado {
  readonly trabalhoId: string;
  readonly aceitacao: Acceptance;
  readonly cursor: number | null;
}

export type Partida =
  | { readonly type: "desligar" }
  | {
      readonly type: "retomar";
      readonly confirmar: ReadonlyArray<{
        readonly entregaId: string;
        readonly recibo: Protocol.Recibo;
      }>;
      readonly observar: ReadonlyArray<Observado>;
    };

export interface EditaiiJournalShape {
  /**
   * First call for a link. A pending disconnect comes first: nothing of that link may go out.
   * Else the receipts the Worker may not have taken (it never serves a confirmed delivery again)
   * and the confirmed jobs to follow. The T3 may have lost its last commits before this start, so
   * each conversation is checked again (`conferir`) before its next request.
   */
  readonly partida: (vinculo: EditaiiVinculo) => Effect.Effect<Partida, EditaiiJournalError>;
  /**
   * Records a delivery the Worker served. A new one is checked against the local conversation and
   * frozen into a plan, already marked as invoked; a repeated one resumes where it stopped. Same
   * id with another envelope is a conflict.
   */
  readonly receber: (
    vinculo: EditaiiVinculo,
    entrega: Protocol.Entrega,
    configuracao: Configuracao,
  ) => Effect.Effect<Passo, EditaiiJournalError>;
  /** Records what the T3 did with an invoked delivery, with its effects on the job and its events. */
  readonly resolver: (
    vinculo: EditaiiVinculo,
    entregaId: string,
    desfecho: Desfecho,
  ) => Effect.Effect<Passo, EditaiiJournalError>;
  /**
   * The Worker took the receipt (`ok`) or refused it (`conflito`). A request's receipt starts the
   * job, which the connector then follows; before it the Worker accepts no other event.
   */
  readonly confirmada: (
    vinculo: EditaiiVinculo,
    entregaId: string,
    resultado: "ok" | "conflito",
  ) => Effect.Effect<Observado | null, EditaiiJournalError>;
  /**
   * Projects one observation of a followed job; `fim` once the job ended here. A job that already
   * ended is only followed to check its conversation: the fact that ended it lets it go on, and
   * another end or a lost thread stops it. A request the T3 closed showing pending again means
   * the T3 went back to before it closed, an answer included: the job stops as a lost thread.
   */
  readonly observar: (
    vinculo: EditaiiVinculo,
    trabalhoId: string,
    observacao: Observation,
  ) => Effect.Effect<"seguir" | "fim", EditaiiJournalError>;
  /**
   * The next event to send: each job in strict order, jobs in turn, nothing from a job the Worker
   * refused nor from a link being disconnected. A lost send repeats the same event.
   */
  readonly proximoEvento: (
    vinculo: EditaiiVinculo,
  ) => Effect.Effect<Protocol.Evento | null, EditaiiJournalError>;
  readonly eventoEnviado: (
    vinculo: EditaiiVinculo,
    evento: Protocol.Evento,
    resultado: "ok" | "conflito",
  ) => Effect.Effect<void, EditaiiJournalError>;
  /** Records the intent to abandon the link; from then on it starts and sends nothing. */
  readonly desligar: (vinculo: EditaiiVinculo) => Effect.Effect<void, EditaiiJournalError>;
}

export class EditaiiJournal extends Context.Service<EditaiiJournal, EditaiiJournalShape>()(
  "t3/editaii/EditaiiJournal",
) {}

/**
 * Each entry is one schema version, applied in a transaction together with its `user_version`, so
 * an interrupted upgrade leaves the previous version whole. Never edit a published entry.
 */
const MIGRATIONS: ReadonlyArray<ReadonlyArray<string>> = [
  [
    `CREATE TABLE vinculos (
      vinculo TEXT PRIMARY KEY,
      origem TEXT NOT NULL,
      maquina TEXT NOT NULL,
      ambiente TEXT NOT NULL,
      UNIQUE (origem, maquina, ambiente)
    ) STRICT`,
    `CREATE TABLE conversas (
      vinculo TEXT NOT NULL REFERENCES vinculos (vinculo),
      conversa_id TEXT NOT NULL,
      geracao INTEGER NOT NULL,
      thread_reservada TEXT NOT NULL,
      thread_associada TEXT,
      bloqueio TEXT,
      -- Whether, since the last start, the T3 was seen to still have the conversation's last ended
      -- job: it ended while followed, or it was checked.
      conferida INTEGER NOT NULL DEFAULT 0 CHECK (conferida IN (0, 1)),
      PRIMARY KEY (vinculo, conversa_id)
    ) STRICT`,
    `CREATE TABLE trabalhos (
      vinculo TEXT NOT NULL,
      trabalho_id TEXT NOT NULL,
      conversa_id TEXT NOT NULL,
      entrega_pedido TEXT NOT NULL,
      estado TEXT NOT NULL CHECK (estado IN
        ('entregue', 'em_execucao', 'aguardando_pessoa', 'acao_no_t3', 'concluido', 'falhou', 'parado')),
      cursor INTEGER,
      -- The key of the T3 fact that ended the job here, its final answer or failure: after a
      -- restart, the conversation goes on only once the T3 shows that same fact again.
      marco_t3 TEXT,
      retido_em TEXT,
      PRIMARY KEY (vinculo, trabalho_id),
      FOREIGN KEY (vinculo, conversa_id) REFERENCES conversas (vinculo, conversa_id),
      FOREIGN KEY (vinculo, entrega_pedido) REFERENCES entregas (vinculo, entrega_id)
        DEFERRABLE INITIALLY DEFERRED
    ) STRICT`,
    `CREATE TABLE entregas (
      vinculo TEXT NOT NULL,
      entrega_id TEXT NOT NULL,
      trabalho_id TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('pedido', 'resposta')),
      envelope TEXT NOT NULL,
      plano TEXT,
      fase TEXT NOT NULL CHECK (fase IN ('iniciada', 'resolvida')),
      desfecho TEXT,
      -- The Worker's verdict on the receipt; until it comes, the receipt is sent again.
      confirmacao TEXT CHECK (confirmacao IN ('aceita', 'recusada')),
      PRIMARY KEY (vinculo, entrega_id),
      FOREIGN KEY (vinculo, trabalho_id) REFERENCES trabalhos (vinculo, trabalho_id)
        DEFERRABLE INITIALLY DEFERRED,
      CHECK ((fase = 'resolvida') = (desfecho IS NOT NULL)),
      CHECK (plano IS NOT NULL OR fase = 'resolvida'),
      CHECK (confirmacao IS NULL OR fase = 'resolvida')
    ) STRICT`,
    `CREATE TABLE pendencias (
      vinculo TEXT NOT NULL,
      trabalho_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      ordem INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('pergunta', 'aprovacao')),
      capability TEXT NOT NULL CHECK (capability IN ('live', 'message', 'not_resumable')),
      estado TEXT NOT NULL CHECK (estado IN ('pendente', 'selecionada', 'encerrada')),
      encerramento TEXT CHECK (encerramento IN ('resolved', 'cancelled', 'expired', 'terminal')),
      original TEXT NOT NULL,
      traducao TEXT,
      PRIMARY KEY (vinculo, trabalho_id, request_id),
      UNIQUE (vinculo, trabalho_id, ordem),
      FOREIGN KEY (vinculo, trabalho_id) REFERENCES trabalhos (vinculo, trabalho_id),
      CHECK ((estado = 'encerrada') = (encerramento IS NOT NULL))
    ) STRICT`,
    // A job waits on one request at a time; the others queue behind it.
    `CREATE UNIQUE INDEX pendencias_uma_selecionada ON pendencias (vinculo, trabalho_id)
      WHERE estado = 'selecionada'`,
    `CREATE TABLE eventos (
      vinculo TEXT NOT NULL,
      trabalho_id TEXT NOT NULL,
      sequencia INTEGER NOT NULL CHECK (sequencia >= 1),
      corpo TEXT NOT NULL,
      enviado_em TEXT,
      PRIMARY KEY (vinculo, trabalho_id, sequencia),
      FOREIGN KEY (vinculo, trabalho_id) REFERENCES trabalhos (vinculo, trabalho_id)
    ) STRICT`,
    `CREATE TABLE desligamentos (
      vinculo TEXT PRIMARY KEY REFERENCES vinculos (vinculo),
      pedido_em TEXT NOT NULL
    ) STRICT`,
  ],
];

const storage = (detail: string) => (cause: unknown) =>
  new EditaiiJournalError({ reason: "storage", detail, cause });
const invalid = (detail: string) => (cause: unknown) =>
  new EditaiiJournalError({ reason: "invalid_data", detail, cause });
const conflict = (detail: string) => new EditaiiJournalError({ reason: "conflict", detail });
const isJournalError = Schema.is(EditaiiJournalError);

const open = Effect.fn("EditaiiJournal.open")(function* (filename: string) {
  const context = yield* Layer.build(NodeSqliteClient.layer({ filename })).pipe(
    Effect.mapError(storage("open")),
  );
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* Effect.gen(function* () {
    yield* sql`PRAGMA busy_timeout = 5000`;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* sql`PRAGMA journal_mode = WAL`;
    // Every commit is a promise to the Worker or a record that the T3 was invoked: FULL survives power loss.
    yield* sql`PRAGMA synchronous = FULL`;
    yield* sql`PRAGMA checkpoint_fullfsync = ON`;
  }).pipe(Effect.mapError(storage("configure")));

  const [header] = yield* sql<{ readonly user_version: number }>`PRAGMA user_version`.pipe(
    Effect.mapError(storage("read version")),
  );
  const version = header?.user_version ?? 0;
  if (version > MIGRATIONS.length) {
    return yield* new EditaiiJournalError({
      reason: "future_version",
      detail: `${filename} is at version ${version}; this T3 knows up to ${MIGRATIONS.length}`,
    });
  }
  for (const [index, statements] of MIGRATIONS.entries()) {
    if (index < version) continue;
    yield* Effect.gen(function* () {
      for (const statement of statements) yield* sql.unsafe(statement);
      yield* sql.unsafe(`PRAGMA user_version = ${index + 1}`);
    }).pipe(sql.withTransaction, Effect.mapError(storage(`migrate to ${index + 1}`)));
  }
  return sql;
});

// Stored JSON is closed and versioned; anything else fails visibly as invalid_data.
const DesfechoGravado = Schema.Union([
  Schema.Struct({
    versao: Schema.Literal(1),
    tipo: Schema.Literal("aceita"),
    aceitacao: Acceptance,
  }),
  Schema.Struct({
    versao: Schema.Literal(1),
    tipo: Schema.Literal("respondida"),
    comando: CommandId,
  }),
  Schema.Struct({
    versao: Schema.Literal(1),
    tipo: Schema.Literals(["recusada", "thread_ausente", "superada", "nao_retomavel", "incerta"]),
  }),
  // Settled here without invoking the T3; `evento` is what the Worker was told.
  Schema.Struct({
    versao: Schema.Literal(1),
    tipo: Schema.Literal("nao_executada"),
    evento: Schema.Literals(["falha", "thread_perdida"]),
  }),
]);
type DesfechoGravado = typeof DesfechoGravado.Type;
const Bloqueio = Schema.Struct({
  versao: Schema.Literal(1),
  motivo: Schema.Literals(["thread_perdida", "conflito"]),
  desde: Schema.String,
});
const Original = Schema.Union([
  Schema.Struct({
    tipo: Schema.Literal("pergunta"),
    questions: Schema.Array(OrchestrationV2UserInputQuestion),
  }),
  Schema.Struct({ tipo: Schema.Literal("aprovacao"), description: Schema.String }),
]);

const codec = <T, E>(schema: Schema.Codec<T, E>, what: string) => {
  const json = Schema.fromJsonString(schema);
  const encode = Schema.encodeEffect(json);
  const decode = Schema.decodeEffect(json);
  return {
    encode: (value: T) => encode(value).pipe(Effect.mapError(invalid(`encode ${what}`))),
    decode: (text: string) => decode(text).pipe(Effect.mapError(invalid(`decode ${what}`))),
  };
};
const envelopeJson = codec(Protocol.Entrega, "envelope");
const requestPlanJson = codec(RequestPlan, "request plan");
const answerPlanJson = codec(AnswerPlan, "answer plan");
const desfechoJson = codec(DesfechoGravado, "outcome");
const bloqueioJson = codec(Bloqueio, "block");
const originalJson = codec(Original, "request");
const traducaoJson = codec(Traducao, "translation");
const eventoJson = codec(Protocol.Evento, "event");

type Corpo<E> = E extends unknown ? Omit<E, "id" | "trabalho_id" | "sequencia"> : never;
/** An event before the journal numbers it. */
type CorpoEvento = Corpo<Protocol.Evento>;

const hash = (...parts: ReadonlyArray<string | number>) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
/** The link's key: its readable tuple, canonical. Every key and id below is scoped by it. */
const chave = (v: EditaiiVinculo) => hash(v.origem, v.maquina, v.ambiente);
/** T3 ids are namespaced by the whole link, so two links never share a thread or a command. */
const threadReservada = (vinculo: string, conversa: string, geracao: number) =>
  `editaii:${hash(vinculo, conversa, geracao)}`;
const idDaEntrega = (vinculo: string, entrega: string) => `editaii:${hash(vinculo, entrega)}`;

/** Confirmed jobs that have not ended: the ones followed in the T3. */
const ATIVOS: ReadonlyArray<string> = ["em_execucao", "aguardando_pessoa", "acao_no_t3"];
const naoTerminou = (estado: string) => estado === "entregue" || ATIVOS.includes(estado);
const QUESTION_NEEDS_T3 = "Uma pergunta da IA só pode ser respondida no próprio T3.";

type EntregaRow = {
  readonly trabalho_id: string;
  readonly tipo: "pedido" | "resposta";
  readonly envelope: string;
  readonly plano: string | null;
  readonly fase: "iniciada" | "resolvida";
  readonly desfecho: string | null;
  readonly confirmacao: "aceita" | "recusada" | null;
};
type ConversaRow = {
  readonly geracao: number;
  readonly thread_reservada: string;
  readonly thread_associada: string | null;
  readonly bloqueio: string | null;
  readonly conferida: 0 | 1;
};
/** The Worker and the journal must agree on the conversation; a stopped one runs nothing more. */
const diverge = (local: ConversaRow | undefined, enviada: Protocol.Conversa) =>
  (local?.bloqueio ?? null) !== null ||
  (local !== undefined && local.geracao !== enviada.geracao) ||
  enviada.thread_t3 !== (local?.thread_associada ?? null);
type TrabalhoRow = {
  readonly trabalho_id: string;
  readonly conversa_id: string;
  readonly entrega_pedido: string;
  readonly estado: string;
  readonly cursor: number | null;
  readonly marco_t3: string | null;
};
type PendenciaRow = {
  readonly request_id: string;
  readonly tipo: "pergunta" | "aprovacao";
  readonly capability: "live" | "message" | "not_resumable";
  readonly estado: "pendente" | "selecionada" | "encerrada";
  readonly original: string;
  readonly traducao: string | null;
};

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs
    .makeDirectory(stateDir, { recursive: true })
    .pipe(Effect.mapError(storage("state dir")));
  const sql = yield* open(path.join(stateDir, "editaii.sqlite"));

  /** One domain operation, one transaction. */
  const transacao = <A, E>(nome: string, efeito: Effect.Effect<A, E>) =>
    efeito.pipe(
      sql.withTransaction,
      Effect.mapError((e) => (isJournalError(e) ? e : storage(nome)(e))),
    );
  const agora = Effect.map(DateTime.now, DateTime.formatIso);

  const garantirVinculo = (v: EditaiiVinculo, k: string) =>
    sql`INSERT INTO vinculos (vinculo, origem, maquina, ambiente)
        VALUES (${k}, ${v.origem}, ${v.maquina}, ${v.ambiente}) ON CONFLICT DO NOTHING`;
  const desligando = Effect.fn(function* (k: string) {
    const rows = yield* sql`SELECT 1 FROM desligamentos WHERE vinculo = ${k}`;
    return rows.length > 0;
  });

  const trabalho = Effect.fn(function* (k: string, trabalhoId: string) {
    const [row] = yield* sql<TrabalhoRow>`
      SELECT trabalho_id, conversa_id, entrega_pedido, estado, cursor, marco_t3 FROM trabalhos
      WHERE vinculo = ${k} AND trabalho_id = ${trabalhoId}`;
    if (row === undefined) return yield* conflict(`unknown job ${trabalhoId}`);
    return row;
  });
  const setEstado = (k: string, trabalhoId: string, estado: string) =>
    sql`UPDATE trabalhos SET estado = ${estado} WHERE vinculo = ${k} AND trabalho_id = ${trabalhoId}`;

  /** Appends the job's next event; its sequence is born here, in the projection's transaction. */
  const emitir = Effect.fn(function* (k: string, trabalhoId: string, corpo: CorpoEvento) {
    const [last] = yield* sql<{ readonly n: number }>`
      SELECT COALESCE(MAX(sequencia), 0) AS n FROM eventos
      WHERE vinculo = ${k} AND trabalho_id = ${trabalhoId}`;
    const sequencia = (last?.n ?? 0) + 1;
    const evento: Protocol.Evento = {
      ...corpo,
      id: `editaii:${trabalhoId}:${sequencia}`,
      trabalho_id: trabalhoId,
      sequencia,
    };
    const texto = yield* eventoJson.encode(evento);
    yield* sql`INSERT INTO eventos (vinculo, trabalho_id, sequencia, corpo)
               VALUES (${k}, ${trabalhoId}, ${sequencia}, ${texto})`;
  });

  const bloquear = Effect.fn(function* (
    k: string,
    conversaId: string,
    motivo: "thread_perdida" | "conflito",
  ) {
    const bloqueio = yield* bloqueioJson.encode({ versao: 1, motivo, desde: yield* agora });
    yield* sql`UPDATE conversas SET bloqueio = COALESCE(bloqueio, ${bloqueio})
               WHERE vinculo = ${k} AND conversa_id = ${conversaId}`;
  });

  /** The job ends here: its open requests close with it, and nothing it observes applies any more. */
  const encerrar = Effect.fn(function* (
    k: string,
    trabalhoId: string,
    estado: "concluido" | "falhou" | "parado",
  ) {
    yield* setEstado(k, trabalhoId, estado);
    yield* sql`UPDATE pendencias SET estado = 'encerrada', encerramento = 'terminal'
               WHERE vinculo = ${k} AND trabalho_id = ${trabalhoId} AND estado != 'encerrada'`;
  });
  const conferida = (k: string, conversaId: string) =>
    sql`UPDATE conversas SET conferida = 1 WHERE vinculo = ${k} AND conversa_id = ${conversaId}`;
  /** The T3 ended the job with fact `marco`, which a later check must find again; seen live, it is. */
  const encerradoPeloT3 = Effect.fn(function* (
    k: string,
    t: TrabalhoRow,
    estado: "concluido" | "falhou",
    marco: string,
  ) {
    yield* encerrar(k, t.trabalho_id, estado);
    yield* sql`UPDATE trabalhos SET marco_t3 = ${marco}
               WHERE vinculo = ${k} AND trabalho_id = ${t.trabalho_id}`;
    yield* conferida(k, t.conversa_id);
  });
  const perderThread = Effect.fn(function* (k: string, t: TrabalhoRow) {
    yield* emitir(k, t.trabalho_id, { tipo: "thread_perdida" });
    yield* encerrar(k, t.trabalho_id, "parado");
    yield* bloquear(k, t.conversa_id, "thread_perdida");
  });

  const pendencia = Effect.fn(function* (k: string, trabalhoId: string, requestId: string) {
    const [p] = yield* sql<PendenciaRow>`
      SELECT request_id, tipo, capability, estado, original, traducao FROM pendencias
      WHERE vinculo = ${k} AND trabalho_id = ${trabalhoId} AND request_id = ${requestId}`;
    return p;
  });
  const selecionada = Effect.fn(function* (k: string, trabalhoId: string) {
    const [p] = yield* sql<PendenciaRow>`
      SELECT request_id, tipo, capability, estado, original, traducao FROM pendencias
      WHERE vinculo = ${k} AND trabalho_id = ${trabalhoId} AND estado = 'selecionada'`;
    return p;
  });

  /** When the job waits on nobody, its oldest pending request becomes the one it waits on. */
  const selecionarProxima = Effect.fn(function* (k: string, trabalhoId: string) {
    if ((yield* selecionada(k, trabalhoId)) !== undefined) return;
    const [p] = yield* sql<PendenciaRow>`
      SELECT request_id, tipo, capability, estado, original, traducao FROM pendencias
      WHERE vinculo = ${k} AND trabalho_id = ${trabalhoId} AND estado = 'pendente'
      ORDER BY ordem LIMIT 1`;
    if (p === undefined) return;
    const original = yield* originalJson.decode(p.original);
    // The Editaii can offer a question it can deliver an answer to; anything else is an action in the T3.
    if (
      original.tipo === "pergunta" &&
      p.capability !== "not_resumable" &&
      Arr.isReadonlyArrayNonEmpty(original.questions)
    ) {
      const traducao = translateQuestions(original.questions);
      const texto = yield* traducaoJson.encode(traducao);
      yield* sql`UPDATE pendencias SET estado = 'selecionada', traducao = ${texto}
                 WHERE vinculo = ${k} AND trabalho_id = ${trabalhoId} AND request_id = ${p.request_id}`;
      yield* emitir(k, trabalhoId, {
        tipo: "intervencao",
        referencia: p.request_id,
        perguntas: traducao.perguntas,
      });
      yield* setEstado(k, trabalhoId, "aguardando_pessoa");
      return;
    }
    yield* sql`UPDATE pendencias SET estado = 'selecionada'
               WHERE vinculo = ${k} AND trabalho_id = ${trabalhoId} AND request_id = ${p.request_id}`;
    yield* emitir(k, trabalhoId, {
      tipo: "acao_necessaria",
      descricao: original.tipo === "aprovacao" ? original.description : QUESTION_NEEDS_T3,
    });
    yield* setEstado(k, trabalhoId, "acao_no_t3");
  });

  /** A request closes by an explicit fact. Only the one the job waits on tells the Worker the wait ended. */
  const fecharPendencia = Effect.fn(function* (
    k: string,
    trabalhoId: string,
    requestId: string,
    encerramento: "resolved" | "cancelled" | "expired",
  ) {
    const p = yield* pendencia(k, trabalhoId, requestId);
    if (p === undefined || p.estado === "encerrada") return;
    yield* sql`UPDATE pendencias SET estado = 'encerrada', encerramento = ${encerramento}
               WHERE vinculo = ${k} AND trabalho_id = ${trabalhoId} AND request_id = ${requestId}`;
    if (p.estado !== "selecionada") return;
    yield* emitir(k, trabalhoId, { tipo: "retomado" });
    yield* setEstado(k, trabalhoId, "em_execucao");
    yield* selecionarProxima(k, trabalhoId);
  });

  const registrarPendencia = Effect.fn(function* (
    k: string,
    t: TrabalhoRow,
    o: Extract<Observation, { type: "question" | "approval" }>,
  ) {
    const trabalhoId = t.trabalho_id;
    const p = yield* pendencia(k, trabalhoId, o.requestId);
    if (p === undefined) {
      const original = yield* originalJson.encode(
        o.type === "question"
          ? { tipo: "pergunta", questions: o.questions }
          : { tipo: "aprovacao", description: o.description },
      );
      yield* sql`INSERT INTO pendencias
          (vinculo, trabalho_id, request_id, ordem, run_id, tipo, capability, estado, original)
        SELECT ${k}, ${trabalhoId}, ${o.requestId}, COALESCE(MAX(ordem), 0) + 1, ${o.runId},
               ${o.type === "question" ? "pergunta" : "aprovacao"}, ${o.capability}, 'pendente', ${original}
        FROM pendencias WHERE vinculo = ${k} AND trabalho_id = ${trabalhoId}`;
      yield* selecionarProxima(k, trabalhoId);
      return "seguir" as const;
    }
    // The T3 never reopens a request it closed; its observations of a job only move forward.
    if (p.estado === "encerrada") {
      yield* perderThread(k, t);
      return "fim" as const;
    }
    if (p.capability === o.capability) return "seguir" as const;
    yield* sql`UPDATE pendencias SET capability = ${o.capability}
               WHERE vinculo = ${k} AND trabalho_id = ${trabalhoId} AND request_id = ${o.requestId}`;
    // The question the Editaii offers can no longer be answered there: its wait ends, and it is an action in the T3.
    if (p.estado === "selecionada" && p.traducao !== null && o.capability === "not_resumable") {
      yield* emitir(k, trabalhoId, { tipo: "retomado" });
      yield* emitir(k, trabalhoId, { tipo: "acao_necessaria", descricao: QUESTION_NEEDS_T3 });
      yield* setEstado(k, trabalhoId, "acao_no_t3");
    }
    return "seguir" as const;
  });

  const entrega = Effect.fn(function* (k: string, entregaId: string) {
    const [row] = yield* sql<EntregaRow>`
      SELECT trabalho_id, tipo, envelope, plano, fase, desfecho, confirmacao FROM entregas
      WHERE vinculo = ${k} AND entrega_id = ${entregaId}`;
    return row;
  });
  /** A delivery goes in once, already in its final phase: invoked with its plan, or settled. */
  const inserirEntrega = Effect.fn(function* (
    k: string,
    e: Protocol.Entrega,
    envelope: string,
    plano: string | null,
    desfecho: DesfechoGravado | null,
  ) {
    const texto = desfecho === null ? null : yield* desfechoJson.encode(desfecho);
    yield* sql`INSERT INTO entregas (vinculo, entrega_id, trabalho_id, tipo, envelope, plano, fase, desfecho)
               VALUES (${k}, ${e.entrega_id}, ${e.trabalho_id}, ${e.tipo}, ${envelope}, ${plano},
                       ${desfecho === null ? "iniciada" : "resolvida"}, ${texto})`;
  });
  const execucaoDe = Effect.fn(function* (entregaId: string, row: EntregaRow) {
    if (row.plano === null) return yield* invalid("plan")(`delivery ${entregaId} has no plan`);
    if (row.tipo === "pedido") {
      const plano = yield* requestPlanJson.decode(row.plano);
      return { tipo: "pedido", entregaId, plano } satisfies Execucao;
    }
    const plano = yield* answerPlanJson.decode(row.plano);
    return { tipo: "resposta", entregaId, plano } satisfies Execucao;
  });
  const reciboDe = (d: DesfechoGravado): Protocol.Recibo | null => {
    if (d.tipo === "respondida") return { comando: d.comando };
    if (d.tipo !== "aceita") return null;
    const [primeiro, ...resto] = d.aceitacao.commandIds;
    if (primeiro === undefined) return null;
    return {
      thread: d.aceitacao.threadId,
      mensagem: d.aceitacao.messageId,
      run: d.aceitacao.runId,
      comandos: [primeiro, ...resto],
    };
  };
  /** A settled delivery's next step: its receipt, until the Worker gave its verdict on it. */
  const passoDe = (entregaId: string, d: DesfechoGravado, row: EntregaRow): Passo => {
    const recibo = reciboDe(d);
    return recibo === null || row.confirmacao !== null
      ? { type: "aguardar" }
      : { type: "confirmar", entregaId, recibo };
  };
  const aceitacaoDo = Effect.fn(function* (k: string, t: TrabalhoRow) {
    const row = yield* entrega(k, t.entrega_pedido);
    const d = row?.desfecho == null ? null : yield* desfechoJson.decode(row.desfecho);
    if (d?.tipo !== "aceita") return yield* conflict(`job ${t.trabalho_id} has no T3 acceptance`);
    return d.aceitacao;
  });

  const conversaDe = Effect.fn(function* (k: string, conversaId: string) {
    const [row] = yield* sql<ConversaRow>`
      SELECT geracao, thread_reservada, thread_associada, bloqueio, conferida FROM conversas
      WHERE vinculo = ${k} AND conversa_id = ${conversaId}`;
    return row;
  });
  /** The conversation's last job the T3 took that has ended here, to check the T3 still has it. */
  const ultimoEncerrado = Effect.fn(function* (k: string, conversaId: string) {
    const [ultimo] = yield* sql<{ readonly trabalho_id: string }>`
      SELECT t.trabalho_id FROM trabalhos t
      JOIN entregas e ON e.vinculo = t.vinculo AND e.entrega_id = t.entrega_pedido
      WHERE t.vinculo = ${k} AND t.conversa_id = ${conversaId}
        AND t.estado IN ('concluido', 'falhou', 'parado')
        AND json_extract(e.desfecho, '$.tipo') = 'aceita'
      ORDER BY t.rowid DESC LIMIT 1`;
    if (ultimo === undefined) return undefined;
    const t = yield* trabalho(k, ultimo.trabalho_id);
    return {
      trabalhoId: t.trabalho_id,
      aceitacao: yield* aceitacaoDo(k, t),
      cursor: t.cursor,
    } satisfies Observado;
  });

  const receberPedido = Effect.fn(function* (
    k: string,
    e: Protocol.EntregaPedido,
    envelope: string,
    configuracao: Configuracao,
  ) {
    const conversa = yield* conversaDe(k, e.conversa.id);
    if (conversa === undefined) {
      yield* sql`INSERT INTO conversas (vinculo, conversa_id, geracao, thread_reservada)
                 VALUES (${k}, ${e.conversa.id}, ${e.conversa.geracao},
                         ${threadReservada(k, e.conversa.id, e.conversa.geracao)})`;
    }
    const registrar = Effect.fn(function* (plano: string | null, desfecho: DesfechoGravado | null) {
      yield* sql`INSERT INTO trabalhos (vinculo, trabalho_id, conversa_id, entrega_pedido, estado)
                 VALUES (${k}, ${e.trabalho_id}, ${e.conversa.id}, ${e.entrega_id}, 'entregue')`;
      yield* inserirEntrega(k, e, envelope, plano, desfecho);
      return yield* trabalho(k, e.trabalho_id);
    });

    if (diverge(conversa, e.conversa)) {
      const t = yield* registrar(null, {
        versao: 1,
        tipo: "nao_executada",
        evento: "thread_perdida",
      });
      yield* perderThread(k, t);
      return { type: "aguardar" } satisfies Passo;
    }
    const associada = conversa?.thread_associada ?? null;
    if (associada !== null && conversa?.conferida === 0) {
      const ultimo = yield* ultimoEncerrado(k, e.conversa.id);
      if (ultimo !== undefined) return { type: "conferir", observado: ultimo } satisfies Passo;
      yield* conferida(k, e.conversa.id);
    }
    const id = idDaEntrega(k, e.entrega_id);
    const base = {
      version: 1,
      commandId: CommandId.make(id),
      messageId: MessageId.make(id),
      text: promptFor(e),
    } as const;
    let plano: RequestPlan;
    if (associada !== null) {
      // Later requests run with the thread's current settings, which the person may change in the T3.
      plano = { ...base, threadId: ThreadId.make(associada), newThread: null };
    } else if (configuracao.type === "pronta") {
      plano = {
        ...base,
        threadId: ThreadId.make(
          conversa?.thread_reservada ?? threadReservada(k, e.conversa.id, e.conversa.geracao),
        ),
        newThread: {
          projectId: configuracao.projectId,
          title: `Editaii: edital ${e.edital.id}`,
          modelSelection: configuracao.modelSelection,
          runtimeMode: configuracao.runtimeMode,
          interactionMode: configuracao.interactionMode,
        },
      };
    } else {
      const t = yield* registrar(null, { versao: 1, tipo: "nao_executada", evento: "falha" });
      yield* emitir(k, t.trabalho_id, { tipo: "falha", motivo: configuracao.motivo });
      yield* encerrar(k, t.trabalho_id, "falhou");
      return { type: "aguardar" } satisfies Passo;
    }
    yield* registrar(yield* requestPlanJson.encode(plano), null);
    return {
      type: "executar",
      execucao: { tipo: "pedido", entregaId: e.entrega_id, plano },
    } satisfies Passo;
  });

  const receberResposta = Effect.fn(function* (
    k: string,
    e: Protocol.EntregaResposta,
    envelope: string,
  ) {
    const t = yield* trabalho(k, e.trabalho_id);
    if (
      t.conversa_id !== e.conversa.id ||
      diverge(yield* conversaDe(k, t.conversa_id), e.conversa)
    ) {
      yield* inserirEntrega(k, e, envelope, null, {
        versao: 1,
        tipo: "nao_executada",
        evento: "thread_perdida",
      });
      if (naoTerminou(t.estado)) yield* perderThread(k, t);
      else yield* bloquear(k, t.conversa_id, "thread_perdida");
      return { type: "aguardar" } satisfies Passo;
    }
    const p = yield* selecionada(k, e.trabalho_id);
    // The run went on without this answer: the Worker hears it from the event already owed.
    if (
      t.estado !== "aguardando_pessoa" ||
      p === undefined ||
      p.request_id !== e.intervencao.referencia ||
      p.traducao === null
    ) {
      yield* inserirEntrega(k, e, envelope, null, { versao: 1, tipo: "superada" });
      return { type: "aguardar" } satisfies Passo;
    }
    const answers = answersFor(yield* traducaoJson.decode(p.traducao), e.intervencao.respostas);
    if (answers === null) {
      return yield* conflict(`answers of ${e.entrega_id} do not fit the questions`);
    }
    const plano: AnswerPlan = {
      version: 1,
      threadId: (yield* aceitacaoDo(k, t)).threadId,
      requestId: RuntimeRequestId.make(p.request_id),
      commandId: CommandId.make(idDaEntrega(k, e.entrega_id)),
      answers,
    };
    yield* inserirEntrega(k, e, envelope, yield* answerPlanJson.encode(plano), null);
    return {
      type: "executar",
      execucao: { tipo: "resposta", entregaId: e.entrega_id, plano },
    } satisfies Passo;
  });

  const receber: EditaiiJournalShape["receber"] = (v, e, configuracao) => {
    const k = chave(v);
    return transacao(
      "receive",
      Effect.gen(function* () {
        yield* garantirVinculo(v, k);
        if (yield* desligando(k)) return { type: "aguardar" } satisfies Passo;
        const envelope = yield* envelopeJson.encode(e);
        const row = yield* entrega(k, e.entrega_id);
        if (row === undefined) {
          return e.tipo === "pedido"
            ? yield* receberPedido(k, e, envelope, configuracao)
            : yield* receberResposta(k, e, envelope);
        }
        if (row.envelope !== envelope) return yield* conflict(`delivery ${e.entrega_id} changed`);
        if (row.desfecho === null) {
          const execucao = yield* execucaoDe(e.entrega_id, row);
          return { type: "inspecionar", execucao } satisfies Passo;
        }
        return passoDe(e.entrega_id, yield* desfechoJson.decode(row.desfecho), row);
      }),
    );
  };

  const ESPERADOS: Record<EntregaRow["tipo"], ReadonlyArray<Desfecho["tipo"]>> = {
    pedido: ["aceita", "recusada", "thread_ausente", "incerta"],
    resposta: ["respondida", "superada", "nao_retomavel", "incerta"],
  };

  const resolver: EditaiiJournalShape["resolver"] = (v, entregaId, desfecho) => {
    const k = chave(v);
    return transacao(
      "resolve",
      Effect.gen(function* () {
        const row = yield* entrega(k, entregaId);
        if (row === undefined) return yield* conflict(`unknown delivery ${entregaId}`);
        if (!ESPERADOS[row.tipo].includes(desfecho.tipo)) {
          return yield* conflict(`${desfecho.tipo} is not an outcome of a ${row.tipo}`);
        }
        const gravado: DesfechoGravado = { versao: 1, ...desfecho };
        const texto = yield* desfechoJson.encode(gravado);
        if (row.desfecho !== null) {
          if (row.desfecho !== texto) {
            return yield* conflict(`delivery ${entregaId} already has another outcome`);
          }
          return passoDe(entregaId, gravado, row);
        }
        yield* sql`UPDATE entregas SET fase = 'resolvida', desfecho = ${texto}
                   WHERE vinculo = ${k} AND entrega_id = ${entregaId}`;
        const t = yield* trabalho(k, row.trabalho_id);
        switch (desfecho.tipo) {
          case "recusada":
            yield* emitir(k, t.trabalho_id, { tipo: "falha", motivo: "O T3 recusou o pedido." });
            yield* encerrar(k, t.trabalho_id, "falhou");
            break;
          case "thread_ausente":
          case "incerta":
            if (naoTerminou(t.estado)) yield* perderThread(k, t);
            break;
          case "superada": {
            const execucao = yield* execucaoDe(entregaId, row);
            if (execucao.tipo === "resposta") {
              yield* fecharPendencia(k, t.trabalho_id, execucao.plano.requestId, "resolved");
            }
            break;
          }
          case "nao_retomavel":
            if (naoTerminou(t.estado)) {
              yield* emitir(k, t.trabalho_id, {
                tipo: "falha",
                motivo: "A resposta não pôde ser entregue ao T3.",
              });
              yield* encerrar(k, t.trabalho_id, "falhou");
            }
            break;
          case "aceita":
          case "respondida":
            break;
        }
        return passoDe(entregaId, gravado, row);
      }),
    );
  };

  const confirmada: EditaiiJournalShape["confirmada"] = (v, entregaId, resultado) => {
    const k = chave(v);
    return transacao(
      "confirm",
      Effect.gen(function* () {
        const row = yield* entrega(k, entregaId);
        const d = row?.desfecho == null ? null : yield* desfechoJson.decode(row.desfecho);
        if (row === undefined || d === null || reciboDe(d) === null) {
          return yield* conflict(`delivery ${entregaId} has no receipt to confirm`);
        }
        const veredito = resultado === "ok" ? "aceita" : "recusada";
        if (row.confirmacao !== null && row.confirmacao !== veredito) {
          return yield* conflict(`the receipt of ${entregaId} was already ${row.confirmacao}`);
        }
        yield* sql`UPDATE entregas SET confirmacao = ${veredito}
                   WHERE vinculo = ${k} AND entrega_id = ${entregaId}`;
        const t = yield* trabalho(k, row.trabalho_id);
        if (resultado === "conflito") {
          if (naoTerminou(t.estado)) {
            yield* encerrar(k, t.trabalho_id, "parado");
            yield* bloquear(k, t.conversa_id, "conflito");
          }
          return null;
        }
        if (d.tipo !== "aceita" || t.estado !== "entregue") return null;
        yield* sql`UPDATE conversas SET thread_associada = COALESCE(thread_associada, ${d.aceitacao.threadId})
                   WHERE vinculo = ${k} AND conversa_id = ${t.conversa_id}`;
        yield* setEstado(k, t.trabalho_id, "em_execucao");
        return { trabalhoId: t.trabalho_id, aceitacao: d.aceitacao, cursor: t.cursor };
      }),
    );
  };

  const observar: EditaiiJournalShape["observar"] = (v, trabalhoId, o) => {
    const k = chave(v);
    return transacao(
      "observe",
      Effect.gen(function* () {
        const t = yield* trabalho(k, trabalhoId);
        if (!ATIVOS.includes(t.estado)) {
          // Its result stays as it was; only whether the conversation may go on is decided here.
          // Without a T3 fact that ended it, any fact will do: the adapter shows none before it
          // finds the request in the thread.
          if (t.marco_t3 === null ? o.type !== "thread_lost" : o.key === t.marco_t3) {
            yield* conferida(k, t.conversa_id);
            return "fim" as const;
          }
          if (o.type === "answer" || o.type === "failure" || o.type === "thread_lost") {
            yield* bloquear(k, t.conversa_id, "thread_perdida");
            return "fim" as const;
          }
          return "seguir" as const;
        }
        yield* sql`UPDATE trabalhos SET cursor = MAX(COALESCE(cursor, 0), ${o.sequence})
                   WHERE vinculo = ${k} AND trabalho_id = ${trabalhoId}`;
        switch (o.type) {
          case "running":
            return "seguir" as const;
          case "question":
          case "approval":
            return yield* registrarPendencia(k, t, o);
          case "resolved":
            yield* fecharPendencia(k, trabalhoId, o.requestId, o.status);
            return "seguir" as const;
          case "answer":
            yield* emitir(k, trabalhoId, { tipo: "resposta", texto: o.text });
            yield* encerradoPeloT3(k, t, "concluido", o.key);
            return "fim" as const;
          case "failure":
            yield* emitir(k, trabalhoId, { tipo: "falha", motivo: o.message });
            yield* encerradoPeloT3(k, t, "falhou", o.key);
            return "fim" as const;
          case "thread_lost":
            yield* perderThread(k, t);
            return "fim" as const;
        }
      }),
    );
  };

  const proximoEvento: EditaiiJournalShape["proximoEvento"] = (v) => {
    const k = chave(v);
    return transacao(
      "next event",
      Effect.gen(function* () {
        if (yield* desligando(k)) return null;
        // Each job's oldest unsent event; the job that sent least recently goes first.
        const [row] = yield* sql<{ readonly corpo: string }>`
          SELECT e.corpo FROM eventos e
          JOIN trabalhos t ON t.vinculo = e.vinculo AND t.trabalho_id = e.trabalho_id
          WHERE e.vinculo = ${k} AND e.enviado_em IS NULL AND t.retido_em IS NULL
            AND e.sequencia = (SELECT MIN(x.sequencia) FROM eventos x
                               WHERE x.vinculo = e.vinculo AND x.trabalho_id = e.trabalho_id
                                 AND x.enviado_em IS NULL)
          ORDER BY (SELECT MAX(y.enviado_em) FROM eventos y
                    WHERE y.vinculo = e.vinculo AND y.trabalho_id = e.trabalho_id) IS NOT NULL,
                   (SELECT MAX(y.enviado_em) FROM eventos y
                    WHERE y.vinculo = e.vinculo AND y.trabalho_id = e.trabalho_id),
                   e.rowid
          LIMIT 1`;
        return row === undefined ? null : yield* eventoJson.decode(row.corpo);
      }),
    );
  };

  const eventoEnviado: EditaiiJournalShape["eventoEnviado"] = (v, evento, resultado) => {
    const k = chave(v);
    return transacao(
      "event sent",
      Effect.gen(function* () {
        const t = yield* trabalho(k, evento.trabalho_id);
        if (resultado === "ok") {
          yield* sql`UPDATE eventos SET enviado_em = COALESCE(enviado_em, ${yield* agora})
                     WHERE vinculo = ${k} AND trabalho_id = ${evento.trabalho_id}
                       AND sequencia = ${evento.sequencia}`;
          return;
        }
        // The Worker refused it: this job holds, and its conversation runs nothing more here.
        yield* sql`UPDATE trabalhos SET retido_em = COALESCE(retido_em, ${yield* agora})
                   WHERE vinculo = ${k} AND trabalho_id = ${evento.trabalho_id}`;
        yield* bloquear(k, t.conversa_id, "conflito");
      }),
    );
  };

  const desligar: EditaiiJournalShape["desligar"] = (v) => {
    const k = chave(v);
    return transacao(
      "disconnect",
      Effect.gen(function* () {
        yield* garantirVinculo(v, k);
        yield* sql`INSERT INTO desligamentos (vinculo, pedido_em) VALUES (${k}, ${yield* agora})
                   ON CONFLICT DO NOTHING`;
      }),
    );
  };

  const partida: EditaiiJournalShape["partida"] = (v) => {
    const k = chave(v);
    return transacao(
      "start",
      Effect.gen(function* () {
        yield* garantirVinculo(v, k);
        if (yield* desligando(k)) return { type: "desligar" } satisfies Partida;
        yield* sql`UPDATE conversas SET conferida = 0 WHERE vinculo = ${k}`;
        const resolvidas = yield* sql<{ readonly entrega_id: string; readonly desfecho: string }>`
          SELECT entrega_id, desfecho FROM entregas
          WHERE vinculo = ${k} AND fase = 'resolvida' AND confirmacao IS NULL ORDER BY rowid`;
        const confirmar: Array<{ entregaId: string; recibo: Protocol.Recibo }> = [];
        for (const r of resolvidas) {
          const recibo = reciboDe(yield* desfechoJson.decode(r.desfecho));
          if (recibo !== null) confirmar.push({ entregaId: r.entrega_id, recibo });
        }
        const ativos = yield* sql<TrabalhoRow>`
          SELECT trabalho_id, conversa_id, entrega_pedido, estado, cursor, marco_t3 FROM trabalhos
          WHERE vinculo = ${k} AND estado IN ${sql.in(ATIVOS)} ORDER BY rowid`;
        const observar: Array<Observado> = [];
        for (const t of ativos) {
          const aceitacao = yield* aceitacaoDo(k, t);
          observar.push({ trabalhoId: t.trabalho_id, aceitacao, cursor: t.cursor });
        }
        return { type: "retomar", confirmar, observar } satisfies Partida;
      }),
    );
  };

  return EditaiiJournal.of({
    partida,
    receber,
    resolver,
    confirmada,
    observar,
    proximoEvento,
    eventoEnviado,
    desligar,
  });
});

export const layer = Layer.effect(EditaiiJournal, make);
