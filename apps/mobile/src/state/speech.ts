import {
  createSpeechEnvironmentCommands,
  createSpeechContextAtom,
} from "@t3tools/client-runtime/state/speech";
import { Atom, AsyncResult } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { mobilePreferencesAtom } from "./preferences";
import { environmentSession } from "./session";
import { serverEnvironment } from "./server";

const speechEnvironmentIdAtom = Atom.make(
  (get) =>
    AsyncResult.getOrElse(get(mobilePreferencesAtom), () => null)?.speechEnvironmentId ?? null,
);
export const speechContextAtom = createSpeechContextAtom({
  environmentIdAtom: speechEnvironmentIdAtom,
  configValueAtom: serverEnvironment.configValueAtom,
  sessionStateAtom: environmentSession.sessionStateAtom,
});
export const speechEnvironment = createSpeechEnvironmentCommands(connectionAtomRuntime);
