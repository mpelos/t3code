/**
 * How a new Editaii conversation's thread runs on this machine: in the T3 project the person chose
 * in the Editaii panel, with what the T3 resolves for a new thread there (the project's own
 * settings, else the global defaults). The Editaii has no model setting of its own; a model that
 * does not suit it is changed in that project's settings.
 */
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Connection from "./EditaiiConnection.ts";
import * as Journal from "./EditaiiJournal.ts";

const indisponivel = (motivo: string): Journal.Configuracao => ({ type: "indisponivel", motivo });
const ilegivel = (cause: unknown) => new Journal.EditaiiConfiguracaoIlegivel({ cause });

/**
 * Read when a request starts a thread. What is missing or off is `indisponivel`, with what to do
 * about it; settings or projects that cannot be read are `EditaiiConfiguracaoIlegivel`.
 */
export const ler = Effect.gen(function* () {
  const { projectId } = yield* Connection.EditaiiConnection.use((c) => c.state);
  if (projectId === null)
    return indisponivel(
      "Escolha, nas configurações do Editaii no T3 desta máquina, o projeto para novas conversas.",
    );
  const project = yield* ProjectService.ProjectService.use((p) => p.getById(projectId)).pipe(
    Effect.mapError(ilegivel),
  );
  if (Option.isNone(project))
    return indisponivel(
      "O projeto do T3 escolhido para o Editaii não existe mais nesta máquina. Escolha outro nas configurações do Editaii no T3.",
    );
  const settings = yield* ServerSettings.ServerSettingsService.use((s) => s.getSettings).pipe(
    Effect.mapError(ilegivel),
  );
  const efetivas = resolveProjectSettings(settings, projectId, project.value).settings;
  const titulo = project.value.title;
  const modelSelection = efetivas.defaultModelSelection;
  if (modelSelection === null)
    return indisponivel(
      `Defina, no T3 desta máquina, um modelo padrão para o projeto "${titulo}".`,
    );
  if (!resolveProjectProviderInstanceEnabled(settings, projectId, modelSelection.instanceId))
    return indisponivel(
      `O provedor do modelo padrão do projeto "${titulo}" está desativado no T3 desta máquina.`,
    );
  return {
    type: "pronta",
    projectId,
    modelSelection,
    runtimeMode: efetivas.defaultRuntimeMode,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  } satisfies Journal.Configuracao;
});
