import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  RuntimeRequestId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Adapter from "./EditaiiT3Adapter.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { LiveStreamBufferError } from "../orchestration-v2/LiveStreamBudget.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";

import {
  driver,
  harness,
  modelSelection,
  plan,
  projectId,
  watch,
} from "./EditaiiT3Adapter.testkit.ts";

it.effect("accepts the same launch and queued message once; inspect recovers without writing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness("editaii-idempotency");
      yield* Effect.gen(function* () {
        const adapter = yield* Adapter.EditaiiT3Adapter;
        const engine = yield* Orchestrator.OrchestratorV2;
        const request = plan("idempotent");
        const { acceptance, turn } = yield* h.start(request);
        assert.deepEqual(yield* adapter.accept(request), acceptance);
        const before = yield* engine.getThreadSnapshot(request.threadId);
        assert.deepEqual(yield* adapter.inspect(request, null), { type: "found", acceptance });
        assert.deepEqual(yield* engine.getThreadSnapshot(request.threadId), before);
        assert.equal(yield* Queue.size(h.started), 0);
        const queued = { ...plan("queued", false), threadId: request.threadId };
        const second = yield* adapter.accept(queued);
        assert.deepEqual(yield* adapter.accept(queued), second);
        assert.notEqual(second.runId, acceptance.runId);
        const after = yield* engine.getThreadSnapshot(request.threadId);
        assert.equal(after.projection.runs.length, 2);
        assert.equal(after.projection.messages.filter((m) => m.id === queued.messageId).length, 1);
        yield* h.finish(turn, "First answer");
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);

it.effect("detects a lost T3 commit in a restored database without recreating the request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const restoredPath = `${dir}/restored.sqlite`;
      const h = yield* harness("editaii-lost-commit", `${dir}/original.sqlite`);
      const request = plan("lost-commit");
      const known = yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`VACUUM INTO ${restoredPath}`;
          const { acceptance, turn } = yield* h.start(request);
          yield* h.finish(turn, "Original answer");
          return acceptance;
        }).pipe(Effect.provide(h.layer)),
      );
      const restored = yield* harness("editaii-restored", restoredPath);
      yield* Effect.gen(function* () {
        const adapter = yield* Adapter.EditaiiT3Adapter;
        const engine = yield* Orchestrator.OrchestratorV2;
        const receipts = yield* Receipts.CommandReceiptStoreV2;
        const before = yield* engine.getThreadEventSequence(request.threadId);
        assert.deepEqual(yield* adapter.inspect(request, null), { type: "absent" });
        assert.deepEqual(yield* adapter.inspect(request, known), { type: "absent" });
        const lost = yield* Stream.runCollect(adapter.observe(known));
        assert.equal(lost[0]?.type, "thread_lost");
        assert.equal(yield* engine.getThreadEventSequence(request.threadId), before);
        assert.isNull(yield* engine.getThreadShell(request.threadId));
        assert.isTrue(Option.isNone(yield* receipts.getByCommandId(request.commandId)));
        assert.equal(yield* Queue.size(restored.started), 0);
      }).pipe(Effect.provide(restored.layer));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("compares the complete acceptance and emits a proven final answer after completion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness("editaii-provenance");
      yield* Effect.gen(function* () {
        const adapter = yield* Adapter.EditaiiT3Adapter;
        const request = plan("provenance");
        const { acceptance, turn } = yield* h.start(request);
        for (const incompatible of [
          { ...acceptance, threadId: ThreadId.make("other") },
          { ...acceptance, messageId: MessageId.make("other") },
          { ...acceptance, runId: RunId.make("other") },
          { ...acceptance, commandIds: acceptance.commandIds.slice(0, 1) },
        ])
          assert.equal((yield* adapter.inspect(request, incompatible)).type, "mismatch");
        yield* h.finish(turn, "Result for this run");
        const observed = yield* Stream.runCollect(adapter.observe(acceptance));
        assert.equal(observed.length, 1);
        assert.include(observed[0], {
          type: "answer",
          runId: acceptance.runId,
          text: "Result for this run",
          messageId: MessageId.make(`answer:${turn.attemptId}`),
        });
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);

it.effect("does not turn a completed run without assistant text into a placeholder answer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness("editaii-no-result");
      yield* Effect.gen(function* () {
        const adapter = yield* Adapter.EditaiiT3Adapter;
        const { acceptance, turn } = yield* h.start(plan("no-result"));
        yield* h.finish(turn, null);
        const observed = yield* Stream.runCollect(adapter.observe(acceptance));
        assert.equal(observed[0]?.type, "failure");
        assert.isFalse(observed.some((o) => o.type === "answer"));
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);

it.effect("does not take an assistant message that T3 never recorded as a turn item", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness("editaii-no-item");
      yield* Effect.gen(function* () {
        const adapter = yield* Adapter.EditaiiT3Adapter;
        const { acceptance, turn } = yield* h.start(plan("no-item"));
        yield* h.finish(turn, "Text without its turn item", false);
        const observed = yield* Stream.runCollect(adapter.observe(acceptance));
        assert.deepEqual(
          observed.map((o) => o.type),
          ["failure"],
        );
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);

it.effect(
  "observes pending questions and approvals; answers once and preserves arbitrary keys",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness("editaii-questions");
        yield* Effect.gen(function* () {
          const adapter = yield* Adapter.EditaiiT3Adapter;
          const engine = yield* Orchestrator.OrchestratorV2;
          const receipts = yield* Receipts.CommandReceiptStoreV2;
          const worker = yield* Worker.OrchestrationEffectWorkerV2;
          const { acceptance, turn } = yield* h.start(plan("questions"));
          const requestId = yield* h.question(turn, "question");
          const observation = yield* adapter.observe(acceptance).pipe(
            Stream.filter((o) => o.type === "question"),
            Stream.take(1),
            Stream.runCollect,
          );
          assert.equal(observation[0]?.type, "question");
          assert.include(observation[0], { requestId });
          const answer: Adapter.AnswerPlan = {
            version: 1,
            threadId: turn.threadId,
            requestId,
            commandId: CommandId.make("answer"),
            answers: Object.fromEntries([
              ["constructor", "yes"],
              ["__proto__", ["safe"]],
            ]),
          };
          const missingCommand = CommandId.make("missing-request");
          assert.equal(
            (yield* adapter.respond({
              ...answer,
              requestId: RuntimeRequestId.make("missing"),
              commandId: missingCommand,
            })).type,
            "unknown",
          );
          assert.isTrue(Option.isNone(yield* receipts.getByCommandId(missingCommand)));
          // Inspection only reads: an answer never sent is absent, and stays unsent.
          assert.deepEqual(yield* adapter.inspectAnswer(answer), { type: "absent" });
          assert.isTrue(Option.isNone(yield* receipts.getByCommandId(answer.commandId)));
          assert.deepEqual(yield* adapter.respond(answer), {
            type: "accepted",
            commandId: answer.commandId,
          });
          assert.deepEqual(yield* adapter.inspectAnswer(answer), {
            type: "found",
            commandId: answer.commandId,
          });
          // The id belongs to another kind of command: not this answer.
          const [launch] = acceptance.commandIds;
          if (launch === undefined) throw new Error("expected the launch command");
          assert.deepEqual(yield* adapter.inspectAnswer({ ...answer, commandId: launch }), {
            type: "mismatch",
          });
          assert.deepEqual(yield* adapter.respond(answer), {
            type: "accepted",
            commandId: answer.commandId,
          });
          yield* worker.drain();
          assert.equal(h.responses.length, 1);
          assert.deepEqual(h.responses[0]?.answers, answer.answers);
          assert.isTrue(Object.hasOwn(h.responses[0]?.answers ?? {}, "__proto__"));
          const unused = CommandId.make("already-resolved");
          const before = yield* engine.getThreadSnapshot(turn.threadId);
          assert.deepEqual(yield* adapter.respond({ ...answer, commandId: unused }), {
            type: "superseded",
          });
          assert.isTrue(Option.isNone(yield* receipts.getByCommandId(unused)));
          assert.deepEqual(yield* engine.getThreadSnapshot(turn.threadId), before);
          const resolved = yield* adapter.observe(acceptance).pipe(
            Stream.filter((o) => o.type === "resolved"),
            Stream.take(1),
            Stream.runCollect,
          );
          assert.include(resolved[0], { requestId, status: "resolved" });
          const approvalId = yield* h.question(turn, "approval");
          const approval = yield* adapter.observe(acceptance).pipe(
            Stream.filter((o) => o.type === "approval"),
            Stream.take(1),
            Stream.runCollect,
          );
          assert.include(approval[0], {
            requestId: approvalId,
            description: "Approve this command in T3",
          });
          const notResumable = yield* h.question(turn, "not_resumable");
          const commandId = CommandId.make("not-resumable");
          assert.deepEqual(
            yield* adapter.respond({ ...answer, requestId: notResumable, commandId }),
            { type: "not_resumable" },
          );
          assert.isTrue(Option.isNone(yield* receipts.getByCommandId(commandId)));
        }).pipe(Effect.provide(h.layer));
      }),
    ),
);

it.effect(
  "reports interruption after committed dispatch as unknown and inspect finds the acceptance",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness("editaii-unknown");
        yield* Effect.gen(function* () {
          const realLaunch = yield* Launch.ThreadLaunchService;
          const faulty = Layer.succeed(Launch.ThreadLaunchService, {
            ...realLaunch,
            launch: (input) => realLaunch.launch(input).pipe(Effect.andThen(Effect.interrupt)),
          });
          yield* Effect.gen(function* () {
            const adapter = yield* Adapter.EditaiiT3Adapter;
            const request = plan("unknown");
            const outcome = yield* adapter.accept(request).pipe(Effect.result);
            assert.equal(outcome._tag, "Failure");
            if (outcome._tag === "Failure")
              assert.equal(outcome.failure._tag, "EditaiiT3AcceptUnknown");
            assert.equal((yield* adapter.inspect(request, null)).type, "found");
          }).pipe(Effect.provide(Adapter.layer.pipe(Layer.provide(faulty))));
        }).pipe(Effect.provide(h.dependencies));
      }),
    ),
);

it.effect(
  "follows explicit restart continuations and excludes independent work on the same thread",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness("editaii-restart-lineage");
        yield* Effect.gen(function* () {
          const adapter = yield* Adapter.EditaiiT3Adapter;
          const engine = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const worker = yield* Worker.OrchestrationEffectWorkerV2;
          const request = plan("restart-lineage");
          const { acceptance } = yield* h.start(request);
          const original = (yield* engine.getThreadProjection(request.threadId)).runs.find(
            (r) => r.id === acceptance.runId,
          );
          if (!original) return yield* Effect.die("original run missing");
          const now = yield* DateTime.now;
          // The startup reconciliation commits this cut before the continuation worker dispatches its message.
          const restartCommand = CommandId.make("restart-cut");
          yield* sink.writeWithEffects({
            commandId: restartCommand,
            events: [
              {
                id: EventId.make("restart-cut"),
                type: "run.updated",
                threadId: request.threadId,
                runId: original.id,
                occurredAt: now,
                payload: { ...original, status: "cancelled", completedAt: now },
              },
            ],
            effects: [
              {
                id: `effect:restart-continuation:${original.id}`,
                commandId: restartCommand,
                threadId: request.threadId,
                request: { type: "provider-runtime.continue", sourceRunId: original.id },
              },
            ],
          });
          const waitingForContinuation = yield* Deferred.make<void, Error>();
          const observableEngine = Layer.succeed(Orchestrator.OrchestratorV2, {
            ...engine,
            awaitRestartContinuation: (run) =>
              Deferred.succeed(waitingForContinuation, undefined).pipe(
                Effect.andThen(engine.awaitRestartContinuation(run)),
              ),
          });
          const observing = yield* Effect.gen(function* () {
            const observingAdapter = yield* Adapter.EditaiiT3Adapter;
            return yield* Stream.runCollect(observingAdapter.observe(acceptance));
          }).pipe(
            Effect.provide(Adapter.layer.pipe(Layer.provide(observableEngine), Layer.fresh)),
            Effect.onExit(() =>
              Deferred.fail(
                waitingForContinuation,
                new Error("Observation ended before awaiting restart continuation"),
              ),
            ),
            Effect.forkScoped,
          );
          yield* Deferred.await(waitingForContinuation);
          const running = yield* watch(
            (e) => e.type === "provider-turn.updated" && e.payload.status === "running",
          );
          yield* worker.drain();
          const continued = yield* Queue.take(h.started);
          yield* Fiber.join(running);
          assert.equal(continued.restartContinuationOfRunId, original.id);
          yield* h.finish(continued, "Answer from the continuation");
          assert.isTrue(
            (yield* Fiber.join(observing)).some(
              (o) => o.type === "answer" && o.runId === continued.runId,
            ),
          );
          const humanRunning = yield* watch(
            (e) => e.type === "provider-turn.updated" && e.payload.status === "running",
          );
          yield* engine.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("human"),
            threadId: request.threadId,
            messageId: MessageId.make("human"),
            text: "Independent human message",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            modelSelection,
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          const human = yield* Queue.take(h.started);
          yield* Fiber.join(humanRunning);
          yield* h.finish(human, "Unrelated human answer");
          const observations = yield* Stream.runCollect(adapter.observe(acceptance));
          assert.equal(observations.length, 1);
          assert.include(observations[0], {
            type: "answer",
            runId: continued.runId,
            text: "Answer from the continuation",
          });
        }).pipe(Effect.provide(h.layer));
      }),
    ),
);

it.effect(
  "replays events in the snapshot-subscription gap and resubscribes after buffer overflow",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness("editaii-stream-recovery");
        yield* Effect.gen(function* () {
          const real = yield* Orchestrator.OrchestratorV2;
          const worker = yield* Worker.OrchestrationEffectWorkerV2;
          const { acceptance, turn } = yield* h.start(plan("stream-recovery"));
          let subscriptions = 0;
          const transport = Layer.succeed(Orchestrator.OrchestratorV2, {
            ...real,
            streamStoredEventsFrom: (input) =>
              Stream.unwrap(
                Effect.gen(function* () {
                  subscriptions++;
                  if (subscriptions === 1)
                    return Stream.fail(
                      new Orchestrator.OrchestratorDomainEventStreamError({
                        cause: new EventSink.EventSinkStreamError({
                          cause: new LiveStreamBufferError({ message: "test overflow" }),
                        }),
                      }),
                    );
                  // Finish after the snapshot was returned, before the real replay/live subscription opens.
                  yield* h
                    .finish(turn, "Answer in the subscription gap")
                    .pipe(
                      Effect.provideService(Orchestrator.OrchestratorV2, real),
                      Effect.provideService(Worker.OrchestrationEffectWorkerV2, worker),
                      Effect.orDie,
                    );
                  return real.streamStoredEventsFrom(input);
                }),
              ),
          });
          yield* Effect.gen(function* () {
            const adapter = yield* Adapter.EditaiiT3Adapter;
            const observations = yield* Stream.runCollect(adapter.observe(acceptance));
            assert.equal(subscriptions, 2);
            assert.equal(observations.filter((o) => o.type === "running").length, 1);
            assert.include(observations.at(-1), {
              type: "answer",
              text: "Answer in the subscription gap",
            });
          }).pipe(Effect.provide(Adapter.layer.pipe(Layer.provide(transport), Layer.fresh)));
        }).pipe(Effect.provide(h.layer));
      }),
    ),
);

it.effect(
  "replays message-capability answers by receipt and does not burn an already resolved request",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness("editaii-message-answer");
        yield* Effect.gen(function* () {
          const adapter = yield* Adapter.EditaiiT3Adapter;
          const engine = yield* Orchestrator.OrchestratorV2;
          const receipts = yield* Receipts.CommandReceiptStoreV2;
          const { turn } = yield* h.start(plan("message-answer"));
          const requestId = yield* h.question(turn, "message");
          const answer: Adapter.AnswerPlan = {
            version: 1,
            threadId: turn.threadId,
            requestId,
            commandId: CommandId.make("message-response"),
            answers: Object.fromEntries([
              ["constructor", "Yes"],
              ["__proto__", "Safe"],
            ]),
          };
          assert.deepEqual(yield* adapter.respond(answer), {
            type: "accepted",
            commandId: answer.commandId,
          });
          assert.deepEqual(yield* adapter.respond(answer), {
            type: "accepted",
            commandId: answer.commandId,
          });
          const projection = yield* engine.getThreadProjection(turn.threadId);
          assert.equal(
            projection.messages.filter((m) => m.id === `async-answer:${requestId}`).length,
            1,
          );
          const commandId = CommandId.make("already-answered-message");
          assert.deepEqual(yield* adapter.respond({ ...answer, commandId }), {
            type: "superseded",
          });
          assert.isTrue(Option.isNone(yield* receipts.getByCommandId(commandId)));
        }).pipe(Effect.provide(h.layer));
      }),
    ),
);

it.effect("a conversation whose T3 thread is gone is told so, with nothing dispatched", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness("editaii-thread-missing");
      yield* Effect.gen(function* () {
        const adapter = yield* Adapter.EditaiiT3Adapter;
        const engine = yield* Orchestrator.OrchestratorV2;
        const before = yield* engine.getThreadEventSequence(ThreadId.make("missing"));
        const outcome = yield* adapter.accept(plan("missing", false)).pipe(Effect.result);
        assert.equal(outcome._tag, "Failure");
        if (outcome._tag === "Failure")
          assert.equal(outcome.failure._tag, "EditaiiT3ThreadMissing");
        assert.deepEqual(yield* engine.getThreadEventSequence(ThreadId.make("missing")), before);
        assert.deepEqual(yield* adapter.inspect(plan("missing", false), null), { type: "absent" });
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);

it.effect("distinguishes a permanent rejection from an unreadable acceptance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness("editaii-rejection");
      yield* Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const adapter = yield* Adapter.EditaiiT3Adapter;
        const original = plan("rejected");
        yield* h.start(original);
        const request = { ...plan("refused"), threadId: original.threadId };
        yield* engine
          .dispatch({
            type: "thread.create",
            commandId: request.commandId,
            threadId: request.threadId,
            projectId,
            title: "Duplicate",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.exit);
        const outcome = yield* adapter.accept(request).pipe(Effect.result);
        assert.equal(outcome._tag, "Failure");
        if (outcome._tag === "Failure")
          assert.equal(outcome.failure._tag, "EditaiiT3AcceptRefused");
        assert.equal((yield* engine.getThreadProjection(request.threadId)).runs.length, 1);
        const unreadable = Layer.succeed(Orchestrator.OrchestratorV2, {
          ...engine,
          getThreadShell: (threadId) =>
            Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        });
        yield* Effect.gen(function* () {
          const isolated = yield* Adapter.EditaiiT3Adapter;
          const result = yield* isolated.inspect(plan("unreadable"), null).pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") assert.equal(result.failure._tag, "EditaiiT3ReadError");
        }).pipe(Effect.provide(Adapter.layer.pipe(Layer.provide(unreadable), Layer.fresh)));
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);

it.effect(
  "keeps asking a question T3 recovered after a restart and follows the run its answer starts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness("editaii-recovered-question");
        yield* Effect.gen(function* () {
          const adapter = yield* Adapter.EditaiiT3Adapter;
          const worker = yield* Worker.OrchestrationEffectWorkerV2;
          const { acceptance, turn } = yield* h.start(plan("recovered-question"));
          const requestId = yield* h.question(turn, "question");
          const approvalId = yield* h.question(turn, "approval");
          yield* h.recover;
          // One observer follows the whole job: the ended run must not end it while a question waits.
          const asked = yield* Deferred.make<void>();
          const observing = yield* adapter.observe(acceptance).pipe(
            Stream.tap((o) =>
              o.type === "question" ? Deferred.succeed(asked, undefined) : Effect.void,
            ),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Deferred.await(asked);
          const answer: Adapter.AnswerPlan = {
            version: 1,
            threadId: turn.threadId,
            requestId,
            commandId: CommandId.make("recovered-answer"),
            answers: Object.fromEntries([
              ["constructor", "Yes"],
              ["__proto__", "Safe"],
            ]),
          };
          assert.deepEqual(
            yield* adapter.respond({
              ...answer,
              requestId: approvalId,
              commandId: CommandId.make("expired-approval"),
            }),
            { type: "not_resumable" },
          );
          const running = yield* watch(
            (e) => e.type === "provider-turn.updated" && e.payload.status === "running",
          );
          assert.deepEqual(yield* adapter.respond(answer), {
            type: "accepted",
            commandId: answer.commandId,
          });
          yield* worker.drain();
          const continued = yield* Queue.take(h.started);
          yield* Fiber.join(running);
          assert.notEqual(continued.runId, acceptance.runId);
          yield* h.finish(continued, "Answer after the restart");
          const observed = yield* Fiber.join(observing);
          assert.isFalse(observed.some((o) => o.type === "failure"));
          assert.include(
            observed.find((o) => o.type === "question"),
            { requestId, capability: "message" },
          );
          assert.include(observed.at(-1), {
            type: "answer",
            runId: continued.runId,
            text: "Answer after the restart",
          });
        }).pipe(Effect.provide(h.layer));
      }),
    ),
);

it.effect("answers a request T3 cancelled as not resumable, not as answered elsewhere", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness("editaii-cancelled-request");
      yield* Effect.gen(function* () {
        const adapter = yield* Adapter.EditaiiT3Adapter;
        const engine = yield* Orchestrator.OrchestratorV2;
        const receipts = yield* Receipts.CommandReceiptStoreV2;
        const { turn } = yield* h.start(plan("cancelled-request"));
        const requestId = yield* h.question(turn, "question");
        const request = (yield* engine.getThreadProjection(turn.threadId)).runtimeRequests.find(
          (r) => r.id === requestId,
        );
        if (!request) return yield* Effect.die("request missing");
        const cancelled = yield* watch(
          (e) => e.type === "runtime-request.updated" && e.payload.status === "cancelled",
        );
        const now = yield* DateTime.now;
        yield* Queue.offer(h.events, {
          type: "runtime_request.updated",
          driver,
          threadId: turn.threadId,
          runtimeRequest: { ...request, status: "cancelled", resolvedAt: now },
        });
        yield* Fiber.join(cancelled);
        const commandId = CommandId.make("cancelled-answer");
        assert.deepEqual(
          yield* adapter.respond({
            version: 1,
            threadId: turn.threadId,
            requestId,
            commandId,
            answers: { constructor: "Yes" },
          }),
          { type: "not_resumable" },
        );
        assert.isTrue(Option.isNone(yield* receipts.getByCommandId(commandId)));
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);

it.effect("reports a thread deleted between its shell and snapshot reads as lost", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness("editaii-deleted-between-reads");
      yield* Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const request = plan("deleted-between-reads");
        const { acceptance, turn } = yield* h.start(request);
        yield* h.finish(turn, "Answer before deletion");
        const shell = yield* engine.getThreadShell(request.threadId);
        assert.isNotNull(shell);
        yield* engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete-thread"),
          threadId: request.threadId,
        });
        // The shell was read just before the deletion committed.
        const stale = Layer.succeed(Orchestrator.OrchestratorV2, {
          ...engine,
          getThreadShell: () => Effect.succeed(shell),
        });
        yield* Effect.gen(function* () {
          const adapter = yield* Adapter.EditaiiT3Adapter;
          assert.deepEqual(yield* adapter.inspect(request, acceptance), {
            type: "mismatch",
            reason: "thread",
          });
          const observed = yield* Stream.runCollect(adapter.observe(acceptance));
          assert.deepEqual(
            observed.map((o) => o.type),
            ["thread_lost"],
          );
        }).pipe(Effect.provide(Adapter.layer.pipe(Layer.provide(stale), Layer.fresh)));
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);

const answerTo = (
  turn: ProviderAdapter.ProviderAdapterV2TurnInput,
  requestId: RuntimeRequestId,
): Adapter.AnswerPlan => ({
  version: 1,
  threadId: turn.threadId,
  requestId,
  commandId: CommandId.make(`answer:${requestId}`),
  answers: Object.fromEntries([
    ["constructor", "Yes"],
    ["__proto__", "Safe"],
  ]),
});

// Two questions answered by message after a restart start two runs; both are leaves of the lineage.
const branches = (name: string, firstEnds: "failed" | "completed") =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness(name);
      return yield* Effect.gen(function* () {
        const adapter = yield* Adapter.EditaiiT3Adapter;
        const worker = yield* Worker.OrchestrationEffectWorkerV2;
        const { acceptance, turn } = yield* h.start(plan(name));
        const first = yield* h.question(turn, "question", "first");
        const second = yield* h.question(turn, "question", "second");
        yield* h.recover;
        const startedBy = (requestId: RuntimeRequestId) =>
          Effect.gen(function* () {
            const running = yield* watch(
              (e) => e.type === "provider-turn.updated" && e.payload.status === "running",
            );
            assert.equal((yield* adapter.respond(answerTo(turn, requestId))).type, "accepted");
            yield* worker.drain();
            const next = yield* Queue.take(h.started);
            yield* Fiber.join(running);
            return next;
          });
        const earlier = yield* startedBy(first);
        const pending = yield* adapter.observe(acceptance).pipe(
          Stream.filter((o) => o.type === "question"),
          Stream.take(1),
          Stream.runCollect,
        );
        // The question still waiting belongs to the run that asked it, not to the live one.
        assert.include(pending[0], { requestId: second, runId: acceptance.runId });
        if (firstEnds === "failed") yield* h.endRun(earlier, "failed");
        else yield* h.finish(earlier, "Answer to the first question");
        const later = yield* startedBy(second);
        assert.isAbove(later.runOrdinal, earlier.runOrdinal);
        yield* h.finish(later, "Answer to the second question");
        const observed = yield* Stream.runCollect(adapter.observe(acceptance));
        return { observed, earlier, later };
      }).pipe(Effect.provide(h.layer));
    }),
  );

it.effect("fails the job when one answered branch fails, even if a later branch completes", () =>
  Effect.gen(function* () {
    const { observed, earlier } = yield* branches("editaii-branch-failed", "failed");
    assert.isFalse(observed.some((o) => o.type === "answer"));
    assert.include(observed.at(-1), { type: "failure", runId: earlier.runId });
  }),
);

it.effect("answers with the latest branch when every answered branch completes", () =>
  Effect.gen(function* () {
    const { observed, later } = yield* branches("editaii-branch-completed", "completed");
    assert.isFalse(observed.some((o) => o.type === "failure"));
    assert.include(observed.at(-1), {
      type: "answer",
      runId: later.runId,
      text: "Answer to the second question",
    });
  }),
);

it.effect("ends the job when the pending requests of its ended run can no longer be answered", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness("editaii-unanswerable");
      yield* Effect.gen(function* () {
        const adapter = yield* Adapter.EditaiiT3Adapter;
        const engine = yield* Orchestrator.OrchestratorV2;
        const { acceptance, turn } = yield* h.start(plan("unanswerable"));
        yield* h.question(turn, "not_resumable");
        const approvalId = yield* h.question(turn, "approval");
        const approval = (yield* engine.getThreadProjection(turn.threadId)).runtimeRequests.find(
          (r) => r.id === approvalId,
        );
        if (!approval) return yield* Effect.die("approval missing");
        const closed = yield* watch(
          (e) =>
            e.type === "runtime-request.updated" &&
            e.payload.id === approvalId &&
            e.payload.responseCapability.type === "not_resumable",
        );
        yield* Queue.offer(h.events, {
          type: "runtime_request.updated",
          driver,
          threadId: turn.threadId,
          runtimeRequest: {
            ...approval,
            responseCapability: { type: "not_resumable", reason: "Provider ended" },
          },
        });
        yield* Fiber.join(closed);
        assert.include(
          (yield* adapter.observe(acceptance).pipe(
            Stream.filter((o) => o.type === "approval"),
            Stream.take(1),
            Stream.runCollect,
          ))[0],
          { requestId: approvalId, capability: "not_resumable" },
        );
        yield* h.endRun(turn, "cancelled");
        const observed = yield* Stream.runCollect(adapter.observe(acceptance));
        assert.include(observed.at(-1), { type: "failure", reason: "run-ended" });
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);

it.effect("follows an answer steered into a run someone else started on the thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness("editaii-steered-answer");
      yield* Effect.gen(function* () {
        const adapter = yield* Adapter.EditaiiT3Adapter;
        const engine = yield* Orchestrator.OrchestratorV2;
        const worker = yield* Worker.OrchestrationEffectWorkerV2;
        const { acceptance, turn } = yield* h.start(plan("steered-answer"));
        const requestId = yield* h.question(turn, "question");
        yield* h.recover;
        const asked = yield* Deferred.make<void>();
        const observing = yield* adapter.observe(acceptance).pipe(
          Stream.tap((o) =>
            o.type === "question" ? Deferred.succeed(asked, undefined) : Effect.void,
          ),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(asked);
        const humanRunning = yield* watch(
          (e) => e.type === "provider-turn.updated" && e.payload.status === "running",
        );
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("human"),
          threadId: turn.threadId,
          messageId: MessageId.make("human"),
          text: "Someone else's message",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          modelSelection,
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const human = yield* Queue.take(h.started);
        yield* Fiber.join(humanRunning);
        assert.equal((yield* adapter.respond(answerTo(turn, requestId))).type, "accepted");
        yield* worker.drain();
        const steered = (yield* engine.getThreadProjection(turn.threadId)).messages.find(
          (m) => m.id === `async-answer:${requestId}`,
        );
        assert.equal(steered?.runId, human.runId);
        yield* h.finish(human, "Answer that took the steered reply");
        const observed = yield* Fiber.join(observing);
        assert.isFalse(observed.some((o) => o.type === "failure"));
        assert.include(observed.at(-1), {
          type: "answer",
          runId: human.runId,
          text: "Answer that took the steered reply",
        });
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);
