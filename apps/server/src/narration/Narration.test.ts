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
import * as Speech from "./Narration.ts";

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
      const layer = testLayer({ narration: null }, (request) => {
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
        const speech = yield* Speech.Narration;
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

it.effect.each([
  { provider: "openai", credential: "voice-key", voice: "voice-id" },
  { provider: "elevenlabs", credential: "voice-key", voice: "voice-id" },
  { provider: "fish", credential: "voice-key", voice: "voice-id", model: "s2.1-pro" },
  { provider: "fish", credential: "voice-key", voice: "voice-id", model: "s2.1-pro-free" },
] as const)("synthesizes MP3 using %j", (config) =>
  Effect.gen(function* () {
    const { provider } = config;
    const layer = testLayer({ narration: config }, (request) => {
      expect(request.headers[provider === "elevenlabs" ? "xi-api-key" : "authorization"]).toBe(
        provider === "elevenlabs" ? "voice-key" : "Bearer voice-key",
      );
      if (config.provider === "fish") expect(request.headers.model).toBe(config.model);
      expect(jsonBody(request)).toMatchObject(
        provider === "openai"
          ? { voice: "voice-id", input: "Hello" }
          : provider === "fish"
            ? { text: "Hello", reference_id: "voice-id", format: "mp3" }
            : { inputs: [{ text: "Hello", voice_id: "voice-id" }], model_id: "eleven_v4" },
      );
      expect(request.url).toBe(
        provider === "openai"
          ? "https://api.openai.com/v1/audio/speech"
          : provider === "fish"
            ? "https://api.fish.audio/v1/tts"
            : "https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_44100_128",
      );
      return new Response(new Uint8Array([73, 68, 51]), {
        headers: { "content-type": "audio/mpeg" },
      });
    });
    const result = yield* Effect.gen(function* () {
      return yield* (yield* Speech.Narration).narrate({ text: "Hello" });
    }).pipe(Effect.provide(layer));
    expect(Array.from(result)).toEqual([73, 68, 51]);
  }),
);

it.effect("authorizes Google with a service account and decodes synthesis responses", () =>
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
        expect(jsonBody(request)).toEqual({
          input: { text: "Olá" },
          voice: { languageCode: "pt-BR", name: "pt-BR-Chirp3-HD-Aoede" },
          audioConfig: { audioEncoding: "MP3" },
        });
        return Response.json({ audioContent: "SUQz" });
      },
    );
    yield* Effect.gen(function* () {
      const speech = yield* Speech.Narration;
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

it.effect.each([
  { body: '{"message":"private details"}', contentType: "application/json" },
  { body: "", contentType: "audio/mpeg" },
])("rejects a non-playable Fish response %j", ({ body, contentType }) =>
  Effect.gen(function* () {
    const layer = testLayer(
      {
        narration: {
          provider: "fish",
          credential: "key",
          voice: "voice-id",
          model: "s2.1-pro-free",
        },
      },
      () => new Response(body, { headers: { "content-type": contentType } }),
    );
    const error = yield* Effect.gen(function* () {
      return yield* (yield* Speech.Narration).narrate({ text: "Hello" });
    }).pipe(Effect.provide(layer), Effect.flip);
    expect(error).toMatchObject({
      reason: "invalid-response",
      provider: "fish",
      role: "narration",
    });
    expect(error.message).not.toContain("private");
  }),
);

it.effect.each(
  [401, 402, 403, 422, 429, 503].flatMap((status) =>
    (["elevenlabs", "fish", "qwen"] as const).map((provider) => ({ status, provider })),
  ),
)("reports safe errors for upstream HTTP %j", ({ status, provider }) =>
  Effect.gen(function* () {
    const layer = testLayer(
      {
        narration:
          provider === "qwen"
            ? {
                provider: "qwen",
                baseUrl: "http://127.0.0.1:18320",
                voice: "Ryan",
                language: "Portuguese",
              }
            : provider === "fish"
              ? { provider, credential: "secret", voice: "voice-id", model: "s2.1-pro-free" }
              : { provider, credential: "secret", voice: "voice-id" },
      },
      () => new Response("private response details", { status }),
    );
    const error = yield* Effect.gen(function* () {
      return yield* (yield* Speech.Narration).narrate({ text: "Hello" });
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
            : status === 402
              ? "insufficient-credit"
              : status === 429
                ? "quota-exceeded"
                : status === 503
                  ? "unavailable"
                  : "rejected",
    });
    expect(error.message).not.toContain("private");
    expect(error.message).toContain(
      provider === "qwen"
        ? "Qwen3-TTS narration"
        : provider === "fish"
          ? "Fish Audio narration"
          : "ElevenLabs narration",
    );
    if (provider === "qwen") expect(error.message).not.toMatch(/billing|balance|API key/);
  }),
);

it.effect("rejects missing configuration, oversize text, and malformed upstream responses", () =>
  Effect.gen(function* () {
    const layer = testLayer(
      {
        narration: null,
      },
      () => Response.json({ invalid: true }),
    );
    yield* Effect.gen(function* () {
      const speech = yield* Speech.Narration;
      expect(yield* speech.narrate({ text: "hello" }).pipe(Effect.flip)).toMatchObject({
        reason: "not-configured",
      });
      yield* (yield* ServerSettingsModule.ServerSettingsService).updateSettings({
        speech: { narration: { provider: "openai", credential: "key", voice: "coral" } },
      });
      expect(yield* speech.narrate({ text: "Hello" }).pipe(Effect.flip)).toMatchObject({
        reason: "invalid-response",
      });
      expect(yield* speech.narrate({ text: "你".repeat(2000) }).pipe(Effect.flip)).toMatchObject({
        reason: "invalid-text",
      });
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each([
  {
    role: "narration",
    config: { provider: "elevenlabs", credential: "new-key", voice: "voice-id" },
  },
  {
    role: "narration",
    config: { provider: "fish", credential: "new-key", voice: "voice-id", model: "s2.1-pro" },
  },
  {
    role: "narration",
    config: { provider: "fish", credential: "new-key", voice: "voice-id", model: "s2.1-pro-free" },
  },
] as const)(
  "validates %j before saving and preserves the previous configuration on rejection",
  (config) =>
    Effect.gen(function* () {
      const { role } = config;
      let status = 401;
      let requests = 0;
      const layer = testLayer({ narration: null }, (request) => {
        requests++;
        expect(
          request.headers[config.config.provider === "elevenlabs" ? "xi-api-key" : "authorization"],
        ).toBe(config.config.provider === "elevenlabs" ? "new-key" : "Bearer new-key");
        if (config.config.provider === "fish")
          expect(request.headers.model).toBe(config.config.model);
        return status === 200
          ? new Response(new Uint8Array([73, 68, 51]), {
              headers: { "content-type": "audio/mpeg" },
            })
          : new Response("private provider details", { status });
      });
      yield* Effect.gen(function* () {
        const speech = yield* Speech.Narration;
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        const previous = { ...config.config, credential: "previous-key" };
        yield* settings.updateSettings({
          speech: { narration: { ...config.config, credential: "previous-key" } },
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
        yield* speech.configure({ ...config, config: { ...config.config, credential: "••••••" } });
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
      const speech = yield* Speech.Narration;
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
