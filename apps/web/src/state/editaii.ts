import { createEditaiiEnvironmentAtoms } from "@t3tools/client-runtime/state/editaii";
import { connectionAtomRuntime } from "../connection/runtime";

export const editaiiEnvironment = createEditaiiEnvironmentAtoms(connectionAtomRuntime);
