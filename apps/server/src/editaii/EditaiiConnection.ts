// @effect-diagnostics nodeBuiltinImport:off -- The loopback HTTP listener and RFC 7636 hashes use Node APIs.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as Clock from "effect/Clock";
import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as ProcessRunner from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";
import {
  EditaiiConnectionState,
  EditaiiMachine,
  EditaiiProblem,
  EditaiiRequestError,
  editaiiProblemMessage,
} from "@t3tools/contracts";

export class EditaiiConnectionError extends Schema.TaggedError<EditaiiConnectionError>()(
  "EditaiiConnectionError",
  { reason: EditaiiProblem, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return editaiiProblemMessage(this.reason);
  }
  toClientError() {
    return new EditaiiRequestError({ reason: this.reason });
  }
}

const Origin = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value;
    } catch {
      return false;
    }
  }),
);
const Common = {
  version: Schema.Literal(1),
  origin: Schema.NullOr(Origin),
  environmentId: Schema.String,
};
const PairingFields = {
  attempt: Schema.String,
  state: Schema.String,
  verifier: Schema.String,
  credential: Schema.String,
  machineName: Schema.String,
  port: Schema.Number,
  expiresAt: Schema.Number,
};
const AccessToken = { client_id: Schema.String, client_secret: Schema.String };
const RecordSchema = Schema.Union([
  Schema.Struct({ ...Common, phase: Schema.Literal("disconnected") }),
  Schema.Struct({ ...Common, ...PairingFields, phase: Schema.Literal("pairing") }),
  Schema.Struct({
    ...Common,
    ...PairingFields,
    ...AccessToken,
    code: Schema.String,
    phase: Schema.Literal("redeeming"),
  }),
  Schema.Struct({
    ...Common,
    ...AccessToken,
    credential: Schema.String,
    machine: EditaiiMachine,
    phase: Schema.Literal("connected"),
  }),
]);
type Stored = typeof RecordSchema.Type;
type Pairing = Extract<Stored, { phase: "pairing" }>;
type Redeeming = Extract<Stored, { phase: "redeeming" }>;
const RecordJson = Schema.fromJsonString(RecordSchema);
const SECRET_NAME = "editaii-connection";
const PAIRING_LIFETIME = 10 * 60 * 1000;
const MAX_CALLBACK_BYTES = 8192;
const encodeRecord = Schema.encodeEffect(RecordJson);
const decodeRecord = Schema.decodeEffect(RecordJson);
const decodeMachine = Schema.decodeUnknownEffect(EditaiiMachine);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

export class EditaiiConnection extends Context.Service<
  EditaiiConnection,
  {
    readonly state: Effect.Effect<EditaiiConnectionState>;
    readonly changes: Stream.Stream<EditaiiConnectionState>;
    readonly configure: (input: {
      readonly origin: string;
    }) => Effect.Effect<void, EditaiiConnectionError>;
    readonly startPairing: (input: {
      readonly machineName: string;
    }) => Effect.Effect<void, EditaiiConnectionError>;
    readonly reopenBrowser: () => Effect.Effect<void, EditaiiConnectionError>;
    readonly disconnect: () => Effect.Effect<void, EditaiiConnectionError>;
  }
>()("t3/editaii/EditaiiConnection") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const launcher = yield* ExternalLauncher.ExternalLauncher;
  const files = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const processEnv = yield* HostProcess.Environment;
  const userId = yield* HostProcess.UserId;
  const http = yield* HttpClient.HttpClient;
  const clock = yield* Clock.Clock;
  const environmentId = yield* environment.getEnvironmentId;
  const ready = yield* Deferred.make<void>();
  const commands = yield* Semaphore.make(1);
  const writes = yield* Semaphore.make(1);
  let stored: Stored = { version: 1, phase: "disconnected", origin: null, environmentId };
  let readFailure: EditaiiConnectionError | undefined;
  let session: { readonly scope: Scope.Closeable; readonly attempt: string } | undefined;
  const view = yield* SubscriptionRef.make<EditaiiConnectionState>({
    status: "disconnected",
    origin: null,
    machine: null,
    problem: null,
    canReopen: false,
  });

  const publish = Effect.fn("EditaiiConnection.publish")(function* (
    problem: typeof EditaiiProblem.Type | null = null,
  ) {
    const next: EditaiiConnectionState = {
      status: problem === null ? stored.phase : "error",
      origin: stored.origin,
      machine: stored.phase === "connected" ? stored.machine : null,
      problem,
      canReopen:
        stored.phase === "pairing" &&
        session !== undefined &&
        stored.expiresAt > (yield* clock.currentTimeMillis),
    };
    return yield* SubscriptionRef.set(view, next);
  });
  const save = Effect.fn("EditaiiConnection.save")(function* (next: Stored) {
    const json = yield* encodeRecord(next).pipe(
      Effect.mapError((cause) => new EditaiiConnectionError({ reason: "storage", cause })),
    );
    yield* secrets.set(SECRET_NAME, new TextEncoder().encode(json)).pipe(
      Effect.mapError((cause) => new EditaiiConnectionError({ reason: "storage", cause })),
      Effect.tapError(() => publish("storage")),
    );
    stored = next;
    yield* publish();
  });
  const assertReadable = Effect.fn("EditaiiConnection.assertReadable")(function* () {
    if (readFailure) return yield* readFailure;
  });
  const request = Effect.fn("EditaiiConnection.request")(
    function* (record: Redeeming, operation: "redeem" | "activate") {
      if (record.origin === null)
        return yield* new EditaiiConnectionError({ reason: "configuration" });
      const credentialHash = NodeCrypto.createHash("sha256")
        .update(record.credential)
        .digest("hex");
      const req = HttpClientRequest.post(
        `${record.origin}/api/maquina/${operation === "redeem" ? "parear/resgatar" : "ativar"}`,
      ).pipe(
        HttpClientRequest.setHeaders({
          "CF-Access-Client-Id": record.client_id,
          "CF-Access-Client-Secret": record.client_secret,
        }),
        HttpClientRequest.bodyJsonUnsafe(
          operation === "redeem"
            ? { codigo: record.code, verificador: record.verifier, credencial_hash: credentialHash }
            : {},
        ),
      );
      const response = yield* HttpClient.withScope(http)
        .execute(
          operation === "activate"
            ? HttpClientRequest.setHeader(req, "Editaii-Credencial", record.credential)
            : req,
        )
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.mapError((cause) => new EditaiiConnectionError({ reason: "network", cause })),
        );
      if (
        (response.status >= 300 && response.status < 400) ||
        response.status === 401 ||
        response.status === 403
      )
        return yield* new EditaiiConnectionError({ reason: "authentication" });
      if (response.status === 409) return yield* new EditaiiConnectionError({ reason: "conflict" });
      if (response.status >= 500) return yield* new EditaiiConnectionError({ reason: "network" });
      if (
        response.status === 200 &&
        response.headers["content-type"]?.toLowerCase().startsWith("text/html")
      )
        return yield* new EditaiiConnectionError({ reason: "authentication" });
      if (
        response.status !== 200 ||
        !response.headers["content-type"]?.toLowerCase().startsWith("application/json")
      )
        return yield* new EditaiiConnectionError({ reason: "protocol" });
      const text = yield* response.text.pipe(
        Effect.mapError((cause) => new EditaiiConnectionError({ reason: "network", cause })),
      );
      const json = yield* decodeJson(text).pipe(
        Effect.mapError((cause) => new EditaiiConnectionError({ reason: "protocol", cause })),
      );
      const machine = yield* decodeMachine(json).pipe(
        Effect.mapError((cause) => new EditaiiConnectionError({ reason: "protocol", cause })),
      );
      if (
        machine.ambiente_t3 !== environmentId ||
        machine.revogada_em !== null ||
        (operation === "activate" && machine.ativada_em === null)
      )
        return yield* new EditaiiConnectionError({ reason: "protocol" });
      return machine;
    },
    Effect.scoped,
    Effect.timeout("20 seconds"),
    Effect.catchTags({
      TimeoutError: (cause) =>
        Effect.fail(new EditaiiConnectionError({ reason: "network", cause })),
    }),
    Effect.withTracerEnabled(false),
  );

  const redeem = Effect.fn("EditaiiConnection.redeem")(function* (record: Redeeming) {
    const machine = yield* request(record, "redeem").pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          error.reason === "authentication" || error.reason === "conflict"
            ? request(record, "activate")
            : Effect.fail(error),
        onSuccess: () => request(record, "activate"),
      }),
    );
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        if (session?.attempt !== record.attempt) return;
        yield* save({
          version: 1,
          phase: "connected",
          origin: record.origin,
          environmentId,
          client_id: record.client_id,
          client_secret: record.client_secret,
          credential: record.credential,
          machine,
        });
      }),
    );
  });
  const runRedemption = Effect.fn("EditaiiConnection.runRedemption")(function* (
    record: Redeeming,
    scope: Scope.Closeable,
  ) {
    yield* redeem(record).pipe(
      Effect.tapError((error) =>
        writes.withPermits(1)(
          Effect.gen(function* () {
            if (session?.attempt === record.attempt) yield* publish(error.reason);
          }),
        ),
      ),
      Effect.retry({
        while: (error) => error.reason === "network",
        schedule: Schedule.spaced("5 seconds"),
      }),
      Effect.catchTags({ EditaiiConnectionError: () => Effect.void }),
      Effect.forkIn(scope),
    );
  });
  const openBrowser = Effect.fn("EditaiiConnection.openBrowser")(function* (record: Pairing) {
    if (record.origin === null)
      return yield* new EditaiiConnectionError({ reason: "configuration" });
    if (platform === "linux" && !processEnv.DISPLAY?.trim() && !processEnv.WAYLAND_DISPLAY?.trim())
      return yield* new EditaiiConnectionError({ reason: "browser" });
    if (platform === "darwin") {
      const console = yield* files
        .stat("/dev/console")
        .pipe(Effect.mapError((cause) => new EditaiiConnectionError({ reason: "browser", cause })));
      if (userId === undefined || userId === 0 || Option.getOrUndefined(console.uid) !== userId)
        return yield* new EditaiiConnectionError({ reason: "browser" });
    }
    if (platform === "win32") {
      const result = yield* runner
        .run({
          command: "powershell.exe",
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[System.Diagnostics.Process]::GetCurrentProcess().SessionId",
          ],
          timeout: "5 seconds",
        })
        .pipe(Effect.mapError((cause) => new EditaiiConnectionError({ reason: "browser", cause })));
      if (
        result.code !== 0 ||
        !/^\d+$/.test(result.stdout.trim()) ||
        Number(result.stdout.trim()) === 0
      )
        return yield* new EditaiiConnectionError({ reason: "browser" });
    }
    const url = new URL("/configuracoes/parear", record.origin);
    url.search = new URLSearchParams({
      tentativa: record.attempt,
      state: record.state,
      desafio: NodeCrypto.createHash("sha256").update(record.verifier).digest("base64url"),
      callback: `http://127.0.0.1:${record.port}/editaii/parear`,
      nome: record.machineName,
      ambiente_t3: environmentId,
    }).toString();
    yield* launcher
      .launchBrowser(url.href)
      .pipe(Effect.mapError((cause) => new EditaiiConnectionError({ reason: "browser", cause })));
  }, Effect.withTracerEnabled(false));

  const listener = Effect.fn("EditaiiConnection.listener")(function* (
    attempt: string,
    scope: Scope.Closeable,
  ) {
    const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
      host: "127.0.0.1",
      port: 0,
      gracefulShutdownTimeout: "1 second",
    }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError((cause) => new EditaiiConnectionError({ reason: "listener", cause })),
    );
    if (server.address._tag === "UnixPathAddress")
      return yield* new EditaiiConnectionError({ reason: "listener" });
    const handle = Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      if (req.method !== "POST" || req.url !== "/editaii/parear")
        return HttpServerResponse.text("Not found", { status: 404 });
      if (req.headers.origin !== stored.origin)
        return HttpServerResponse.text("Invalid origin", { status: 403 });
      if (
        req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
        "application/x-www-form-urlencoded"
      )
        return HttpServerResponse.text("Invalid form", { status: 415 });
      // The platform destroys oversized body streams; reject known lengths while a response is still writable.
      if (Number(req.headers["content-length"]) > MAX_CALLBACK_BYTES)
        return HttpServerResponse.text("Form too large", { status: 413 });
      const body = yield* req.text.pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_CALLBACK_BYTES)),
        Effect.timeout("5 seconds"),
        Effect.option,
      );
      if (Option.isNone(body)) return HttpServerResponse.text("Invalid form", { status: 400 });
      const fields = new URLSearchParams(body.value);
      const keys = [...fields.keys()].sort().join(",");
      const code = fields.get("codigo");
      const state = fields.get("state");
      const clientId = fields.get("client_id");
      const clientSecret = fields.get("client_secret");
      if (
        keys !== "client_id,client_secret,codigo,state" ||
        !code ||
        !/^[A-Za-z0-9_-]{43}$/.test(code) ||
        !clientId ||
        !/^\S+\.access$/.test(clientId) ||
        !clientSecret
      )
        return HttpServerResponse.text("Invalid form", { status: 400 });
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          if (session?.attempt !== attempt || stored.phase !== "pairing")
            return HttpServerResponse.text("Pairing is no longer active", { status: 410 });
          if (state !== stored.state)
            return HttpServerResponse.text("Invalid state", { status: 403 });
          if (stored.expiresAt <= (yield* clock.currentTimeMillis))
            return HttpServerResponse.text("Pairing expired", { status: 410 });
          const record: Redeeming = {
            ...stored,
            phase: "redeeming",
            code,
            client_id: clientId,
            client_secret: clientSecret,
          };
          yield* save(record);
          yield* runRedemption(record, session.scope);
          return HttpServerResponse.setHeader(
            HttpServerResponse.html(
              "<!doctype html><title>Editaii</title><p>Pairing received. You can return to T3.</p>",
            ),
            "cache-control",
            "no-store",
          );
        }),
      );
    }).pipe(
      Effect.catchTags({
        EditaiiConnectionError: (error) =>
          publish(error.reason).pipe(
            Effect.as(
              HttpServerResponse.text("Could not save pairing. Return to T3 and try again.", {
                status: 503,
              }),
            ),
          ),
      }),
      Effect.withTracerEnabled(false),
    );
    yield* server.serve(handle).pipe(Effect.provideService(Scope.Scope, scope));
    return server.address.port;
  });

  const initialize = Effect.gen(function* () {
    const raw = yield* secrets
      .get(SECRET_NAME)
      .pipe(Effect.mapError((cause) => new EditaiiConnectionError({ reason: "storage", cause })));
    if (Option.isSome(raw))
      stored = yield* decodeRecord(new TextDecoder().decode(raw.value)).pipe(
        Effect.mapError((cause) => new EditaiiConnectionError({ reason: "storage", cause })),
      );
    if (stored.environmentId !== environmentId)
      return yield* new EditaiiConnectionError({ reason: "configuration" });
    if (stored.phase === "pairing") {
      yield* publish("interrupted");
      return;
    }
    yield* publish();
    if (stored.phase === "redeeming") {
      const scope = yield* Scope.make();
      session = { scope, attempt: stored.attempt };
      yield* runRedemption(stored, scope);
    }
  }).pipe(
    Effect.catchTags({
      EditaiiConnectionError: (error) => {
        readFailure = error;
        return publish(error.reason);
      },
    }),
    Effect.ensuring(Deferred.succeed(ready, undefined)),
  );
  yield* forkParked(initialize);
  yield* Effect.addFinalizer(() => (session ? Scope.close(session.scope, Exit.void) : Effect.void));

  const configure = Effect.fn("EditaiiConnection.configure")(function* ({
    origin,
  }: {
    readonly origin: string;
  }) {
    yield* Deferred.await(ready);
    yield* assertReadable();
    if (stored.phase !== "disconnected")
      return yield* new EditaiiConnectionError({ reason: "configuration" });
    const parsed = yield* Effect.try({
      try: () => new URL(origin.trim()),
      catch: () => new EditaiiConnectionError({ reason: "configuration" }),
    });
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    )
      return yield* new EditaiiConnectionError({ reason: "configuration" });
    yield* save({ version: 1, phase: "disconnected", origin: parsed.origin, environmentId });
  }, commands.withPermits(1));

  const startPairing = Effect.fn("EditaiiConnection.startPairing")(function* ({
    machineName,
  }: {
    readonly machineName: string;
  }) {
    yield* Deferred.await(ready);
    yield* assertReadable();
    if (
      stored.phase !== "disconnected" ||
      stored.origin === null ||
      !/^.{1,80}$/u.test(machineName.trim())
    )
      return yield* new EditaiiConnectionError({ reason: "configuration" });
    const scope = yield* Scope.make();
    const attempt = NodeCrypto.randomBytes(32).toString("base64url");
    session = { scope, attempt };
    const listenerScope = yield* Scope.make();
    yield* Scope.addFinalizer(scope, Scope.close(listenerScope, Exit.void));
    const port = yield* listener(attempt, listenerScope).pipe(
      Effect.tapError(() => Scope.close(scope, Exit.void)),
    );
    const record: Pairing = {
      version: 1,
      phase: "pairing",
      origin: stored.origin,
      environmentId,
      attempt,
      state: NodeCrypto.randomBytes(32).toString("base64url"),
      verifier: NodeCrypto.randomBytes(32).toString("base64url"),
      credential: NodeCrypto.randomBytes(32).toString("base64url"),
      machineName: machineName.trim(),
      port,
      expiresAt: (yield* clock.currentTimeMillis) + PAIRING_LIFETIME,
    };
    yield* writes
      .withPermits(1)(save(record))
      .pipe(Effect.tapError(() => Scope.close(scope, Exit.void)));
    yield* Effect.sleep("10 minutes").pipe(
      Effect.andThen(
        writes.withPermits(1)(
          Effect.gen(function* () {
            if (session?.attempt === attempt && stored.phase === "pairing")
              yield* publish("expired");
          }),
        ),
      ),
      Effect.andThen(Scope.close(listenerScope, Exit.void)),
      Effect.forkIn(scope),
    );
    yield* openBrowser(record).pipe(Effect.tapError((error) => publish(error.reason)));
  }, commands.withPermits(1));

  const reopenBrowser = Effect.fn("EditaiiConnection.reopenBrowser")(function* () {
    yield* Deferred.await(ready);
    yield* assertReadable();
    if (
      stored.phase !== "pairing" ||
      session === undefined ||
      stored.expiresAt <= (yield* clock.currentTimeMillis)
    )
      return yield* new EditaiiConnectionError({ reason: "expired" });
    yield* openBrowser(stored).pipe(Effect.tapError((error) => publish(error.reason)));
    yield* publish();
  }, commands.withPermits(1));

  const disconnect = Effect.fn("EditaiiConnection.disconnect")(function* () {
    yield* Deferred.await(ready);
    yield* assertReadable();
    const previous = yield* writes.withPermits(1)(
      Effect.sync(() => {
        const current = session;
        session = undefined;
        return current;
      }),
    );
    if (previous) yield* Scope.close(previous.scope, Exit.void);
    yield* writes.withPermits(1)(
      save({ version: 1, phase: "disconnected", origin: stored.origin, environmentId }),
    );
  }, commands.withPermits(1));

  return EditaiiConnection.of({
    state: Deferred.await(ready).pipe(Effect.andThen(SubscriptionRef.get(view))),
    changes: Stream.unwrap(Deferred.await(ready).pipe(Effect.as(SubscriptionRef.changes(view)))),
    configure,
    startPairing,
    reopenBrowser,
    disconnect,
  });
});

export const layer = Layer.effect(EditaiiConnection, make);
