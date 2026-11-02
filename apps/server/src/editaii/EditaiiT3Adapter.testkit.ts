/**
 * A T3 for tests of the Editaii seam: the real orchestrator, receipts, thread launch and thread
 * management over SQLite (in memory, or a file to restore), with a scripted provider. The effect
 * worker runs only when the test drains it. Used by the adapter's contract tests and the
 * connector's integration tests.
 */
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
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2UserInputQuestion,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Adapter from "./EditaiiT3Adapter.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Recovery from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
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

export const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
export const modelSelection = { instanceId, model: "test-model" };
export const projectId = ProjectId.make("editaii-project");
export const plan = (name: string, newThread = true): Adapter.RequestPlan => ({
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

/** Waits, in the background, for the first domain event that matches. */
export const watch = Effect.fn("EditaiiT3Harness.watch")(function* (
  predicate: (event: OrchestrationV2DomainEvent) => boolean,
) {
  const engine = yield* Orchestrator.OrchestratorV2;
  return yield* engine.streamDomainEvents.pipe(
    Stream.filter(predicate),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkScoped,
  );
});

export const harness = Effect.fn("EditaiiT3Adapter.testHarness")(function* (
  name: string,
  databasePath?: string,
  // As a T3 that restarts on the file: reconcile what was live before it serves anything.
  options: { readonly recoverOnStartup?: boolean } = {},
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
    openSession: Effect.fn("EditaiiT3Harness.openSession")(function* (input) {
      const now = yield* DateTime.now;
      const startTurn = Effect.fn("EditaiiT3Harness.startTurn")(function* (
        turn: ProviderAdapter.ProviderAdapterV2TurnInput,
      ) {
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
    recoverOnStartup: options.recoverOnStartup ?? false,
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

  /**
   * Watches for a run to be released to the provider, on `threadId` or any thread. Start watching
   * before whatever accepts the request, so the release cannot pass unseen.
   */
  const release = (threadId?: ThreadId) =>
    watch(
      (e) =>
        e.type === "run.updated" &&
        (threadId === undefined || e.threadId === threadId) &&
        e.payload.status === "starting",
    );
  /** Has the provider start the next turn the T3 owes it, as an answer by message does. */
  const nextTurn = Effect.fn("EditaiiT3Adapter.testNextTurn")(function* () {
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const running = yield* watch(
      (e) => e.type === "provider-turn.updated" && e.payload.status === "running",
    );
    yield* worker.drain();
    const turn = yield* Queue.take(started);
    yield* Fiber.join(running);
    return turn;
  });
  /** Once `released` saw the run released, has the provider start its turn. */
  const beginTurn = Effect.fn("EditaiiT3Adapter.testBeginTurn")(function* (
    released: Effect.Success<ReturnType<typeof release>>,
  ) {
    yield* Fiber.join(released);
    return yield* nextTurn();
  });
  const start = Effect.fn("EditaiiT3Adapter.testStart")(function* (request: Adapter.RequestPlan) {
    const adapter = yield* Adapter.EditaiiT3Adapter;
    const released = yield* release(request.threadId);
    const acceptance = yield* adapter.accept(request);
    return { acceptance, turn: yield* beginTurn(released) };
  });
  const finish = Effect.fn("EditaiiT3Adapter.testFinish")(function* (
    turn: ProviderAdapter.ProviderAdapterV2TurnInput,
    text: string | null,
    withTurnItem = true,
  ) {
    const engine = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const before = yield* engine.getThreadProjection(turn.threadId);
    const providerTurn = before.providerTurns.find((t) => t.runAttemptId === turn.attemptId);
    if (providerTurn === undefined) return yield* Effect.die("provider turn missing");
    const now = yield* DateTime.now;
    if (text !== null && withTurnItem)
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
    name: string = kind,
    questions: ReadonlyArray<OrchestrationV2UserInputQuestion> = ["constructor", "__proto__"].map(
      (key) => ({ id: key, header: key, question: key, options: [], allowCustomAnswer: true }),
    ),
  ) {
    const engine = yield* Orchestrator.OrchestratorV2;
    const providerTurn = (yield* engine.getThreadProjection(turn.threadId)).providerTurns.find(
      (t) => t.runAttemptId === turn.attemptId,
    );
    if (!providerTurn) return yield* Effect.die("provider turn missing");
    const providerSessionId = turn.providerThread.providerSessionId;
    if (providerSessionId === null) return yield* Effect.die("provider session missing");
    const now = yield* DateTime.now;
    const id = RuntimeRequestId.make(`request:${turn.attemptId}:${name}`);
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
              questions,
            },
    });
    yield* Fiber.join(persisted);
    return id;
  });
  // The startup reconcile: it cancels live runs, turns pending questions into ones answered by
  // message, and expires other requests. It reads and writes the database the harness runs on.
  const recover = Recovery.ProviderRuntimeRecoveryService.use((r) => r.reconcile("startup")).pipe(
    Effect.provide(
      Recovery.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ProjectionStore.layer,
            EffectOutbox.layer,
            IdAllocator.layer,
            Settings.layerTest(),
          ),
        ),
      ),
    ),
  );
  const endRun = Effect.fn("EditaiiT3Adapter.testEndRun")(function* (
    turn: ProviderAdapter.ProviderAdapterV2TurnInput,
    status: "failed" | "cancelled",
  ) {
    const engine = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const run = (yield* engine.getThreadProjection(turn.threadId)).runs.find(
      (r) => r.id === turn.runId,
    );
    if (!run) return yield* Effect.die("run missing");
    const now = yield* DateTime.now;
    yield* sink.writeWithEffects({
      commandId: CommandId.make(`end:${run.id}`),
      events: [
        {
          id: EventId.make(`end:${run.id}`),
          type: "run.updated",
          threadId: turn.threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status, completedAt: now },
        },
      ],
      effects: [],
    });
  });
  return {
    layer,
    events,
    started,
    responses,
    release,
    beginTurn,
    nextTurn,
    start,
    finish,
    question,
    recover,
    endRun,
    dependencies,
  };
});
