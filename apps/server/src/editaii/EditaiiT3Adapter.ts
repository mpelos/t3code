import {
  CommandId,
  MessageId,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ProviderInteractionMode,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2UserInputQuestion,
} from "@t3tools/contracts";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { LiveStreamBufferError } from "../orchestration-v2/LiveStreamBudget.ts";
import { EventSinkStreamError } from "../orchestration-v2/EventSink.ts";

export class AcceptRefused extends Schema.TaggedError<AcceptRefused>()("EditaiiT3AcceptRefused", {
  commandId: CommandId,
}) {
  override get message(): string {
    return "T3 permanently rejected the request command.";
  }
}
export class AcceptUnknown extends Schema.TaggedError<AcceptUnknown>()("EditaiiT3AcceptUnknown", {
  commandId: CommandId,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "The T3 request outcome could not be established.";
  }
}
// The conversation's T3 thread no longer exists; nothing was dispatched. The connector reports the thread lost.
export class ThreadMissing extends Schema.TaggedError<ThreadMissing>()("EditaiiT3ThreadMissing", {
  threadId: ThreadId,
}) {
  override get message(): string {
    return "The conversation's T3 thread no longer exists.";
  }
}
export class T3ReadError extends Schema.TaggedError<T3ReadError>()("EditaiiT3ReadError", {
  threadId: ThreadId,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Could not read the T3 execution evidence.";
  }
}
export class RespondUnknown extends Schema.TaggedError<RespondUnknown>()(
  "EditaiiT3RespondUnknown",
  {
    commandId: CommandId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "The T3 answer outcome could not be established.";
  }
}

// The journal binds commandId to one immutable plan; T3 receipts do not compare command payloads.
export const RequestPlan = Schema.Struct({
  version: Schema.Literal(1),
  threadId: ThreadId,
  commandId: CommandId,
  messageId: MessageId,
  text: Schema.String,
  newThread: Schema.NullOr(
    Schema.Struct({
      projectId: ProjectId,
      title: Schema.String,
      modelSelection: ModelSelection,
      runtimeMode: RuntimeMode,
      interactionMode: ProviderInteractionMode,
    }),
  ),
});
export type RequestPlan = typeof RequestPlan.Type;
export const Acceptance = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  runId: RunId,
  commandIds: Schema.Array(CommandId),
});
export type Acceptance = typeof Acceptance.Type;
export const AnswerPlan = Schema.Struct({
  version: Schema.Literal(1),
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  commandId: CommandId,
  answers: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])),
});
export type AnswerPlan = typeof AnswerPlan.Type;
type MismatchReason = "identity" | "receipt" | "message" | "run" | "thread";
export type Inspection =
  | { readonly type: "found"; readonly acceptance: Acceptance }
  | { readonly type: "absent" }
  | { readonly type: "mismatch"; readonly reason: MismatchReason };
// A snapshot watermark can cover several observations; key identifies the durable semantic fact.
type Origin = { readonly sequence: number; readonly key: string };
export type Observation = Origin &
  (
    | {
        readonly type: "running";
        readonly runId: RunId;
        readonly status: OrchestrationV2Run["status"];
      }
    | {
        readonly type: "question";
        readonly runId: RunId;
        readonly requestId: RuntimeRequestId;
        readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
        readonly capability: "live" | "message" | "not_resumable";
      }
    | {
        readonly type: "approval";
        readonly runId: RunId;
        readonly requestId: RuntimeRequestId;
        readonly description: string;
      }
    | {
        readonly type: "resolved";
        readonly requestId: RuntimeRequestId;
        readonly status: "resolved" | "expired" | "cancelled";
      }
    | {
        readonly type: "answer";
        readonly runId: RunId;
        readonly text: string;
        readonly messageId: MessageId;
      }
    | {
        readonly type: "failure";
        readonly runId: RunId;
        readonly reason: "no-result" | "run-ended";
        readonly message: string;
      }
    | { readonly type: "thread_lost"; readonly reason: MismatchReason | "cursor" }
  );
export type AnswerResult =
  | { readonly type: "accepted"; readonly commandId: CommandId }
  | { readonly type: "superseded" }
  | { readonly type: "not_resumable" }
  | { readonly type: "unknown"; readonly error: RespondUnknown };

export class EditaiiT3Adapter extends Context.Service<
  EditaiiT3Adapter,
  {
    /**
     * Executes the plan. Call it only while the journal says the invocation has not started; after
     * that, only `inspect` may decide: an absent acceptance then means uncertainty, never a retry.
     */
    readonly accept: (
      plan: RequestPlan,
    ) => Effect.Effect<Acceptance, AcceptRefused | AcceptUnknown | ThreadMissing>;
    readonly inspect: (
      plan: RequestPlan,
      known: Acceptance | null,
    ) => Effect.Effect<Inspection, T3ReadError>;
    /**
     * Follows the work the acceptance started, across the runs that carry it (see `runLineage`).
     * A question still pending is reported even when its run has ended: a T3 restart ends the run
     * but keeps the question answerable by message. Only when nothing waits for a person does the
     * latest run's end become the answer or the failure.
     */
    readonly observe: (
      acceptance: Acceptance,
      afterSequence?: number,
    ) => Stream.Stream<Observation, T3ReadError>;
    /**
     * Answers a request. `superseded`: someone answered it in T3. `not_resumable`: T3 cancelled or
     * expired it, or can no longer deliver an answer. The answers must cover every required question
     * by id; the connector builds them from the Editaii form, which enforces that. T3 may reject an
     * incomplete answer permanently, and that comes back as `unknown`.
     */
    readonly respond: (plan: AnswerPlan) => Effect.Effect<AnswerResult>;
  }
>()("t3/editaii/EditaiiT3Adapter") {}

const encodeObservationIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const sameCommands = (a: ReadonlyArray<CommandId>, b: ReadonlyArray<CommandId>) =>
  a.length === b.length && a.every((id, i) => id === b[i]);
const commandsFor = (plan: RequestPlan) =>
  plan.newThread === null
    ? [plan.commandId]
    : [plan.commandId, CommandId.make(`${plan.commandId}:initial-message`)];

const isReadError = Schema.is(T3ReadError);
const isRefused = Schema.is(AcceptRefused);
const isThreadMissing = Schema.is(ThreadMissing);
const isLiveBufferError = Schema.is(LiveStreamBufferError);
const isDomainStreamError = Schema.is(Orchestrator.OrchestratorDomainEventStreamError);
const isSinkStreamError = Schema.is(EventSinkStreamError);

const isBufferOverflow = (error: unknown): boolean => {
  if (isLiveBufferError(error)) return true;
  if (isReadError(error) || isDomainStreamError(error) || isSinkStreamError(error))
    return isBufferOverflow(error.cause);
  return false;
};

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const receipts = yield* Receipts.CommandReceiptStoreV2;
  const launch = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* Threads.ThreadManagementService;
  const receipt = Effect.fn("EditaiiT3Adapter.receipt")(function* (
    threadId: ThreadId,
    commandId: CommandId,
  ) {
    return yield* receipts
      .getByCommandId(commandId)
      .pipe(Effect.mapError((cause) => new T3ReadError({ threadId, cause })));
  });
  const snapshot = Effect.fn("EditaiiT3Adapter.snapshot")(function* (threadId: ThreadId) {
    return yield* Effect.gen(function* () {
      // The shell only says whether the thread exists. Deletion is read from the snapshot itself, so
      // a thread deleted between the two reads is never taken for a live one.
      if ((yield* engine.getThreadShell(threadId)) === null) return null;
      const state = yield* engine.getThreadSnapshot(threadId);
      return state.projection.thread.deletedAt === null ? state : null;
    }).pipe(Effect.mapError((cause) => new T3ReadError({ threadId, cause })));
  });
  const evidence = Effect.fn("EditaiiT3Adapter.evidence")(function* (
    threadId: ThreadId,
    messageId: MessageId,
    commandIds: ReadonlyArray<CommandId>,
    projection: OrchestrationV2ThreadProjection,
  ) {
    for (const [index, commandId] of commandIds.entries()) {
      const r = yield* receipt(threadId, commandId);
      const expectedType =
        commandIds.length === 2 && index === 0 ? "thread.create" : "message.dispatch";
      if (
        Option.isNone(r) ||
        r.value.status !== "accepted" ||
        r.value.threadId !== threadId ||
        r.value.commandType !== expectedType
      )
        return null;
    }
    const message = projection.messages.find((m) => m.id === messageId && m.role === "user");
    const run = projection.runs.find(
      (r) => r.id === message?.runId && r.userMessageId === messageId,
    );
    if (message === undefined || run === undefined) return null;
    // Release starts execution, not acceptance. Its receipt is never added later to the immutable acceptance.
    if (commandIds.length === 2) {
      const release = yield* receipt(threadId, CommandId.make(`${commandIds[0]}:release`));
      if (
        Option.isSome(release) &&
        (release.value.threadId !== threadId ||
          release.value.commandType !== "prepared-run.release")
      )
        return null;
      if (
        ["starting", "running", "completed", "waiting"].includes(run.status) &&
        (Option.isNone(release) || release.value.status !== "accepted")
      )
        return null;
    }
    return { threadId, messageId, runId: run.id, commandIds: [...commandIds] } satisfies Acceptance;
  });
  const inspect = Effect.fn("EditaiiT3Adapter.inspect")(function* (
    plan: RequestPlan,
    known: Acceptance | null,
  ): Effect.fn.Return<Inspection, T3ReadError> {
    const ids = commandsFor(plan);
    if (
      known &&
      (known.threadId !== plan.threadId ||
        known.messageId !== plan.messageId ||
        !sameCommands(known.commandIds, ids))
    )
      return { type: "mismatch", reason: "identity" };
    const state = yield* snapshot(plan.threadId);
    if (state === null) {
      const written = yield* Effect.forEach(ids, (id) => receipt(plan.threadId, id));
      return written.some(Option.isSome)
        ? { type: "mismatch", reason: "thread" }
        : { type: "absent" };
    }
    const found = yield* evidence(plan.threadId, plan.messageId, ids, state.projection);
    if (found === null) {
      const message = state.projection.messages.find((m) => m.id === plan.messageId);
      const written = yield* Effect.forEach(ids, (id) => receipt(plan.threadId, id));
      return written.some(Option.isSome) || message !== undefined
        ? { type: "mismatch", reason: "receipt" }
        : { type: "absent" };
    }
    if (state.projection.messages.find((m) => m.id === plan.messageId)?.text !== plan.text)
      return { type: "mismatch", reason: "message" };
    if (plan.newThread && state.projection.thread.projectId !== plan.newThread.projectId)
      return { type: "mismatch", reason: "thread" };
    if (known && known.runId !== found.runId) return { type: "mismatch", reason: "run" };
    return { type: "found", acceptance: found };
  });
  const refused = Effect.fn("EditaiiT3Adapter.refused")(function* (plan: RequestPlan) {
    const rows = yield* Effect.forEach(commandsFor(plan), (id) => receipt(plan.threadId, id));
    const message = rows.at(-1);
    if (message && Option.isSome(message) && message.value.status === "accepted") return false;
    return rows.some((r) => Option.isSome(r) && r.value.status === "rejected");
  });
  const accept = Effect.fn("EditaiiT3Adapter.accept")(function* (plan: RequestPlan) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const result = yield* restore(
          Effect.gen(function* () {
            if (yield* refused(plan))
              return yield* new AcceptRefused({ commandId: plan.commandId });
            const existing = yield* inspect(plan, null);
            if (existing.type === "found") return existing.acceptance;
            if (existing.type === "mismatch")
              return yield* new AcceptUnknown({ commandId: plan.commandId, cause: existing });
            if (plan.newThread) {
              yield* launch.launch({
                ...plan.newThread,
                commandId: plan.commandId,
                threadId: plan.threadId,
                workspaceStrategy: { type: "root" },
                initialMessage: { messageId: plan.messageId, text: plan.text, attachments: [] },
                createdBy: "agent",
                creationSource: "server",
              });
            } else {
              const shell = yield* engine.getThreadShell(plan.threadId);
              if (shell === null || shell.deletedAt !== null)
                return yield* new ThreadMissing({ threadId: plan.threadId });
              yield* threads.sendToThread({
                projectId: shell.projectId,
                threadId: plan.threadId,
                commandId: plan.commandId,
                messageId: plan.messageId,
                text: plan.text,
                attachments: [],
                mode: "queue",
                createdBy: "agent",
                creationSource: "server",
              });
            }
            const written = yield* inspect(plan, null);
            if (written.type !== "found")
              return yield* new AcceptUnknown({ commandId: plan.commandId, cause: written });
            return written.acceptance;
          }),
        ).pipe(Effect.exit);
        if (result._tag === "Success") return result.value;
        const reason = Cause.findErrorOption(result.cause);
        if (Option.isSome(reason) && (isRefused(reason.value) || isThreadMissing(reason.value)))
          return yield* reason.value;
        const rejected = yield* refused(plan).pipe(Effect.orElseSucceed(() => false));
        if (rejected && !Cause.hasInterrupts(result.cause))
          return yield* new AcceptRefused({ commandId: plan.commandId });
        return yield* new AcceptUnknown({ commandId: plan.commandId, cause: result.cause });
      }),
    );
  });

  const observe = (
    acceptance: Acceptance,
    afterSequence = 0,
  ): Stream.Stream<Observation, T3ReadError> =>
    Stream.unwrap(
      Effect.sync(() => {
        let previous = new Map<string, string>();
        let lastSequence = afterSequence;
        const read = Effect.fn("EditaiiT3Adapter.observeSnapshot")(function* () {
          let state = yield* snapshot(acceptance.threadId);
          while (state !== null) {
            const current = runLineage(state.projection, acceptance.runId)?.run;
            if (!current || !(yield* engine.restartContinuationPending(current))) break;
            yield* engine.awaitRestartContinuation(current);
            state = yield* snapshot(acceptance.threadId);
          }
          const lost = (reason: MismatchReason | "cursor"): Observation[] => [
            { type: "thread_lost", reason, sequence: lastSequence, key: `lost:${reason}` },
          ];
          if (state === null) return { observations: lost("thread"), done: true };
          if (state.snapshotSequence < lastSequence)
            return { observations: lost("cursor"), done: true };
          lastSequence = state.snapshotSequence;
          const found = yield* evidence(
            acceptance.threadId,
            acceptance.messageId,
            acceptance.commandIds,
            state.projection,
          );
          if (found === null || found.runId !== acceptance.runId)
            return { observations: lost("receipt"), done: true };
          const all = observationsFor(state.projection, acceptance, state.snapshotSequence);
          const next = new Map<string, string>();
          const observations = all.filter((o) => {
            const { sequence: _sequence, ...value } = o;
            const identity = encodeObservationIdentity(value);
            next.set(o.key, identity);
            return previous.get(o.key) !== identity;
          });
          previous = next;
          return {
            observations,
            done: all.some(
              (o) => o.type === "answer" || o.type === "failure" || o.type === "thread_lost",
            ),
          };
        });
        const follow = (): Stream.Stream<Observation, T3ReadError> =>
          Stream.unwrap(
            Effect.gen(function* () {
              const initial = yield* read();
              const head = Stream.fromIterable(initial.observations);
              if (initial.done) return head;
              const tail = engine
                .streamStoredEventsFrom({
                  threadId: acceptance.threadId,
                  afterSequence: lastSequence,
                })
                .pipe(
                  Stream.filter((stored) => stored.sequence > lastSequence),
                  Stream.mapEffect(() => read()),
                  Stream.takeUntil((value) => value.done),
                  Stream.flatMap((value) => Stream.fromIterable(value.observations)),
                  Stream.mapError((cause) =>
                    isReadError(cause)
                      ? cause
                      : new T3ReadError({ threadId: acceptance.threadId, cause }),
                  ),
                );
              return Stream.concat(head, tail);
            }),
          ).pipe(
            Stream.catchTags({
              EditaiiT3ReadError: (error) =>
                isBufferOverflow(error) ? follow() : Stream.fail(error),
            }),
          );
        return follow();
      }),
    );

  const respond = Effect.fn("EditaiiT3Adapter.respond")(function* (plan: AnswerPlan) {
    return yield* Effect.uninterruptibleMask((restore) =>
      restore(
        Effect.gen(function* (): Effect.fn.Return<
          AnswerResult,
          T3ReadError | Orchestrator.OrchestratorV2Error
        > {
          const prior = yield* receipt(plan.threadId, plan.commandId);
          if (Option.isSome(prior)) {
            if (
              prior.value.status === "accepted" &&
              prior.value.threadId === plan.threadId &&
              prior.value.commandType === "runtime-request.respond"
            )
              return { type: "accepted", commandId: plan.commandId };
            return {
              type: "unknown",
              error: new RespondUnknown({ commandId: plan.commandId, cause: prior.value }),
            };
          }
          const state = yield* snapshot(plan.threadId);
          const request = state?.projection.runtimeRequests.find((r) => r.id === plan.requestId);
          if (!request)
            return {
              type: "unknown",
              error: new RespondUnknown({
                commandId: plan.commandId,
                cause: { reason: "request-missing" },
              }),
            };
          if (request.status === "resolved") return { type: "superseded" };
          if (request.status !== "pending" || request.responseCapability.type === "not_resumable")
            return { type: "not_resumable" };
          yield* engine.dispatch({
            type: "runtime-request.respond",
            commandId: plan.commandId,
            threadId: plan.threadId,
            requestId: plan.requestId,
            answers: Object.fromEntries(Object.entries(plan.answers)),
          });
          return { type: "accepted", commandId: plan.commandId };
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed({
            type: "unknown" as const,
            error: new RespondUnknown({ commandId: plan.commandId, cause }),
          }),
        ),
      ),
    );
  });
  return EditaiiT3Adapter.of({ accept, inspect, observe, respond });
});

const ENDED: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

function observationsFor(
  projection: OrchestrationV2ThreadProjection,
  acceptance: Acceptance,
  sequence: number,
): Observation[] {
  const lineage = runLineage(projection, acceptance.runId);
  if (!lineage) return [{ type: "thread_lost", sequence, key: "lost:run", reason: "run" }];
  const { run, related } = lineage;
  const base = { sequence, runId: run.id };
  const requests = requestObservations(projection, related, base);
  if (!ENDED.has(run.status))
    return [
      ...requests,
      { ...base, type: "running", key: `run:${run.id}:${run.status}`, status: run.status },
    ];
  if (requests.some((o) => o.type === "question" || o.type === "approval")) return requests;
  return [...requests, outcome(projection, run, base)];
}

function requestObservations(
  projection: OrchestrationV2ThreadProjection,
  related: ReadonlySet<RunId>,
  base: { readonly sequence: number; readonly runId: RunId },
): Observation[] {
  const nodes = new Set(
    projection.nodes.filter((n) => n.runId !== null && related.has(n.runId)).map((n) => n.id),
  );
  const observations: Observation[] = [];
  for (const request of projection.runtimeRequests) {
    if (!nodes.has(request.nodeId)) continue;
    if (request.status !== "pending") {
      observations.push({
        type: "resolved",
        sequence: base.sequence,
        key: `request:${request.id}:${request.status}`,
        requestId: request.id,
        status: request.status,
      });
      continue;
    }
    const item = projection.turnItems.find(
      (i) =>
        (i.type === "user_input_request" || i.type === "approval_request") &&
        i.requestId === request.id,
    );
    if (item?.type === "user_input_request")
      observations.push({
        ...base,
        type: "question",
        key: `request:${request.id}:pending:${request.responseCapability.type}`,
        requestId: request.id,
        questions: item.questions,
        capability: request.responseCapability.type,
      });
    else if (item?.type === "approval_request")
      observations.push({
        ...base,
        type: "approval",
        key: `request:${request.id}:pending`,
        requestId: request.id,
        description: item.prompt ?? item.reason ?? "An approval is required in T3.",
      });
  }
  return observations;
}

function outcome(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2Run,
  base: { readonly sequence: number; readonly runId: RunId },
): Observation {
  if (run.status !== "completed")
    return {
      ...base,
      type: "failure",
      key: `ended:${run.id}:${run.status}`,
      reason: "run-ended",
      message: `The T3 run ended with status ${run.status}.`,
    };
  const result = subagentResultForRun(projection, run);
  const message = projection.messages.find(
    (m) =>
      m.id === result.messageId && m.runId === run.id && m.role === "assistant" && !m.streaming,
  );
  const item = projection.turnItems.find(
    (i) =>
      i.id === result.turnItemId &&
      i.type === "assistant_message" &&
      i.runId === run.id &&
      !i.streaming &&
      i.messageId === result.messageId,
  );
  if (
    result.messageId === null ||
    message === undefined ||
    item === undefined ||
    !result.text.trim()
  )
    return {
      ...base,
      type: "failure",
      key: `no-result:${run.id}`,
      reason: "no-result",
      message: "T3 completed without a final assistant result.",
    };
  return {
    ...base,
    type: "answer",
    key: `answer:${run.id}:${result.messageId}`,
    messageId: result.messageId,
    text: result.text,
  };
}

// T3 sends an answer given by message as this user message (Orchestrator's
// dispatchRuntimeRequestRespond); it starts a run or steers the active one.
const answerMessageId = (requestId: RuntimeRequestId) =>
  MessageId.make(`async-answer:${requestId}`);

/**
 * The runs that carry the accepted work: the accepted run, the run T3 restarted it as, and the run
 * that received an answer given by message to one of their questions. The latest of them is the
 * current run, whose status decides the outcome.
 */
function runLineage(projection: OrchestrationV2ThreadProjection, rootId: RunId) {
  const root = projection.runs.find((r) => r.id === rootId);
  if (!root) return null;
  const lineage = [root];
  const related = new Set<RunId>([root.id]);
  // Iterating while appending also visits the runs each step adds.
  for (const run of lineage) {
    const nodes = new Set(projection.nodes.filter((n) => n.runId === run.id).map((n) => n.id));
    const answers = new Set(
      projection.runtimeRequests
        .filter((r) => nodes.has(r.nodeId))
        .map((r) => answerMessageId(r.id)),
    );
    const answeredIn = new Set(
      projection.messages.filter((m) => answers.has(m.id)).map((m) => m.runId),
    );
    for (const next of projection.runs) {
      if (related.has(next.id)) continue;
      if (next.restartContinuationOfRunId !== run.id && !answeredIn.has(next.id)) continue;
      related.add(next.id);
      lineage.push(next);
    }
  }
  const current = lineage.reduce((latest, run) => (run.ordinal > latest.ordinal ? run : latest));
  return { run: current, related };
}

export const layer = Layer.effect(EditaiiT3Adapter, make);
