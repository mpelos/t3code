import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { HttpEffect, HttpServerResponse } from "effect/http";
import { failEnvironmentInternal, requireEnvironmentScope } from "../auth/http.ts";
import * as Narration from "./Narration.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "speech",
  Effect.fnUntraced(function* (handlers) {
    const narration = yield* Narration.Narration;
    return handlers.handle("narrate", ({ payload }) =>
      requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(
        Effect.andThen(narration.narrate(payload)),
        Effect.catchTags({
          SpeechRequestError: (error) => Effect.fail(error.toClientError()),
          ServerSettingsError: () => failEnvironmentInternal("internal_error"),
        }),
        Effect.tap(() =>
          HttpEffect.appendPreResponseHandler((_request, response) =>
            Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
          ),
        ),
      ),
    );
  }),
);
