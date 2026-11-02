import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
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
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Harness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as Project from "../project/ProjectService.ts";
import * as Setup from "../project/ProjectSetupScriptRunner.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as SetupTracker from "../project/WorktreeSetupTracker.ts";
import * as CloneTracker from "../project/ProjectCloneTracker.ts";
import * as Terminal from "../terminal/Manager.ts";
import * as Git from "../git/GitWorkflowService.ts";
import * as Text from "../textGeneration/TextGeneration.ts";
import * as RegistryMock from "../provider/testUtils/providerRegistryMock.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const projectId = ProjectId.make("editaii-project");
const plan = (name: string, newThread = true): Adapter.RequestPlan => ({
  version: 1,
  threadId: ThreadId.make(name),
  commandId: CommandId.make(`command:${name}`),
  messageId: MessageId.make(`message:${name}`),
  text: `Request ${name}`,
  newThread: newThread
    ? {
        projectId,
        title: name,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      }
    : null,
});

const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    return yield* engine.streamDomainEvents.pipe(
      Stream.filter(predicate),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
  });

const harness = Effect.fn("EditaiiT3Adapter.testHarness")(function* (
  name: string,
  databasePath?: string,
) {
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2TurnInput>();
  const responses: Array<
    Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["respondToRuntimeRequest"]>[0]
  > = [];
  const provider: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const startTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            yield* Queue.offer(started, turn);
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: ProviderTurnId.make(`turn:${turn.attemptId}`),
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" },
                ordinal: turn.providerTurnOrdinal,
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            });
          });
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn,
          compactThread: startTurn,
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: (response) =>
            Effect.sync(() => {
              responses.push(response);
            }),
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const database =
    databasePath === undefined
      ? Sqlite.layerMemory
      : Sqlite.layerFromPath(databasePath).pipe(Layer.provide(NodeServices.layer));
  const orchestration = Harness.layerWithRegistry({ name }, Registry.layerSingle(provider), {
    databaseLayer: database,
    runEffectWorker: false,
  });
  const receipts = Receipts.layer.pipe(Layer.provide(database));
  const settings = Settings.layerTest();
  const threads = Threads.layer.pipe(
    Layer.provide(Layer.mergeAll(orchestration, receipts, settings)),
  );
  const project = {
    id: projectId,
    title: "Editaii",
    workspaceRoot: cwd,
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: modelSelection,
    defaultThreadEnvMode: null,
    scripts: [],
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    deletedAt: null,
  };
  const external = Layer.mergeAll(
    SetupTracker.layer,
    RegistryMock.layer(),
    settings,
    IdAllocator.layer,
    Layer.mock(CloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(Terminal.TerminalManager)({ close: () => Effect.void }),
    Layer.mock(Project.ProjectService)({ getById: () => Effect.succeedSome(project) }),
    Layer.mock(Git.GitWorkflowService)({ hasCommit: () => Effect.succeed(false) }),
    Layer.succeed(Setup.ProjectSetupScriptRunner, {
      runForThread: () => Effect.succeed({ status: "no-script" }),
    }),
    Layer.mock(Text.TextGeneration)({}),
    Layer.mock(Folders.ManagedProjectFolders)({
      namedProjectsRoot: cwd,
      isScratchProject: () => Effect.succeed(false),
      folderForThread: () => Effect.succeedNone,
    }),
  );
  const launch = Launch.layer.pipe(Layer.provide(Layer.mergeAll(external, threads, receipts)));
  const dependencies = Layer.mergeAll(orchestration, receipts, threads, launch, database);
  const layer = Layer.provideMerge(Adapter.layer, dependencies);

  const start = Effect.fn("EditaiiT3Adapter.testStart")(function* (request: Adapter.RequestPlan) {
    const adapter = yield* Adapter.EditaiiT3Adapter;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const released = yield* watch(
      (e) =>
        e.type === "run.updated" &&
        e.threadId === request.threadId &&
        e.payload.status === "starting",
    );
    const acceptance = yield* adapter.accept(request);
    yield* Fiber.join(released);
    const running = yield* watch(
      (e) =>
        e.type === "provider-turn.updated" &&
        e.threadId === request.threadId &&
        e.payload.status === "running",
    );
    yield* worker.drain();
    const turn = yield* Queue.take(started);
    yield* Fiber.join(running);
    return { acceptance, turn };
  });
  const finish = Effect.fn("EditaiiT3Adapter.testFinish")(function* (
    turn: ProviderAdapter.ProviderAdapterV2TurnInput,
    text: string | null,
  ) {
    const engine = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const before = yield* engine.getThreadProjection(turn.threadId);
    const providerTurn = before.providerTurns.find((t) => t.runAttemptId === turn.attemptId);
    assert.isDefined(providerTurn);
    if (providerTurn === undefined) return yield* Effect.die("provider turn missing");
    const now = yield* DateTime.now;
    if (text !== null)
      yield* Queue.offer(events, {
        type: "turn_item.updated",
        driver,
        turnItem: {
          id: TurnItemId.make(`answer:${turn.attemptId}`),
          threadId: turn.threadId,
          runId: turn.runId,
          nodeId: turn.rootNodeId,
          providerThreadId: providerTurn.providerThreadId,
          providerTurnId: providerTurn.id,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "assistant_message",
          messageId: MessageId.make(`answer:${turn.attemptId}`),
          text,
          streaming: false,
        },
      });
    if (text !== null)
      yield* Queue.offer(events, {
        type: "message.updated",
        driver,
        message: {
          id: MessageId.make(`answer:${turn.attemptId}`),
          threadId: turn.threadId,
          runId: turn.runId,
          nodeId: turn.rootNodeId,
          role: "assistant",
          text,
          attachments: [],
          streaming: false,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: now,
          updatedAt: now,
        },
      });
    const waiting = yield* watch(
      (e) =>
        e.type === "run.updated" && e.payload.id === turn.runId && e.payload.status === "waiting",
    );
    yield* Queue.offer(events, {
      type: "provider_turn.updated",
      driver,
      providerTurn: { ...providerTurn, status: "completed", completedAt: now },
    });
    yield* Queue.offer(events, {
      type: "turn.terminal",
      driver,
      providerThreadId: providerTurn.providerThreadId,
      providerTurnId: providerTurn.id,
      runOrdinal: turn.runOrdinal,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    });
    yield* Fiber.join(waiting);
    yield* worker.drain();
  });
  const question = Effect.fn("EditaiiT3Adapter.testQuestion")(function* (
    turn: ProviderAdapter.ProviderAdapterV2TurnInput,
    kind: "question" | "approval" | "not_resumable" | "message",
  ) {
    const engine = yield* Orchestrator.OrchestratorV2;
    const providerTurn = (yield* engine.getThreadProjection(turn.threadId)).providerTurns.find(
      (t) => t.runAttemptId === turn.attemptId,
    );
    if (!providerTurn) return yield* Effect.die("provider turn missing");
    const providerSessionId = turn.providerThread.providerSessionId;
    if (providerSessionId === null) return yield* Effect.die("provider session missing");
    const now = yield* DateTime.now;
    const id = RuntimeRequestId.make(`request:${turn.attemptId}:${kind}`);
    const nodeId = NodeId.make(`node:${id}`);
    const itemId = TurnItemId.make(`item:${id}`);
    const persisted = yield* watch(
      (e) => e.type === "turn-item.updated" && e.payload.id === itemId,
    );
    yield* Queue.offer(events, {
      type: "node.updated",
      driver,
      node: {
        id: nodeId,
        threadId: turn.threadId,
        runId: turn.runId,
        parentNodeId: turn.rootNodeId,
        rootNodeId: turn.rootNodeId,
        kind: kind === "approval" ? "approval_request" : "user_input_request",
        status: "waiting",
        countsForRun: true,
        providerThreadId: turn.providerThread.id,
        providerTurnId: providerTurn.id,
        nativeItemRef: null,
        runtimeRequestId: id,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    });
    yield* Queue.offer(events, {
      type: "runtime_request.updated",
      driver,
      threadId: turn.threadId,
      runtimeRequest: {
        id,
        nodeId,
        providerTurnId: providerTurn.id,
        nativeRequestRef: { driver, nativeId: id, strength: "strong" },
        kind: kind === "approval" ? "command" : "user_input",
        status: "pending",
        responseCapability:
          kind === "not_resumable"
            ? { type: "not_resumable", reason: "Provider ended" }
            : kind === "message"
              ? { type: "message" }
              : { type: "live", providerSessionId },
        createdAt: now,
        resolvedAt: null,
      },
    });
    const base = {
      id: itemId,
      threadId: turn.threadId,
      runId: turn.runId,
      nodeId,
      providerThreadId: turn.providerThread.id,
      providerTurnId: providerTurn.id,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "waiting" as const,
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      requestId: id,
    };
    yield* Queue.offer(events, {
      type: "turn_item.updated",
      driver,
      turnItem:
        kind === "approval"
          ? {
              ...base,
              type: "approval_request",
              requestKind: "command",
              prompt: "Approve this command in T3",
            }
          : {
              ...base,
              type: "user_input_request",
              questions: ["constructor", "__proto__"].map((key) => ({
                id: key,
                header: key,
                question: key,
                options: [],
                allowCustomAnswer: true,
              })),
            },
    });
    yield* Fiber.join(persisted);
    return id;
  });
  return { layer, events, started, responses, start, finish, question, dependencies };
});

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
          assert.deepEqual(yield* adapter.respond(answer), {
            type: "accepted",
            commandId: answer.commandId,
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
