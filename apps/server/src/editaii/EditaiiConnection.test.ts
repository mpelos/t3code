// @effect-diagnostics nodeBuiltinImport:off -- Real loopback servers prove listener cleanup and Fetch redirect policy.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as EditaiiConnection from "./EditaiiConnection.ts";
import type { EditaiiConnectionState } from "@t3tools/contracts";

const ORIGIN = "https://editaii.example";
const ENVIRONMENT = EnvironmentId.make("test-editaii-environment");
const decodeBody = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodePairing = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      phase: Schema.Literal("pairing"),
      origin: Schema.String,
      port: Schema.Number,
    }),
  ),
);
const decodeRedemption = Schema.decodeUnknownEffect(
  Schema.Struct({
    codigo: Schema.String,
    verificador: Schema.String,
    credencial_hash: Schema.String,
  }),
);
const MACHINE = {
  id: "machine",
  nome: "Office",
  dono: "person@example.com",
  ambiente_t3: ENVIRONMENT,
  emitida_em: "2026-11-01T00:00:00.000Z",
  ativada_em: "2026-11-01T00:00:00.000Z",
  revogada_em: null,
};

const harness = Effect.fn("test.EditaiiConnection.harness")(function* (
  options: {
    initial?: Uint8Array;
    unreadable?: boolean;
    headless?: boolean;
    httpClient?: HttpClient.HttpClient;
    reply?: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<Response>;
  } = {},
) {
  let saved = options.initial;
  let failSave = false;
  let pausedSave:
    | {
        arrived: Deferred.Deferred<Uint8Array>;
        resume: Deferred.Deferred<void>;
        afterCommit: boolean;
      }
    | undefined;
  const failRead = options.unreadable ?? false;
  const browser = yield* Deferred.make<URL>();
  const urls: URL[] = [];
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const signals: AbortSignal[] = [];
  const clock = yield* Clock.Clock;
  let wallOffset = 0;
  const store = ServerSecretStore.ServerSecretStore.of({
    get: () =>
      failRead
        ? Effect.fail(
            new ServerSecretStore.SecretStoreReadError({
              resource: "test",
              cause: new Error("unreadable"),
            }),
          )
        : Effect.succeed(Option.fromUndefinedOr(saved)),
    set: (_name, bytes) =>
      Effect.gen(function* () {
        if (failSave)
          return yield* new ServerSecretStore.SecretStorePersistError({
            resource: "test",
            cause: new Error("unwritable"),
          });
        const paused = pausedSave;
        pausedSave = undefined;
        if (paused?.afterCommit) saved = bytes;
        if (paused) {
          yield* Deferred.succeed(paused.arrived, bytes);
          yield* Deferred.await(paused.resume);
        }
        saved = bytes;
      }),
    create: () => Effect.die("unused create"),
    getOrCreateRandom: () => Effect.die("unused random"),
    remove: () =>
      Effect.sync(() => {
        saved = undefined;
      }),
  });
  const deps = Layer.mergeAll(
    Layer.succeed(Clock.Clock, {
      ...clock,
      currentTimeMillis: clock.currentTimeMillis.pipe(Effect.map((value) => value + wallOffset)),
    }),
    Layer.succeed(HostProcess.Platform, "linux"),
    Layer.succeed(HostProcess.Environment, options.headless ? {} : { DISPLAY: ":test" }),
    Layer.succeed(ProcessRunner.ProcessRunner, { run: () => Effect.die("unused platform probe") }),
    Layer.succeed(ServerSecretStore.ServerSecretStore, store),
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(ENVIRONMENT),
      getDescriptor: Effect.die("unused descriptor"),
    }),
    Layer.succeed(ExternalLauncher.ExternalLauncher, {
      resolveAvailableEditors: () => Effect.succeed([]),
      resolveFileManagerRevealKind: () => Effect.succeed("finder"),
      launchEditor: () => Effect.void,
      launchBrowser: (url) =>
        Effect.gen(function* () {
          const parsed = new URL(url);
          urls.push(parsed);
          yield* Deferred.succeed(browser, parsed);
        }),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      options.httpClient ??
        HttpClient.make((request, _url, signal) =>
          Effect.gen(function* () {
            requests.push(request);
            signals.push(signal);
            const response = options.reply
              ? yield* options.reply(request)
              : Response.json({
                  ...MACHINE,
                  ativada_em: request.url.endsWith("/ativar") ? MACHINE.ativada_em : null,
                });
            return HttpClientResponse.fromWeb(request, response);
          }),
        ),
    ),
  );
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const context = yield* Layer.build(EditaiiConnection.layer.pipe(Layer.provide(deps))).pipe(
    Effect.provideService(Scope.Scope, scope),
  );
  const connection = yield* EditaiiConnection.EditaiiConnection.pipe(
    Effect.provideContext(context),
  );
  yield* connection.state;
  return {
    connection,
    requests,
    signals,
    urls,
    saved: () => saved,
    pauseNextSave: (afterCommit: boolean) =>
      Effect.gen(function* () {
        const arrived = yield* Deferred.make<Uint8Array>();
        const resume = yield* Deferred.make<void>();
        pausedSave = { arrived, resume, afterCommit };
        return { arrived, resume };
      }),
    jumpWallClock: () => {
      wallOffset = 10 * 60 * 1000;
    },
    failSave: () => {
      failSave = true;
    },
    restart: () =>
      Effect.gen(function* () {
        yield* Scope.close(scope, Exit.void);
        return yield* harness({ ...options, ...(saved ? { initial: saved } : {}) });
      }),
    begin: () =>
      Effect.gen(function* () {
        yield* connection.configure({ origin: ORIGIN });
        yield* connection.startPairing({ machineName: "Office" });
        return yield* Deferred.await(browser);
      }),
  };
});

const loopback = Effect.fn("test.EditaiiConnection.loopback")(function* (
  handle: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest
  >,
) {
  const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
    host: "127.0.0.1",
    port: 0,
  });
  if (server.address._tag === "UnixPathAddress")
    return yield* Effect.die("Expected a TCP listener");
  yield* server.serve(handle);
  return `http://127.0.0.1:${server.address.port}`;
});

const waitFor = (
  connection: EditaiiConnection.EditaiiConnection["Service"],
  predicate: (state: EditaiiConnectionState) => boolean,
) => Stream.runHead(connection.changes.pipe(Stream.filter(predicate)));

const callback = Effect.fn("test.EditaiiConnection.callback")(function* (
  url: URL,
  input: {
    origin?: string | null;
    state?: string;
    method?: "GET" | "POST" | "PUT";
    contentType?: string;
    path?: string;
    omit?: string;
    fields?: Record<string, string>;
    duplicate?: string;
    host?: string;
  } = {},
) {
  const target = url.searchParams.get("callback");
  if (!target) return yield* Effect.die("missing callback");
  const endpoint = new URL(target);
  if (input.host) endpoint.hostname = input.host;
  const fields = new URLSearchParams({
    codigo: "c".repeat(43),
    state: input.state ?? url.searchParams.get("state") ?? "",
    client_id: "machines.access",
    client_secret: "test-secret",
  });
  if (input.omit) fields.delete(input.omit);
  for (const [key, value] of Object.entries(input.fields ?? {})) fields.set(key, value);
  if (input.duplicate) fields.append(input.duplicate, "duplicate");
  const req = HttpClientRequest.make(input.method ?? "POST")(`${endpoint}${input.path ?? ""}`);
  const body =
    input.method === "GET"
      ? req
      : HttpClientRequest.bodyText(
          req,
          fields.toString(),
          input.contentType ?? "application/x-www-form-urlencoded",
        );
  const response = yield* HttpClient.execute(
    input.origin === null
      ? body
      : HttpClientRequest.setHeader(body, "Origin", input.origin ?? ORIGIN),
  ).pipe(Effect.provide(FetchHttpClient.layer));
  const text = yield* response.text;
  return { status: response.status, text };
});

it.layer(NodeServices.layer)("Editaii connection", (it) => {
  it.effect("cancellation after a configuration write still publishes the committed origin", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const paused = yield* h.pauseNextSave(true);
      const configuring = yield* h.connection.configure({ origin: ORIGIN }).pipe(Effect.forkChild);
      yield* Deferred.await(paused.arrived);
      const cancellation = yield* Fiber.interrupt(configuring).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(paused.resume, undefined);
      yield* Fiber.join(cancellation);
      expect(Exit.hasInterrupts(yield* Fiber.await(configuring))).toBe(true);
      expect(yield* decodeBody(new TextDecoder().decode(h.saved()))).toMatchObject({
        phase: "disconnected",
        origin: ORIGIN,
      });
      expect(yield* h.connection.state).toMatchObject({ status: "disconnected", origin: ORIGIN });
    }),
  );
  it.effect.each([false, true])(
    "cancellation during persistence closes the listener and preserves a coherent interrupted record (committed: %s)",
    (afterCommit) =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.connection.configure({ origin: ORIGIN });
        const paused = yield* h.pauseNextSave(afterCommit);
        const starting = yield* h.connection
          .startPairing({ machineName: "Office" })
          .pipe(Effect.forkChild);
        const bytes = yield* Deferred.await(paused.arrived);
        const record = yield* decodePairing(new TextDecoder().decode(bytes));
        const cancellation = yield* Fiber.interrupt(starting).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(paused.resume, undefined);
        yield* Fiber.join(cancellation);
        expect(Exit.hasInterrupts(yield* Fiber.await(starting))).toBe(true);
        const request = yield* HttpClient.get(
          `http://127.0.0.1:${record.port}/editaii/parear`,
        ).pipe(Effect.provide(FetchHttpClient.layer), Effect.result);
        expect(request._tag).toBe("Failure");
        expect(yield* h.connection.state).toMatchObject({
          status: "error",
          problem: "interrupted",
          origin: record.origin,
          canReopen: false,
        });
        expect(yield* decodePairing(new TextDecoder().decode(h.saved()))).toEqual(record);
        expect(h.urls).toHaveLength(0);
        yield* h.connection.disconnect();
        const second = yield* h.begin();
        yield* h.connection.disconnect();
        expect((yield* callback(second).pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* h.connection.state).toMatchObject({
          status: "disconnected",
          canReopen: false,
        });
      }),
  );

  it.effect.each(["redeem", "activate"] as const)(
    "Fetch never forwards %s credentials to a redirect destination",
    (operation) =>
      Effect.gen(function* () {
        const received: string[] = [];
        const target = yield* loopback(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            received.push(request.url);
            return HttpServerResponse.jsonUnsafe(MACHINE);
          }),
        );
        const sent: { secret: string | undefined; credential: string | undefined }[] = [];
        const source = yield* loopback(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            sent.push({
              secret: request.headers["cf-access-client-secret"],
              credential: request.headers["editaii-credencial"],
            });
            if (operation === "activate" && request.url.endsWith("resgatar"))
              return HttpServerResponse.jsonUnsafe(MACHINE);
            return HttpServerResponse.empty({
              status: 302,
              headers: { location: `${target}/stolen` },
            });
          }),
        );
        const fetch = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
        // Production still requires HTTPS; this transport maps its origin to the real loopback fixture.
        const client = HttpClient.mapRequest(fetch, (request) =>
          HttpClientRequest.setUrl(request, request.url.replace(ORIGIN, source)),
        );
        const h = yield* harness({ httpClient: client });
        yield* callback(yield* h.begin());
        yield* waitFor(
          h.connection,
          (state) => state.status === "error" || state.status === "connected",
        );
        expect(received).toEqual([]);
        expect((yield* h.connection.state).problem).toBe("authentication");
        expect(sent.length).toBeGreaterThan(0);
        expect(sent.every((request) => request.secret === "test-secret")).toBe(true);
        if (operation === "activate") expect(sent.at(-1)?.credential).toMatch(/^[\w-]{43}$/);
      }),
  );
  it.effect("binds only the exact loopback address in the pairing URL", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const url = yield* h.begin();
      const outcome = yield* callback(url, { host: "[::1]" }).pipe(Effect.result);
      expect(outcome._tag).toBe("Failure");
      expect(h.requests).toHaveLength(0);
    }),
  );
  it.effect(
    "invalid callbacks do not consume the attempt; only the exact callback can connect",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const url = yield* h.begin();
        expect(url.origin).toBe(ORIGIN);
        expect(url.searchParams.get("ambiente_t3")).toBe(ENVIRONMENT);
        expect(url.searchParams.get("desafio")).toMatch(/^[\w-]{43}$/);
        expect(url.searchParams.has("verificador")).toBe(false);
        for (const bad of [
          { origin: "https://elsewhere.example" },
          { origin: "null" },
          { origin: null },
          { state: "wrong" },
          { method: "GET" as const },
          { method: "PUT" as const },
          { path: "/wrong" },
          { contentType: "text/plain" },
          { omit: "codigo" },
          { omit: "client_secret" },
          { fields: { codigo: "bad" } },
          { fields: { client_id: "invalid" } },
          { fields: { client_secret: "" } },
          { fields: { extra: "unexpected" } },
          { duplicate: "state" },
          { fields: { client_secret: "x".repeat(9000) } },
        ]) {
          expect((yield* callback(url, bad)).status).toBeGreaterThanOrEqual(400);
          expect(h.requests).toHaveLength(0);
        }
        expect((yield* callback(url)).status).toBe(200);
        yield* waitFor(h.connection, (s) => s.status === "connected");
        expect(h.requests.map((r) => r.url)).toEqual([
          `${ORIGIN}/api/maquina/parear/resgatar`,
          `${ORIGIN}/api/maquina/ativar`,
        ]);
        for (const req of h.requests) {
          expect(req.method).toBe("POST");
          expect(req.headers["content-type"]).toBe("application/json");
          expect(req.headers["cf-access-client-secret"]).toBe("test-secret");
        }
        expect(h.requests[1]?.headers["editaii-credencial"]).toMatch(/^[\w-]{43}$/);
        const bodies = yield* Effect.forEach(h.requests, (request) => {
          if (request.body._tag !== "Uint8Array") throw new Error("Expected a JSON request");
          return decodeBody(new TextDecoder().decode(request.body.body));
        });
        const redemption = yield* decodeRedemption(bodies[0]);
        const digest = (value: string) =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
        const challenge = Buffer.from(
          yield* Effect.promise(() => digest(redemption.verificador)),
        ).toString("base64url");
        expect(challenge).toBe(url.searchParams.get("desafio"));
        const credentialHash = Buffer.from(
          yield* Effect.promise(() => digest(h.requests[1]?.headers["editaii-credencial"] ?? "")),
        ).toString("hex");
        expect(redemption).toEqual({
          codigo: "c".repeat(43),
          verificador: redemption.verificador,
          credencial_hash: credentialHash,
        });
        expect(bodies[1]).toEqual({});
        expect(h.signals.every((signal) => signal.aborted)).toBe(true);
        expect((yield* callback(url)).status).toBe(410);
        const state = yield* h.connection.state;
        expect(JSON.stringify(state)).not.toContain("test-secret");
        expect(new TextDecoder().decode(h.saved())).not.toContain('"verifier"');
      }),
  );

  it.effect(
    "a callback is acknowledged only after saving it; persistence failure does not redeem",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const url = yield* h.begin();
        h.failSave();
        expect((yield* callback(url)).status).toBe(503);
        expect(h.requests).toHaveLength(0);
        expect((yield* h.connection.state).problem).toBe("storage");
      }),
  );

  it.effect("does not open the browser until the attempt is saved", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.connection.configure({ origin: ORIGIN });
      h.failSave();
      expect(
        (yield* h.connection.startPairing({ machineName: "Office" }).pipe(Effect.flip)).reason,
      ).toBe("storage");
      expect(h.urls).toHaveLength(0);
      expect(h.requests).toHaveLength(0);
    }),
  );

  it.effect("reports a missing graphical session without losing the saved attempt", () =>
    Effect.gen(function* () {
      const h = yield* harness({ headless: true });
      yield* h.connection.configure({ origin: ORIGIN });
      expect(
        (yield* h.connection.startPairing({ machineName: "Office" }).pipe(Effect.flip)).reason,
      ).toBe("browser");
      expect((yield* h.connection.state).canReopen).toBe(true);
      expect(h.urls).toHaveLength(0);
    }),
  );

  it.effect("unreadable credentials are an error, never an empty connection", () =>
    Effect.gen(function* () {
      const h = yield* harness({ unreadable: true });
      expect((yield* h.connection.state).status).toBe("error");
      expect((yield* h.connection.configure({ origin: ORIGIN }).pipe(Effect.flip)).reason).toBe(
        "storage",
      );
      expect(h.urls).toHaveLength(0);
    }),
  );

  it.effect("rejects credentials from another environment and never sends them", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        initial: new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            phase: "disconnected",
            origin: ORIGIN,
            environmentId: "another-environment",
          }),
        ),
      });
      expect((yield* h.connection.state).problem).toBe("configuration");
      expect(h.requests).toHaveLength(0);
    }),
  );

  it.effect("requires an HTTPS origin and only configures while disconnected", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      for (const origin of [
        "http://editaii.example",
        "https://user:password@editaii.example",
        "https://editaii.example/path",
        "https://editaii.example?query",
      ]) {
        expect((yield* h.connection.configure({ origin }).pipe(Effect.flip)).reason).toBe(
          "configuration",
        );
      }
      yield* h.begin();
      expect(
        (yield* h.connection.configure({ origin: "https://another.example" }).pipe(Effect.flip))
          .reason,
      ).toBe("configuration");
    }),
  );

  it.effect("refuses Access login HTML and malformed success responses", () =>
    Effect.gen(function* () {
      for (const [response, reason] of [
        [new Response("login", { headers: { "content-type": "text/html" } }), "authentication"],
        [Response.json({ unexpected: true }), "protocol"],
        [new Response("{broken", { headers: { "content-type": "application/json" } }), "protocol"],
      ] as const) {
        const h = yield* harness({ reply: () => Effect.succeed(response.clone()) });
        const url = yield* h.begin();
        yield* callback(url);
        yield* waitFor(h.connection, (s) => s.status === "error");
        expect((yield* h.connection.state).problem).toBe(reason);
      }
    }),
  );

  it.effect("a restart interrupts an attempt that was still waiting for its callback", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.begin();
      const restarted = yield* h.restart();
      expect((yield* restarted.connection.state).problem).toBe("interrupted");
      expect(restarted.urls).toHaveLength(0);
      yield* restarted.connection.disconnect();
      expect((yield* restarted.connection.state).status).toBe("disconnected");
    }),
  );

  it.effect(
    "times out a stalled response body and cancels its request without discarding recovery",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const h = yield* harness({
          reply: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.as(
                new Response(new ReadableStream(), {
                  headers: { "content-type": "application/json" },
                }),
              ),
            ),
        });
        yield* callback(yield* h.begin());
        yield* Deferred.await(started);
        yield* TestClock.adjust("20 seconds");
        yield* waitFor(h.connection, (state) => state.problem === "network");
        expect(h.signals.every((signal) => signal.aborted)).toBe(true);
        expect(new TextDecoder().decode(h.saved())).toContain('"phase":"redeeming"');
      }),
  );

  it.effect(
    "resumes a saved redemption after a lost activation response without pairing again",
    () =>
      Effect.gen(function* () {
        const activated = yield* Deferred.make<void>();
        let first = true;
        const h = yield* harness({
          reply: (request) =>
            Effect.gen(function* () {
              if (request.url.endsWith("/ativar") && first) {
                first = false;
                yield* Deferred.succeed(activated, undefined);
                return yield* Effect.never;
              }
              return Response.json(MACHINE);
            }),
        });
        const url = yield* h.begin();
        yield* callback(url);
        yield* Deferred.await(activated);
        const restarting = yield* h.restart();
        yield* waitFor(restarting.connection, (s) => s.status === "connected");
        expect(restarting.urls).toHaveLength(0);
        expect(restarting.requests).toHaveLength(2);
      }),
  );

  it.effect.each([403, 409])(
    "a definitive redemption refusal (%s) never tries activation",
    (status) =>
      Effect.gen(function* () {
        const h = yield* harness({
          reply: (request) =>
            Effect.succeed(
              request.url.endsWith("resgatar")
                ? Response.json({ erro: "recusado" }, { status })
                : Response.json(MACHINE),
            ),
        });
        const url = yield* h.begin();
        yield* callback(url);
        yield* waitFor(h.connection, (s) => s.status === "connected" || s.status === "error");
        expect(h.requests).toHaveLength(1);
        expect((yield* h.connection.state).problem).toBe(
          status === 403 ? "authentication" : "conflict",
        );
      }),
  );

  it.effect("disconnect waits for in-flight redemption to end and cannot be undone by it", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const ended = yield* Deferred.make<void>();
      const h = yield* harness({
        reply: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(ended, undefined)),
          ),
      });
      const url = yield* h.begin();
      yield* callback(url);
      yield* Deferred.await(started);
      yield* h.connection.disconnect();
      yield* Deferred.await(ended);
      expect((yield* h.connection.state).status).toBe("disconnected");
      expect(new TextDecoder().decode(h.saved())).not.toContain("test-secret");
    }),
  );

  it.effect("cancellation while the listener is binding leaves no listener behind", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.connection.configure({ origin: ORIGIN });
      const bind = NodeHttp.Server.prototype.listen;
      const bound: { server: NodeHttp.Server; reported: Promise<void> }[] = [];
      let starting: Fiber.Fiber<void, unknown> | undefined;
      // The cancellation lands in the same tick as listen(), before Node reports the bind.
      const spy = vi.spyOn(NodeHttp.Server.prototype, "listen").mockImplementation(function (
        this: NodeHttp.Server,
        ...args: Parameters<NodeHttp.Server["listen"]>
      ) {
        const server = bind.apply(this, args);
        // Node always reports a bind it completes, even one nobody waits for any more.
        bound.push({
          server: this,
          reported: new Promise((resolve) => this.once("listening", () => resolve())),
        });
        starting?.interruptUnsafe();
        return server;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      starting = yield* h.connection.startPairing({ machineName: "Office" }).pipe(Effect.forkChild);
      expect(Exit.hasInterrupts(yield* Fiber.await(starting))).toBe(true);
      const [attempt] = bound;
      if (!attempt) return yield* Effect.die("the listener never started binding");
      yield* Effect.promise(() => attempt.reported);
      expect(bound).toHaveLength(1);
      expect(attempt.server.listening).toBe(false);
      expect(yield* h.connection.state).toMatchObject({ status: "disconnected", canReopen: false });
      expect(h.urls).toHaveLength(0);
    }),
  );

  it.effect("a cancelled disconnect still completes, so no closed attempt looks usable", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const url = yield* h.begin();
      // Runs until the listener is closing, then is cancelled there.
      const disconnecting = yield* h.connection
        .disconnect()
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(disconnecting);
      expect(yield* h.connection.state).toMatchObject({ status: "disconnected", canReopen: false });
      expect(yield* decodeBody(new TextDecoder().decode(h.saved()))).toMatchObject({
        phase: "disconnected",
      });
      expect((yield* callback(url).pipe(Effect.result))._tag).toBe("Failure");
    }),
  );

  it.effect("refuses an expired callback even before the listener timer has run", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const url = yield* h.begin();
      h.jumpWallClock();
      expect((yield* callback(url)).status).toBe(410);
      expect(h.requests).toHaveLength(0);
    }),
  );

  it.effect("expires the listener after ten minutes and reopens only the same live attempt", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const url = yield* h.begin();
      yield* h.connection.reopenBrowser();
      expect(h.urls.map(String)).toEqual([String(url), String(url)]);
      yield* TestClock.adjust("10 minutes");
      expect((yield* h.connection.state).problem).toBe("expired");
      const error = yield* h.connection.reopenBrowser().pipe(Effect.flip);
      expect(error.reason).toBe("expired");
      expect(h.requests).toHaveLength(0);
    }),
  );
});
