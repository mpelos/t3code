import {
  NARRATION_CHUNK_MAX_BYTES,
  SPEECH_AUDIO_MAX_BYTES,
  SpeechError,
  type SpeechAudioFormat,
  type NarrationInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import { importPKCS8, SignJWT } from "jose";
import * as ServerSettings from "../serverSettings.ts";

const GoogleCredential = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("service_account"),
    project_id: Schema.NonEmptyString,
    client_email: Schema.NonEmptyString,
    private_key: Schema.NonEmptyString,
  }),
);
const decodeGoogleCredential = Schema.decodeEffect(GoogleCredential);
const GoogleToken = Schema.Struct({ access_token: Schema.NonEmptyString });
const Transcript = Schema.Struct({ text: Schema.String });
const GoogleTranscript = Schema.Struct({
  results: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        alternatives: Schema.Array(Schema.Struct({ transcript: Schema.String })),
      }),
    ),
  ),
});
const GoogleAudio = Schema.Struct({ audioContent: Schema.Uint8ArrayFromBase64 });

export class SpeechRequestError extends Schema.TaggedError<SpeechRequestError>()(
  "SpeechRequestError",
  {
    reason: Schema.Literals(["invalid-credential", "unavailable", "invalid-response"]),
    cause: Schema.Defect(),
  },
) {}

type SpeechOperationError =
  | SpeechError
  | SpeechRequestError
  | import("@t3tools/contracts").ServerSettingsError;

export class Speech extends Context.Service<
  Speech,
  {
    readonly transcribe: (
      audio: Uint8Array,
      format: SpeechAudioFormat,
    ) => Effect.Effect<{ readonly text: string }, SpeechOperationError>;
    readonly narrate: (input: NarrationInput) => Effect.Effect<Uint8Array, SpeechOperationError>;
  }
>()("t3/speech/Speech") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const http = yield* HttpClient.HttpClient;

  const execute = Effect.fn("Speech.request")(function* (
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const response = yield* http
      .execute(request)
      .pipe(Effect.mapError((cause) => new SpeechRequestError({ reason: "unavailable", cause })));
    if (response.status === 401 || response.status === 403) {
      return yield* new SpeechError({ reason: "invalid-credential" });
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new SpeechError({
        reason: response.status >= 500 ? "unavailable" : "rejected",
      });
    }
    return response;
  });
  const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
    response: HttpClientResponse.HttpClientResponse,
    schema: S,
  ) =>
    response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError((cause) => new SpeechRequestError({ reason: "invalid-response", cause })),
    );
  const googleAuthorization = Effect.fn("Speech.googleAuthorization")(function* (
    credential: string,
  ) {
    const account = yield* decodeGoogleCredential(credential).pipe(
      Effect.mapError((cause) => new SpeechRequestError({ reason: "invalid-credential", cause })),
    );
    const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
    const assertion = yield* Effect.tryPromise({
      try: async () =>
        new SignJWT({ scope: "https://www.googleapis.com/auth/cloud-platform" })
          .setProtectedHeader({ alg: "RS256" })
          .setIssuer(account.client_email)
          .setAudience("https://oauth2.googleapis.com/token")
          .setIssuedAt(now)
          .setExpirationTime(now + 3600)
          .sign(await importPKCS8(account.private_key, "RS256")),
      catch: (cause) => new SpeechRequestError({ reason: "invalid-credential", cause }),
    });
    const response = yield* execute(
      HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
      ),
    );
    const token = yield* decode(response, GoogleToken);
    return { authorization: `Bearer ${token.access_token}`, projectId: account.project_id };
  });

  const transcribe = Effect.fn("Speech.transcribe")(function* (
    audio: Uint8Array,
    format: SpeechAudioFormat,
  ) {
    const config = (yield* settings.getSettings).speech.dictation;
    if (!config?.credential) return yield* new SpeechError({ reason: "not-configured" });
    if (audio.byteLength === 0 || audio.byteLength > SPEECH_AUDIO_MAX_BYTES) {
      return yield* new SpeechError({ reason: "invalid-audio" });
    }
    if (config.provider === "openai") {
      const form = new FormData();
      form.set("file", new Blob([Uint8Array.from(audio)]), `dictation.${format}`);
      form.set("model", "whisper-1");
      form.set("language", config.language.split("-")[0] ?? config.language);
      const response = yield* execute(
        HttpClientRequest.post("https://api.openai.com/v1/audio/transcriptions").pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${config.credential}`),
          HttpClientRequest.bodyFormData(form),
        ),
      );
      return yield* decode(response, Transcript);
    }
    const auth = yield* googleAuthorization(config.credential);
    const response = yield* execute(
      HttpClientRequest.post(
        `https://speech.googleapis.com/v2/projects/${encodeURIComponent(auth.projectId)}/locations/global/recognizers/_:recognize`,
      ).pipe(
        HttpClientRequest.setHeader("authorization", auth.authorization),
        HttpClientRequest.bodyJsonUnsafe({
          config: {
            autoDecodingConfig: {},
            languageCodes: [config.language],
            model: "short",
            features: { enableAutomaticPunctuation: true },
          },
          content: Buffer.from(audio).toString("base64"),
        }),
      ),
    );
    const result = yield* decode(response, GoogleTranscript);
    return {
      text: (result.results ?? [])
        .map((entry) => entry.alternatives[0]?.transcript ?? "")
        .join(" ")
        .trim(),
    };
  });

  const narrate = Effect.fn("Speech.narrate")(function* ({ text }: NarrationInput) {
    const config = (yield* settings.getSettings).speech.narration;
    if (!config?.credential) return yield* new SpeechError({ reason: "not-configured" });
    if (!text.trim() || new TextEncoder().encode(text).byteLength > NARRATION_CHUNK_MAX_BYTES) {
      return yield* new SpeechError({ reason: "invalid-text" });
    }
    if (config.provider === "google") {
      const auth = yield* googleAuthorization(config.credential);
      const response = yield* execute(
        HttpClientRequest.post("https://texttospeech.googleapis.com/v1/text:synthesize").pipe(
          HttpClientRequest.setHeader("authorization", auth.authorization),
          HttpClientRequest.bodyJsonUnsafe({
            input: { text },
            voice: { languageCode: config.language, name: config.voice },
            audioConfig: { audioEncoding: "MP3" },
          }),
        ),
      );
      const result = yield* decode(response, GoogleAudio);
      if (result.audioContent.byteLength === 0)
        return yield* new SpeechError({ reason: "invalid-response" });
      return result.audioContent;
    }
    const request =
      config.provider === "openai"
        ? HttpClientRequest.post("https://api.openai.com/v1/audio/speech").pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${config.credential}`),
            HttpClientRequest.bodyJsonUnsafe({
              model: "gpt-4o-mini-tts",
              voice: config.voice,
              input: text,
              response_format: "mp3",
            }),
          )
        : HttpClientRequest.post(
            "https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_44100_128",
          ).pipe(
            HttpClientRequest.setHeader("xi-api-key", config.credential),
            HttpClientRequest.bodyJsonUnsafe({
              inputs: [{ text, voice_id: config.voice }],
              model_id: "eleven_v4",
            }),
          );
    const response = yield* execute(request);
    const buffer = yield* response.arrayBuffer.pipe(
      Effect.mapError((cause) => new SpeechRequestError({ reason: "invalid-response", cause })),
    );
    if (buffer.byteLength === 0) return yield* new SpeechError({ reason: "invalid-response" });
    return new Uint8Array(buffer);
  });
  return Speech.of({ transcribe, narrate });
});

export const layer = Layer.effect(Speech, make);
