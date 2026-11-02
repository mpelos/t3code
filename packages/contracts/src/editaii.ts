import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";

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
  /** The pairing attempt under way, also once interrupted or expired: what cancelling targets. */
  attempt: Schema.NullOr(Schema.String),
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

export const EditaiiChooseProjectInput = Schema.Struct({ projectId: Schema.NullOr(ProjectId) });

/** A connected machine's link, exactly as the panel showed it. */
export const EditaiiLink = Schema.Struct({
  origin: Schema.String,
  machineId: Schema.String,
  environmentId: Schema.String,
});
export type EditaiiLink = typeof EditaiiLink.Type;

/**
 * What the person chose to end: the connected link, or the pairing attempt, as shown. Anything
 * else by now is `not_current` and left as it is.
 */
export const EditaiiDisconnectInput = Schema.Struct({
  target: Schema.Union([
    Schema.Struct({ type: Schema.Literal("link"), ...EditaiiLink.fields }),
    Schema.Struct({ type: Schema.Literal("attempt"), attempt: Schema.String }),
  ]),
});
export const EditaiiDisconnectResult = Schema.Literals(["disconnected", "not_current"]);

/**
 * Why the Editaii journal on that computer cannot be used. future_version: written by a newer T3.
 * invalid_data: a stored value no longer decodes. conflict: the Editaii contradicts what it
 * recorded. storage: the file cannot be opened, read or written.
 */
export const EditaiiJournalProblem = Schema.Literals([
  "future_version",
  "invalid_data",
  "conflict",
  "storage",
]);
export type EditaiiJournalProblem = typeof EditaiiJournalProblem.Type;

export function editaiiJournalProblemMessage(reason: EditaiiJournalProblem): string {
  switch (reason) {
    case "future_version":
      return "The Editaii journal on this computer was written by a newer T3. Update T3.";
    case "invalid_data":
      return "The Editaii journal on this computer holds data this T3 cannot read.";
    case "conflict":
      return "Editaii contradicts what the journal on this computer recorded.";
    case "storage":
      return "Could not open, read or write the Editaii journal on this computer.";
  }
}

/** Disconnecting needs the journal first, to record that the link is abandoned. */
export class EditaiiJournalUnavailableError extends Schema.TaggedError<EditaiiJournalUnavailableError>()(
  "EditaiiJournalUnavailableError",
  { reason: EditaiiJournalProblem },
) {
  override get message(): string {
    return `${editaiiJournalProblemMessage(this.reason)} Nothing was disconnected.`;
  }
}

/**
 * How a new Editaii conversation's thread runs on that computer: in the chosen project, with the
 * model and runtime the T3 resolves for a new thread there. `unavailable`: the settings or
 * projects could not be read, which says nothing about what they are.
 */
export const EditaiiConfiguration = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("ready"),
    projectId: ProjectId,
    projectTitle: Schema.String,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
  }),
  Schema.Struct({
    type: Schema.Literal("incomplete"),
    reason: Schema.Literals(["no_project", "project_missing", "no_model", "provider_disabled"]),
    projectTitle: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("unavailable"), reason: Schema.Literal("read_error") }),
]);
export type EditaiiConfiguration = typeof EditaiiConfiguration.Type;

export const EditaiiJobState = Schema.Literals([
  "delivered",
  "running",
  "waiting_for_person",
  "action_in_t3",
  "completed",
  "failed",
  "stopped",
]);

/**
 * What the link has under way on that computer, read for `link`. A job is listed while it has
 * activity in the T3 or something not yet returned to the Editaii; `held` returns wait on an
 * event the Editaii refused. Once the link is being abandoned (`abandoning`), nothing more returns.
 */
export const EditaiiActivity = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("available"),
    link: EditaiiLink,
    abandoning: Schema.Boolean,
    jobs: Schema.Array(
      Schema.Struct({
        jobId: Schema.String,
        conversationId: Schema.String,
        threadId: Schema.NullOr(Schema.String),
        state: EditaiiJobState,
        pendingEvents: Schema.Number,
        held: Schema.Boolean,
        receiptPending: Schema.Boolean,
      }),
    ),
    blockedConversations: Schema.Array(
      Schema.Struct({
        conversationId: Schema.String,
        threadId: Schema.NullOr(Schema.String),
        reason: Schema.Literals(["conflict", "thread_lost"]),
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("unavailable"),
    link: EditaiiLink,
    reason: EditaiiJournalProblem,
  }),
]);
export type EditaiiActivity = typeof EditaiiActivity.Type;

/** Everything the Editaii panel shows for one computer, read together. */
export const EditaiiPanel = Schema.Struct({
  connection: EditaiiConnectionState,
  configuration: EditaiiConfiguration,
  /** The journal problem that stops the connector, until it runs again. */
  connector: Schema.Struct({ journal: Schema.NullOr(EditaiiJournalProblem) }),
  /** Null while no machine is connected. */
  activity: Schema.NullOr(EditaiiActivity),
});
export type EditaiiPanel = typeof EditaiiPanel.Type;
