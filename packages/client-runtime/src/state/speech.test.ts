import { it, expect } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  type AuthSessionState,
  type SpeechSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { createSpeechContextAtom } from "./speech.ts";

const source = EnvironmentId.make("mac-pro");
const other = EnvironmentId.make("mac-mini");
const configured: SpeechSettings = {
  dictation: { provider: "openai", credential: "redacted", language: "pt-BR" },
  narration: { provider: "elevenlabs", credential: "redacted", voice: "voice-id" },
};
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});

it.effect(
  "uses only the selected Speech host's settings and grant, without falling back to another host",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const selected = Atom.make<EnvironmentId | null>(source);
        const configs = Atom.family((id: EnvironmentId) =>
          Atom.make<{ settings: { speech: SpeechSettings } } | null>(
            id === source ? { settings: { speech: configured } } : null,
          ),
        );
        const sessions = Atom.family((_id: EnvironmentId) =>
          Atom.make(AsyncResult.success(grant(true))),
        );
        const context = createSpeechContextAtom({
          environmentIdAtom: selected,
          configValueAtom: configs,
          sessionStateAtom: sessions,
        });
        registry.mount(context);
        expect(registry.get(context)).toEqual({
          environmentId: source,
          ...configured,
          canOperate: true,
        });
        const unchanged = registry.get(context);
        registry.set(configs(source), { settings: { speech: configured } });
        registry.set(sessions(source), AsyncResult.success(grant(true)));
        expect(registry.get(context)).toBe(unchanged);
        registry.set(sessions(source), AsyncResult.success(grant(false)));
        expect(registry.get(context).canOperate).toBe(false);
        registry.set(selected, other);
        expect(registry.get(context)).toEqual({
          environmentId: other,
          dictation: null,
          narration: null,
          canOperate: true,
        });
        registry.set(selected, source);
        registry.set(configs(source), null);
        expect(registry.get(context)).toEqual({
          environmentId: source,
          dictation: null,
          narration: null,
          canOperate: false,
        });
        registry.set(selected, null);
        expect(registry.get(context)).toEqual({
          environmentId: null,
          dictation: null,
          narration: null,
          canOperate: false,
        });
      }),
    ),
);
