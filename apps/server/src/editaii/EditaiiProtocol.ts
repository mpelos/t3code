/**
 * The machine protocol's data, as the Editaii Worker serves and accepts it. The contract is
 * docs/protocolo-maquinas.md in the editaii repository; a change here needs the Worker's too.
 */
import * as Schema from "effect/Schema";

export const PROTOCOL_VERSION = 1;

const Id = Schema.NonEmptyString;

export const Conversa = Schema.Struct({
  id: Id,
  geracao: Schema.Number,
  /** Null until the conversation's first request is confirmed. */
  thread_t3: Schema.NullOr(Id),
});
export type Conversa = typeof Conversa.Type;

export const Respostas = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);
export type Respostas = typeof Respostas.Type;

export const EntregaPedido = Schema.Struct({
  versao: Schema.Literal(PROTOCOL_VERSION),
  entrega_id: Id,
  tipo: Schema.Literal("pedido"),
  trabalho_id: Id,
  conversa: Conversa,
  edital: Schema.Struct({ id: Id, revisao: Schema.Number, ficha: Schema.Unknown }),
  /** Attributed context; never executed. */
  contexto: Schema.Array(
    Schema.Struct({
      seq: Schema.Number,
      autor_tipo: Schema.Literals(["humano", "maquina"]),
      autor_nome: Schema.String,
      texto: Schema.String,
    }),
  ),
  /** The one executable request of the delivery. */
  pedido: Schema.Struct({
    mensagem_id: Id,
    seq: Schema.Number,
    autor_nome: Schema.String,
    texto: Schema.String,
  }),
});
export type EntregaPedido = typeof EntregaPedido.Type;

export const EntregaResposta = Schema.Struct({
  versao: Schema.Literal(PROTOCOL_VERSION),
  entrega_id: Id,
  tipo: Schema.Literal("resposta"),
  trabalho_id: Id,
  conversa: Conversa,
  /** `referencia` is the one the connector sent when it opened the intervention. */
  intervencao: Schema.Struct({ id: Id, referencia: Id, respostas: Respostas }),
});
export type EntregaResposta = typeof EntregaResposta.Type;

export const Entrega = Schema.Union([EntregaPedido, EntregaResposta]);
export type Entrega = typeof Entrega.Type;

export const ReciboPedido = Schema.Struct({
  thread: Id,
  mensagem: Id,
  run: Id,
  comandos: Schema.NonEmptyArray(Id),
});
export const ReciboResposta = Schema.Struct({ comando: Id });
export type Recibo = typeof ReciboPedido.Type | typeof ReciboResposta.Type;

export const Pergunta = Schema.Struct({
  id: Id,
  titulo: Schema.String,
  pergunta: Id,
  opcoes: Schema.Array(Schema.Struct({ rotulo: Id, descricao: Schema.String })),
  multipla: Schema.Boolean,
  livre: Schema.Boolean,
});
export type Pergunta = typeof Pergunta.Type;

const base = { id: Id, trabalho_id: Id, sequencia: Schema.Number };
export const Evento = Schema.Union([
  Schema.Struct({ ...base, tipo: Schema.Literal("resposta"), texto: Id }),
  Schema.Struct({
    ...base,
    tipo: Schema.Literal("intervencao"),
    referencia: Id,
    perguntas: Schema.NonEmptyArray(Pergunta),
  }),
  Schema.Struct({ ...base, tipo: Schema.Literal("acao_necessaria"), descricao: Id }),
  Schema.Struct({ ...base, tipo: Schema.Literal("retomado") }),
  Schema.Struct({ ...base, tipo: Schema.Literal("falha"), motivo: Id }),
  Schema.Struct({ ...base, tipo: Schema.Literal("thread_perdida") }),
]);
export type Evento = typeof Evento.Type;
