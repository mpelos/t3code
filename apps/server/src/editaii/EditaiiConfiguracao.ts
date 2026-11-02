/**
 * How a new Editaii conversation's thread runs here: in the project chosen in the panel, with what
 * the T3 resolves for a new thread there. The Editaii has no model setting of its own. One rule,
 * told to the panel in the T3 (`resolver`) and to the person in the Editaii (`ler`).
 */
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type EditaiiConfiguration,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Connection from "./EditaiiConnection.ts";
import * as Journal from "./EditaiiJournal.ts";

export type Resolvida = Exclude<EditaiiConfiguration, { readonly type: "unavailable" }>;

const ilegivel = (cause: unknown) => new Journal.EditaiiConfiguracaoIlegivel({ cause });

/**
 * What a new conversation would run with now. What is missing or off is `incomplete`, with the
 * reason; settings or projects that cannot be read are `EditaiiConfiguracaoIlegivel`.
 */
export const resolver = Effect.gen(function* () {
  const { projectId } = yield* Connection.EditaiiConnection.use((c) => c.state);
  if (projectId === null)
    return { type: "incomplete", reason: "no_project", projectTitle: null } satisfies Resolvida;
  const project = yield* ProjectService.ProjectService.use((p) => p.getById(projectId)).pipe(
    Effect.mapError(ilegivel),
  );
  if (Option.isNone(project))
    return {
      type: "incomplete",
      reason: "project_missing",
      projectTitle: null,
    } satisfies Resolvida;
  const settings = yield* ServerSettings.ServerSettingsService.use((s) => s.getSettings).pipe(
    Effect.mapError(ilegivel),
  );
  const efetivas = resolveProjectSettings(settings, projectId, project.value).settings;
  const projectTitle = project.value.title;
  const modelSelection = efetivas.defaultModelSelection;
  if (modelSelection === null)
    return { type: "incomplete", reason: "no_model", projectTitle } satisfies Resolvida;
  if (!resolveProjectProviderInstanceEnabled(settings, projectId, modelSelection.instanceId))
    return { type: "incomplete", reason: "provider_disabled", projectTitle } satisfies Resolvida;
  return {
    type: "ready",
    projectId,
    projectTitle,
    modelSelection,
    runtimeMode: efetivas.defaultRuntimeMode,
  } satisfies Resolvida;
});

/** What the person in the Editaii reads when a request cannot start its thread. */
const motivo = (c: Extract<Resolvida, { readonly type: "incomplete" }>): string => {
  switch (c.reason) {
    case "no_project":
      return "Escolha, nas configurações do Editaii no T3 desta máquina, o projeto para novas conversas.";
    case "project_missing":
      return "O projeto do T3 escolhido para o Editaii não existe mais nesta máquina. Escolha outro nas configurações do Editaii no T3.";
    case "no_model":
      return `Defina, no T3 desta máquina, um modelo padrão para o projeto "${c.projectTitle}".`;
    case "provider_disabled":
      return `O provedor do modelo padrão do projeto "${c.projectTitle}" está desativado no T3 desta máquina.`;
  }
};

/** Read when a request starts a thread: `resolver`, as the journal takes it. */
export const ler = resolver.pipe(
  Effect.map((c): Journal.Configuracao =>
    c.type === "incomplete"
      ? { type: "indisponivel", motivo: motivo(c) }
      : {
          type: "pronta",
          projectId: c.projectId,
          modelSelection: c.modelSelection,
          runtimeMode: c.runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        },
  ),
);
