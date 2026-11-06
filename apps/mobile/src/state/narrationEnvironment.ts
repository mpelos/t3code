import {
  createNarrationEnvironmentCommands,
  createNarrationContextAtom,
} from "@t3tools/client-runtime/state/narration";
import { Atom, AsyncResult } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { mobilePreferencesAtom } from "./preferences";
import { environmentSession } from "./session";
import { serverEnvironment } from "./server";

const speechEnvironmentIdAtom = Atom.make(
  (get) =>
    AsyncResult.getOrElse(get(mobilePreferencesAtom), () => null)?.speechEnvironmentId ?? null,
);
export const narrationContextAtom = createNarrationContextAtom({
  environmentIdAtom: speechEnvironmentIdAtom,
  configValueAtom: serverEnvironment.configValueAtom,
  sessionStateAtom: environmentSession.sessionStateAtom,
});
export const narrationEnvironment = createNarrationEnvironmentCommands(connectionAtomRuntime);
