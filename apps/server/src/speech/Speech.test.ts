import { expect, it } from "@effect/vitest";
import type { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import { exportPKCS8, generateKeyPair, decodeJwt } from "jose";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as Speech from "./Speech.ts";

function testLayer(
  speech: ServerSettings["speech"],
  respond: (request: HttpClientRequest.HttpClientRequest) => Response,
) {
  return Speech.layer.pipe(
    Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest({ speech })),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => HttpClientResponse.fromWeb(request, respond(request))),
        ),
      ),
    ),
  );
}

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

function jsonBody(request: HttpClientRequest.HttpClientRequest): unknown {
  expect(request.body._tag).toBe("Uint8Array");
  if (request.body._tag !== "Uint8Array") throw new Error("Expected a JSON body");
  return decodeJson(new TextDecoder().decode(request.body.body));
}

it.effect("sends a Whisper recording with the configured language and returns the transcript", () =>
  Effect.gen(function* () {
    const layer = testLayer(
      {
        dictation: { provider: "openai", credential: "test-key", language: "pt-BR" },
        narration: null,
      },
      (request) => {
        expect(request.url).toBe("https://api.openai.com/v1/audio/transcriptions");
        expect(request.headers.authorization).toBe("Bearer test-key");
        expect(request.body._tag).toBe("FormData");
        if (request.body._tag !== "FormData") throw new Error("Expected form data");
        expect(request.body.formData.get("model")).toBe("whisper-1");
        expect(request.body.formData.get("language")).toBe("pt");
        const file = request.body.formData.get("file");
        expect(file).toBeInstanceOf(Blob);
        return Response.json({ text: "Olá, mundo." });
      },
    );
    const result = yield* Effect.gen(function* () {
      return yield* (yield* Speech.Speech).transcribe(new Uint8Array([1, 2]), "webm");
    }).pipe(Effect.provide(layer));
    expect(result.text).toBe("Olá, mundo.");
  }),
);

it.effect.each(["openai", "elevenlabs"] as const)(
  "synthesizes MP3 using %s credentials and voice",
  (provider) =>
    Effect.gen(function* () {
      const layer = testLayer(
        { dictation: null, narration: { provider, credential: "voice-key", voice: "voice-id" } },
        (request) => {
          expect(request.headers[provider === "openai" ? "authorization" : "xi-api-key"]).toBe(
            provider === "openai" ? "Bearer voice-key" : "voice-key",
          );
          expect(jsonBody(request)).toMatchObject(
            provider === "openai"
              ? { voice: "voice-id", input: "Hello" }
              : { inputs: [{ text: "Hello", voice_id: "voice-id" }], model_id: "eleven_v4" },
          );
          expect(request.url).toBe(
            provider === "openai"
              ? "https://api.openai.com/v1/audio/speech"
              : "https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_44100_128",
          );
          return new Response(new Uint8Array([73, 68, 51]), {
            headers: { "content-type": "audio/mpeg" },
          });
        },
      );
      const result = yield* Effect.gen(function* () {
        return yield* (yield* Speech.Speech).narrate({ text: "Hello" });
      }).pipe(Effect.provide(layer));
      expect(Array.from(result)).toEqual([73, 68, 51]);
    }),
);

it.effect(
  "authorizes Google with a service account and decodes recognition and synthesis responses",
  () =>
    Effect.gen(function* () {
      const keys = yield* Effect.promise(() => generateKeyPair("RS256", { extractable: true }));
      const privateKey = yield* Effect.promise(() => exportPKCS8(keys.privateKey));
      const credential = JSON.stringify({
        type: "service_account",
        project_id: "voice-project",
        client_email: "voice@example.com",
        private_key: privateKey,
      });
      const layer = testLayer(
        {
          dictation: { provider: "google", credential, language: "pt-BR" },
          narration: {
            provider: "google",
            credential,
            language: "pt-BR",
            voice: "pt-BR-Chirp3-HD-Aoede",
          },
        },
        (request) => {
          if (request.url === "https://oauth2.googleapis.com/token") {
            expect(request.body._tag).toBe("Uint8Array");
            if (request.body._tag !== "Uint8Array") throw new Error("Expected encoded form");
            const form = new URLSearchParams(new TextDecoder().decode(request.body.body));
            const assertion = form.get("assertion");
            if (!assertion) throw new Error("Missing assertion");
            expect(decodeJwt(assertion)).toMatchObject({
              iss: "voice@example.com",
              aud: "https://oauth2.googleapis.com/token",
              scope: "https://www.googleapis.com/auth/cloud-platform",
            });
            return Response.json({ access_token: "google-token" });
          }
          expect(request.headers.authorization).toBe("Bearer google-token");
          if (request.url.includes(":recognize")) {
            expect(request.url).toContain(
              "projects/voice-project/locations/global/recognizers/_:recognize",
            );
            expect(jsonBody(request)).toMatchObject({
              config: { autoDecodingConfig: {}, languageCodes: ["pt-BR"] },
              content: "AQI=",
            });
            return Response.json({
              results: [
                { alternatives: [{ transcript: "Olá" }] },
                { alternatives: [{ transcript: "mundo" }] },
              ],
            });
          }
          expect(jsonBody(request)).toEqual({
            input: { text: "Olá" },
            voice: { languageCode: "pt-BR", name: "pt-BR-Chirp3-HD-Aoede" },
            audioConfig: { audioEncoding: "MP3" },
          });
          return Response.json({ audioContent: "SUQz" });
        },
      );
      yield* Effect.gen(function* () {
        const speech = yield* Speech.Speech;
        expect((yield* speech.transcribe(new Uint8Array([1, 2]), "m4a")).text).toBe("Olá mundo");
        expect(Array.from(yield* speech.narrate({ text: "Olá" }))).toEqual([73, 68, 51]);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each([401, 403, 422, 429, 503])("reports safe errors for upstream HTTP %s", (status) =>
  Effect.gen(function* () {
    const layer = testLayer(
      {
        dictation: null,
        narration: { provider: "elevenlabs", credential: "secret", voice: "voice-id" },
      },
      () => new Response("private response details", { status }),
    );
    const error = yield* Effect.gen(function* () {
      return yield* (yield* Speech.Speech).narrate({ text: "Hello" });
    }).pipe(Effect.provide(layer), Effect.flip);
    expect(error).toMatchObject({
      _tag: "SpeechError",
      reason:
        status === 401 || status === 403
          ? "invalid-credential"
          : status === 503
            ? "unavailable"
            : "rejected",
    });
    expect(error.message).not.toContain("private");
  }),
);

it.effect(
  "rejects missing configuration, empty recordings, oversize text, and malformed upstream responses",
  () =>
    Effect.gen(function* () {
      const layer = testLayer(
        {
          dictation: { provider: "openai", credential: "key", language: "en-US" },
          narration: null,
        },
        () => Response.json({ invalid: true }),
      );
      yield* Effect.gen(function* () {
        const speech = yield* Speech.Speech;
        expect(yield* speech.narrate({ text: "hello" }).pipe(Effect.flip)).toMatchObject({
          reason: "not-configured",
        });
        expect(yield* speech.transcribe(new Uint8Array(), "webm").pipe(Effect.flip)).toMatchObject({
          reason: "invalid-audio",
        });
        expect(
          yield* speech.transcribe(new Uint8Array([1]), "webm").pipe(Effect.flip),
        ).toMatchObject({ reason: "invalid-response" });
        yield* (yield* ServerSettingsModule.ServerSettingsService).updateSettings({
          speech: { narration: { provider: "openai", credential: "key", voice: "coral" } },
        });
        expect(yield* speech.narrate({ text: "你".repeat(2000) }).pipe(Effect.flip)).toMatchObject({
          reason: "invalid-text",
        });
      }).pipe(Effect.provide(layer));
    }),
);
