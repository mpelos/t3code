import { assert, describe, it } from "@effect/vitest";
import { type Project, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Configuracao from "./EditaiiConfiguracao.ts";
import * as Connection from "./EditaiiConnection.ts";

const PROJETO = ProjectId.make("projeto-editaii");
const GLOBAL = { instanceId: ProviderInstanceId.make("codex"), model: "global" };
const DO_PROJETO = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "do-projeto" };
const projeto: Project = {
  id: PROJETO,
  title: "Licitações",
  workspaceRoot: "/tmp/licitacoes",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  deletedAt: null,
};

/** Reads `efeito` on a machine with this project chosen, these projects and settings. */
const naMaquina = <A, E, R>(
  efeito: Effect.Effect<A, E, R>,
  escolhido: ProjectId | null,
  options: {
    readonly projetos?: ReadonlyArray<Project>;
    readonly settings?: Parameters<typeof ServerSettings.ServerSettingsService.layerTest>[0];
    readonly projetosIlegiveis?: boolean;
  } = {},
) =>
  efeito.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(Connection.EditaiiConnection)({
          state: Effect.succeed({
            status: "connected",
            origin: "https://editaii.example",
            machine: null,
            problem: null,
            canReopen: false,
            projectId: escolhido,
            attempt: null,
          }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            options.projetosIlegiveis
              ? Effect.fail(
                  new ProjectService.ProjectOperationError({
                    operation: "read-project",
                    projectId: id,
                    cause: new Error("database locked"),
                  }),
                )
              : Effect.succeed(
                  Option.fromUndefinedOr((options.projetos ?? [projeto]).find((p) => p.id === id)),
                ),
        }),
        ServerSettings.ServerSettingsService.layerTest(
          options.settings ?? { defaultModelSelection: GLOBAL },
        ),
      ),
    ),
  );

const ler = (escolhido: ProjectId | null, options: Parameters<typeof naMaquina>[2] = {}) =>
  naMaquina(Configuracao.ler, escolhido, options);
const resolver = (escolhido: ProjectId | null, options: Parameters<typeof naMaquina>[2] = {}) =>
  naMaquina(Configuracao.resolver, escolhido, options);

describe("EditaiiConfiguracao", () => {
  it.effect("runs new conversations with what the T3 resolves for the chosen project", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* ler(PROJETO), {
        type: "pronta",
        projectId: PROJETO,
        modelSelection: GLOBAL,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const comOverride = yield* ler(PROJETO, {
        settings: {
          defaultModelSelection: GLOBAL,
          defaultRuntimeMode: "approval-required",
          projectSettingsOverrides: { [PROJETO]: { defaultModelSelection: DO_PROJETO } },
        },
      });
      assert.deepInclude(comOverride, {
        modelSelection: DO_PROJETO,
        runtimeMode: "approval-required",
      });
    }),
  );

  it.effect("says why it cannot run them, to the panel and to the person in the Editaii", () =>
    Effect.gen(function* () {
      const desativado = {
        defaultModelSelection: GLOBAL,
        projectSettingsOverrides: {
          [PROJETO]: { providerInstances: { [GLOBAL.instanceId]: { enabled: false } } },
        },
      };
      assert.deepEqual(
        [
          yield* resolver(null),
          yield* resolver(PROJETO, { projetos: [] }),
          yield* resolver(PROJETO, { settings: { defaultModelSelection: null } }),
          yield* resolver(PROJETO, { settings: desativado }),
        ],
        [
          { type: "incomplete", reason: "no_project", projectTitle: null },
          { type: "incomplete", reason: "project_missing", projectTitle: null },
          { type: "incomplete", reason: "no_model", projectTitle: "Licitações" },
          { type: "incomplete", reason: "provider_disabled", projectTitle: "Licitações" },
        ],
      );
      const motivo = (c: Effect.Success<ReturnType<typeof ler>>) =>
        c.type === "indisponivel" ? c.motivo : "pronta";
      assert.include(motivo(yield* ler(null)), "Escolha");
      assert.include(motivo(yield* ler(PROJETO, { projetos: [] })), "não existe mais");
      assert.include(
        motivo(yield* ler(PROJETO, { settings: { defaultModelSelection: null } })),
        'modelo padrão para o projeto "Licitações"',
      );
      assert.include(motivo(yield* ler(PROJETO, { settings: desativado })), "desativado");
    }),
  );

  it.effect("projects that cannot be read are not a missing project", () =>
    Effect.gen(function* () {
      const erro = yield* Effect.flip(ler(PROJETO, { projetosIlegiveis: true }));
      assert.strictEqual(erro._tag, "EditaiiConfiguracaoIlegivel");
    }),
  );
});
