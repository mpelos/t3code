import { createSpeechEnvironmentCommands } from "@t3tools/client-runtime/state/speech";
import { connectionAtomRuntime } from "../connection/runtime";

export const speechEnvironment = createSpeechEnvironmentCommands(connectionAtomRuntime);
