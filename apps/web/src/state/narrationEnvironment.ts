import {
  createNarrationEnvironmentCommands,
  createNarrationContextAtom,
} from "@t3tools/client-runtime/state/narration";
import { Atom } from "effect/reactivity";
import type { EnvironmentId } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
import {
  getClientSettings,
  getClientSettingsHydratedSnapshot,
  subscribeClientSettings,
  subscribeClientSettingsHydration,
  updateClientSettings,
} from "../hooks/useSettings";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentSession } from "./session";
import { serverEnvironment } from "./server";

const speechPreferenceAtom = Atom.make((get) => {
  const read = () => ({
    environmentId: getClientSettings().speechEnvironmentId,
    ready: getClientSettingsHydratedSnapshot(),
  });
  let current = read();
  const publish = () => {
    const next = read();
    if (next.environmentId !== current.environmentId || next.ready !== current.ready) {
      current = next;
      get.setSelf(next);
    }
  };
  get.addFinalizer(subscribeClientSettings(publish));
  get.addFinalizer(subscribeClientSettingsHydration(publish));
  return current;
}).pipe(Atom.keepAlive, Atom.withLabel("web:speech:preference"));
const speechEnvironmentIdAtom = Atom.make((get) => {
  const preference = get(speechPreferenceAtom);
  return preference.ready ? (preference.environmentId ?? get(primaryEnvironmentIdAtom)) : null;
});

export const narrationContextAtom = createNarrationContextAtom({
  environmentIdAtom: speechEnvironmentIdAtom,
  configValueAtom: serverEnvironment.configValueAtom,
  sessionStateAtom: environmentSession.sessionStateAtom,
});
export const selectNarrationEnvironment = (environmentId: EnvironmentId) =>
  updateClientSettings({ speechEnvironmentId: environmentId });
export const narrationEnvironment = createNarrationEnvironmentCommands(connectionAtomRuntime);
