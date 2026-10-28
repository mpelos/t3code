import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
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

it.effect(
  "validates and saves local Qwen narration without credentials, preserving settings on failure",
  () =>
    Effect.gen(function* () {
      let status = 503;
      let contentType = "audio/mpeg";
      let requests = 0;
      const config = {
        provider: "qwen",
        baseUrl: "http://127.0.0.1:18320/engine",
        voice: "Ryan",
        language: "Portuguese",
      } as const;
      const layer = testLayer({ dictation: null, narration: null }, (request) => {
        requests++;
        expect(request.url).toBe("http://127.0.0.1:18320/engine/v1/audio/speech");
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers["xi-api-key"]).toBeUndefined();
        expect(jsonBody(request)).toMatchObject({
          model: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
          voice: "Ryan",
          lang_code: "Portuguese",
          response_format: "mp3",
          stream: false,
          max_tokens: 1024,
        });
        return new Response(new Uint8Array([73, 68, 51]), {
          status,
          headers: { "content-type": contentType },
        });
      });
      yield* Effect.gen(function* () {
        const speech = yield* Speech.Speech;
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        expect(
          yield* speech.configure({ role: "narration", config }).pipe(Effect.flip),
        ).toMatchObject({ provider: "qwen", reason: "unavailable" });
        expect((yield* settings.getSettings).speech.narration).toBeNull();
        status = 200;
        yield* speech.configure({ role: "narration", config });
        expect((yield* settings.getSettings).speech.narration).toEqual(config);
        expect(Array.from(yield* speech.narrate({ text: "Olá" }))).toEqual([73, 68, 51]);
        const beforeOversize = requests;
        expect(yield* speech.narrate({ text: "a".repeat(301) }).pipe(Effect.flip)).toMatchObject({
          reason: "invalid-text",
        });
        expect(requests).toBe(beforeOversize);
        contentType = "application/json";
        expect(yield* speech.narrate({ text: "Olá" }).pipe(Effect.flip)).toMatchObject({
          provider: "qwen",
          reason: "invalid-response",
        });
        expect((yield* settings.getSettings).speech.narration).toEqual(config);
        yield* speech.configure({ role: "narration", config: null });
        expect((yield* settings.getSettings).speech.narration).toBeNull();
      }).pipe(Effect.provide(layer));
    }),
);

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
      let rejectToken = false;
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
            if (rejectToken)
              return Response.json(
                { error: "invalid_grant", error_description: "private details" },
                { status: 400 },
              );
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
        rejectToken = true;
        expect(yield* speech.narrate({ text: "Olá" }).pipe(Effect.flip)).toMatchObject({
          reason: "invalid-credential",
          provider: "google",
          role: "narration",
        });
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each(
  [401, 403, 422, 429, 503].flatMap((status) =>
    ["elevenlabs", "qwen"].map((provider) => ({ status, provider })),
  ),
)("reports safe errors for upstream HTTP %j", ({ status, provider }) =>
  Effect.gen(function* () {
    const layer = testLayer(
      {
        dictation: null,
        narration:
          provider === "qwen"
            ? {
                provider: "qwen",
                baseUrl: "http://127.0.0.1:18320",
                voice: "Ryan",
                language: "Portuguese",
              }
            : { provider: "elevenlabs", credential: "secret", voice: "voice-id" },
      },
      () => new Response("private response details", { status }),
    );
    const error = yield* Effect.gen(function* () {
      return yield* (yield* Speech.Speech).narrate({ text: "Hello" });
    }).pipe(Effect.provide(layer), Effect.flip);
    expect(error).toMatchObject({
      _tag: "SpeechError",
      provider,
      role: "narration",
      reason:
        status === 401
          ? "invalid-credential"
          : status === 403
            ? "permission-denied"
            : status === 429
              ? "quota-exceeded"
              : status === 503
                ? "unavailable"
                : "rejected",
    });
    expect(error.message).not.toContain("private");
    expect(error.message).toContain(
      provider === "qwen" ? "Qwen3-TTS narration" : "ElevenLabs narration",
    );
    if (provider === "qwen") expect(error.message).not.toMatch(/billing|balance|API key/);
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

it.effect.each(["dictation", "narration"] as const)(
  "validates %s before saving and preserves the previous configuration on rejection",
  (role) =>
    Effect.gen(function* () {
      let status = 401;
      let requests = 0;
      const config =
        role === "dictation"
          ? {
              role,
              config: { provider: "openai" as const, credential: "new-key", language: "pt-BR" },
            }
          : {
              role,
              config: { provider: "elevenlabs" as const, credential: "new-key", voice: "voice-id" },
            };
      const layer = testLayer({ dictation: null, narration: null }, (request) => {
        requests++;
        expect(request.headers[role === "dictation" ? "authorization" : "xi-api-key"]).toBe(
          role === "dictation" ? "Bearer new-key" : "new-key",
        );
        return status === 200
          ? role === "dictation"
            ? Response.json({ text: "" })
            : new Response(new Uint8Array([73, 68, 51]))
          : new Response("private provider details", { status });
      });
      yield* Effect.gen(function* () {
        const speech = yield* Speech.Speech;
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        const previous = { ...config.config, credential: "previous-key" };
        yield* settings.updateSettings({
          speech:
            config.role === "dictation"
              ? { dictation: { ...config.config, credential: "previous-key" } }
              : { narration: { ...config.config, credential: "previous-key" } },
        });
        expect(yield* speech.configure(config).pipe(Effect.flip)).toMatchObject({
          reason: "invalid-credential",
          role,
          provider: config.config.provider,
        });
        expect((yield* settings.getSettings).speech[role]).toEqual(previous);
        status = 200;
        yield* speech.configure(config);
        expect((yield* settings.getSettings).speech[role]).toEqual(config.config);
        yield* speech.configure(
          config.role === "dictation"
            ? { ...config, config: { ...config.config, credential: "••••••" } }
            : { ...config, config: { ...config.config, credential: "••••••" } },
        );
        expect((yield* settings.getSettings).speech[role]).toMatchObject({ credential: "new-key" });
        yield* speech.configure({ role, config: null });
        expect((yield* settings.getSettings).speech[role]).toBeNull();
        expect(requests).toBe(3);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("times out a stalled credential check without saving it", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const layer = Speech.layer.pipe(
      Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const speech = yield* Speech.Speech;
      const request = yield* speech
        .configure({
          role: "narration",
          config: { provider: "openai", credential: "test-key", voice: "coral" },
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("120 seconds");
      expect(yield* Fiber.join(request)).toMatchObject({
        reason: "unavailable",
        provider: "openai",
        role: "narration",
      });
      expect(
        (yield* (yield* ServerSettingsModule.ServerSettingsService).getSettings).speech.narration,
      ).toBeNull();
    }).pipe(Effect.provide(layer));
  }),
);
