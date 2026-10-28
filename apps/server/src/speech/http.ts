import { AuthOrchestrationOperateScope, EnvironmentHttpApi, SpeechError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ByteSize from "effect/ByteSize";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  HttpEffect,
  HttpServerResponse,
  HttpRouter,
  HttpServerRequest,
  HttpIncomingMessage,
} from "effect/http";
import { failEnvironmentInternal, requireEnvironmentScope } from "../auth/http.ts";
import * as Speech from "./Speech.ts";

const speechResponse = <A, R>(
  effect: Effect.Effect<
    A,
    Speech.SpeechRequestError | SpeechError | import("@t3tools/contracts").ServerSettingsError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTags({
      SpeechRequestError: (error) => Effect.fail(new SpeechError({ reason: error.reason })),
      ServerSettingsError: () => failEnvironmentInternal("internal_error"),
    }),
    Effect.tap(() =>
      HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
      ),
    ),
  );

const layerHandlers = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "speech",
  Effect.fnUntraced(function* (handlers) {
    const speech = yield* Speech.Speech;
    return handlers
      .handle("transcribe", ({ payload, query }) =>
        requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(
          Effect.andThen(speechResponse(speech.transcribe(payload, query.format))),
        ),
      )
      .handle("narrate", ({ payload }) =>
        requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(
          Effect.andThen(speechResponse(speech.narrate(payload))),
        ),
      );
  }),
);

export const layer = Layer.merge(
  layerHandlers,
  HttpRouter.middleware(
    (effect) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        request.url.startsWith("/api/speech/")
          ? effect.pipe(
              Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(20)),
            )
          : effect,
      ),
    { global: true },
  ),
);
