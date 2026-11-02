import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

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
  /** The T3 project new Editaii conversations go to; chosen at any time, kept when disconnecting. */
  projectId: Schema.NullOr(ProjectId),
});
export type EditaiiConnectionState = typeof EditaiiConnectionState.Type;

export function editaiiProblemMessage(reason: typeof EditaiiProblem.Type): string {
  switch (reason) {
    case "configuration":
      return "Configure an HTTPS Editaii origin while disconnected.";
    case "storage":
      return "Could not read or save the Editaii connection. Its credentials have not been discarded.";
    case "listener":
      return "Could not start the Editaii callback on this computer.";
    case "browser":
      return "Could not open a browser on the computer running T3. Open its graphical session and try again.";
    case "network":
      return "Could not reach Editaii. The connection will retry without discarding its credentials.";
    case "authentication":
      return "Editaii or Cloudflare Access refused the connection.";
    case "conflict":
      return "Editaii refused this pairing because it conflicts with an existing connection.";
    case "expired":
      return "This pairing expired. Disconnect this attempt and start again.";
    case "interrupted":
      return "Pairing was interrupted. Disconnect this attempt and start again.";
    case "protocol":
      return "Editaii returned an unexpected response.";
  }
}

/** Only the category crosses RPC: an internal cause can contain HTTP credentials. */
export class EditaiiRequestError extends Schema.TaggedError<EditaiiRequestError>()(
  "EditaiiRequestError",
  { reason: EditaiiProblem },
) {
  override get message(): string {
    return editaiiProblemMessage(this.reason);
  }
}

export const EditaiiConfigureInput = Schema.Struct({ origin: Schema.String });
export const EditaiiStartPairingInput = Schema.Struct({ machineName: Schema.String });
