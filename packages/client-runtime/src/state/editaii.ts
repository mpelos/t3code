import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createEditaiiEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "editaii:state",
      tag: WS_METHODS.editaiiSubscribe,
      idleTtlMs: 0,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "editaii:configure",
      tag: WS_METHODS.editaiiConfigure,
    }),
    startPairing: createEnvironmentRpcCommand(runtime, {
      label: "editaii:start",
      tag: WS_METHODS.editaiiStartPairing,
    }),
    reopenBrowser: createEnvironmentRpcCommand(runtime, {
      label: "editaii:reopen",
      tag: WS_METHODS.editaiiReopenBrowser,
    }),
    disconnect: createEnvironmentRpcCommand(runtime, {
      label: "editaii:disconnect",
      tag: WS_METHODS.editaiiDisconnect,
    }),
    chooseProject: createEnvironmentRpcCommand(runtime, {
      label: "editaii:choose-project",
      tag: WS_METHODS.editaiiChooseProject,
    }),
  };
}
