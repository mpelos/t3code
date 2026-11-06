import {
  SpeechError,
  AuthOrchestrationOperateScope,
  sessionGrantsScope,
  type EnvironmentId,
  type ServerSettings,
  type AuthSessionState,
  type NarrationInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import { Atom, AsyncResult } from "effect/reactivity";
import * as RemoteAuthorization from "../authorization/service.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Supervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand, createEnvironmentRpcCommand } from "./runtime.ts";

export function createNarrationContextAtom(input: {
  readonly environmentIdAtom: Atom.Atom<EnvironmentId | null>;
  readonly configValueAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<{ readonly settings: Pick<ServerSettings, "speech"> } | null>;
  readonly sessionStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<AuthSessionState, unknown>>;
}) {
  return Atom.make((get) => {
    const environmentId = get(input.environmentIdAtom);
    const config = environmentId === null ? null : get(input.configValueAtom(environmentId));
    const result = environmentId === null ? null : get(input.sessionStateAtom(environmentId));
    const session = result === null ? null : AsyncResult.getOrElse(result, () => null);
    const next = {
      environmentId,
      narration: config?.settings.speech.narration ?? null,
      canOperate:
        result !== null &&
        !AsyncResult.isFailure(result) &&
        session !== null &&
        sessionGrantsScope(session, AuthOrchestrationOperateScope),
    };
    const previous = Option.getOrNull(get.self<typeof next>());
    return previous !== null &&
      previous.environmentId === next.environmentId &&
      previous.narration === next.narration &&
      previous.canOperate === next.canOperate
      ? previous
      : next;
  }).pipe(Atom.withLabel("speech:context"));
}

export class NarrationClient extends Context.Service<
  NarrationClient,
  {
    readonly narrate: (
      prepared: PreparedConnection,
      input: NarrationInput,
    ) => Effect.Effect<Uint8Array, RemoteEnvironmentRequestError>;
  }
>()("@t3tools/client-runtime/state/narration/NarrationClient") {}

export const layer = Layer.effect(
  NarrationClient,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteAuthorization.RemoteEnvironmentAuthorization,
    );
    return NarrationClient.of({
      narrate: Effect.fn("NarrationClient.narrate")(
        (prepared, input) =>
          executeAuthenticatedEnvironmentHttpRequest({
            prepared,
            signer,
            remoteAuthorization,
            group: "speech",
            method: "POST",
            timeoutMs: 120_000,
            url: (urls) => urls.narrate(),
            request: ({ client, headers }) => client.narrate({ payload: input, headers }),
          }),
        Effect.provideService(HttpClient.HttpClient, http),
      ),
    });
  }),
);

const untilAborted = (signal: AbortSignal) =>
  Effect.callback<never>((resume) => {
    const abort = () => resume(Effect.interrupt);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });

const withCancellation = <A, E, R>(signal: AbortSignal, effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() =>
    signal.aborted ? Effect.interrupt : effect.pipe(Effect.raceFirst(untilAborted(signal))),
  );

export function createNarrationEnvironmentCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | NarrationClient | R, E>,
) {
  const connected = Effect.gen(function* () {
    const supervisor = yield* Supervisor.EnvironmentSupervisor;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    if (Option.isNone(prepared)) return yield* new SpeechError({ reason: "unavailable" });
    return { prepared: prepared.value, client: yield* NarrationClient };
  });
  return {
    configure: createEnvironmentRpcCommand(runtime, {
      label: "speech:configure",
      tag: WS_METHODS.speechConfigure,
    }),
    narrate: createEnvironmentCommand(runtime, {
      label: "speech:narrate",
      execute: (input: NarrationInput & { readonly signal: AbortSignal }) =>
        withCancellation(
          input.signal,
          connected.pipe(
            Effect.flatMap(({ client, prepared }) =>
              client.narrate(prepared, { text: input.text }),
            ),
          ),
        ),
    }),
  };
}
