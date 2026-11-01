import * as Schema from "effect/Schema";

export const EditaiiMachine = Schema.Struct({
  id: Schema.String,
  nome: Schema.String,
  dono: Schema.String,
  ambiente_t3: Schema.String,
  emitida_em: Schema.String,
  ativada_em: Schema.NullOr(Schema.String),
  revogada_em: Schema.NullOr(Schema.String),
});

export const EditaiiProblem = Schema.Literals([
  "configuration",
  "storage",
  "listener",
  "browser",
  "network",
  "authentication",
  "conflict",
  "expired",
  "interrupted",
  "protocol",
]);

export const EditaiiConnectionState = Schema.Struct({
  status: Schema.Literals(["disconnected", "pairing", "redeeming", "connected", "error"]),
  origin: Schema.NullOr(Schema.String),
  machine: Schema.NullOr(EditaiiMachine),
  problem: Schema.NullOr(EditaiiProblem),
  canReopen: Schema.Boolean,
});
export type EditaiiConnectionState = typeof EditaiiConnectionState.Type;
