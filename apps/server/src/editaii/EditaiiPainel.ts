/**
 * The Editaii panel of this T3: what it shows, read together and kept current, and the one way
 * to end a link or a pairing attempt the person saw. The RPC only carries it.
 */
import type {
  EditaiiActivity,
  EditaiiConfiguration,
  EditaiiDisconnectInput,
  EditaiiJobState,
  EditaiiJournalProblem,
  EditaiiLink,
  EditaiiPanel,
  ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Configuracao from "./EditaiiConfiguracao.ts";
import * as Connection from "./EditaiiConnection.ts";
import * as Connector from "./EditaiiConnector.ts";
import * as Journal from "./EditaiiJournal.ts";

/** How long to wait before following the T3's project changes again after they failed. */
const PAUSA = Duration.seconds(5);

export class EditaiiPainel extends Context.Service<
  EditaiiPainel,
  {
    /**
     * The panel now, then again after each change that can alter it: the connection, the
     * connector's problem, the journal, the T3 settings and projects. Changes that come while it
     * is read are coalesced into one more read, so it stays current under steady activity. A
     * part that cannot be read is shown as such; the rest still is.
     */
    readonly estado: Stream.Stream<EditaiiPanel>;
    /**
     * Ends what the person chose: the connected link (see EditaiiConnector.desligar) or the
     * pairing attempt. Anything else by now is `not_current`, left as it is. A journal error
     * means the intent to abandon the link was not recorded, so nothing was disconnected.
     */
    readonly desligar: (
      alvo: typeof EditaiiDisconnectInput.Type.target,
    ) => Effect.Effect<
      "disconnected" | "not_current",
      Journal.EditaiiJournalError | Connection.EditaiiConnectionError
    >;
  }
>()("t3/editaii/EditaiiPainel") {}

const linkDo = (v: Connection.EditaiiVinculo): EditaiiLink => ({
  origin: v.origem,
  machineId: v.maquina,
  environmentId: v.ambiente,
});

const ESTADO: Record<Journal.EstadoTrabalho, typeof EditaiiJobState.Type> = {
  entregue: "delivered",
  em_execucao: "running",
  aguardando_pessoa: "waiting_for_person",
  acao_no_t3: "action_in_t3",
  concluido: "completed",
  falhou: "failed",
  parado: "stopped",
};

const atividade = (v: Connection.EditaiiVinculo, s: Journal.Situacao): EditaiiActivity => ({
  type: "available",
  link: linkDo(v),
  abandoning: s.desligando,
  jobs: s.trabalhos.map((t) => ({
    jobId: t.trabalhoId,
    conversationId: t.conversaId,
    threadId: t.threadId,
    state: ESTADO[t.estado],
    pendingEvents: t.eventosPendentes,
    held: t.retido,
    receiptPending: t.reciboPendente,
  })),
  blockedConversations: s.conversasBloqueadas.map((c) => ({
    conversationId: c.conversaId,
    threadId: c.threadId,
    reason: c.bloqueio === "conflito" ? "conflict" : "thread_lost",
  })),
});

const make = Effect.gen(function* () {
  const connection = yield* Connection.EditaiiConnection;
  const connector = yield* Connector.EditaiiConnector;
  const journal = yield* Journal.EditaiiJournal;
  const settings = yield* ServerSettings.ServerSettingsService;
  const eventos = yield* OrchestrationEventStore.OrchestrationEventStore;
  const contexto = yield* Effect.context<
    ProjectService.ProjectService | ServerSettings.ServerSettingsService
  >();
  const configuracao = (projectId: ProjectId | null) =>
    Configuracao.resolver(projectId).pipe(
      Effect.provide(contexto),
      Effect.catchTags({
        EditaiiConfiguracaoIlegivel: (error) =>
          Effect.logWarning("Editaii panel could not read the T3 settings", error).pipe(
            Effect.as<EditaiiConfiguration>({ type: "unavailable", reason: "read_error" }),
          ),
      }),
    );

  /** One reading of the whole panel; activity and configuration follow this one connection state. */
  const ler = Effect.fn("EditaiiPainel.ler")(function* (problema: EditaiiJournalProblem | null) {
    const estado = yield* connection.state;
    const v = Connection.vinculoDo(estado);
    const activity =
      v === null
        ? null
        : yield* journal.situacao(v).pipe(
            Effect.map((s) => atividade(v, s)),
            Effect.catchTags({
              EditaiiJournalError: (error) =>
                Effect.succeed<EditaiiActivity>({
                  type: "unavailable",
                  link: linkDo(v),
                  reason: error.reason,
                }),
            }),
          );
    return {
      connection: estado,
      configuration: yield* configuracao(estado.projectId),
      connector: { journal: problema },
      activity,
    } satisfies EditaiiPanel;
  });

  const estado = Stream.unwrap(
    Effect.gen(function* () {
      const invalidacoes = yield* Queue.sliding<void>(1);
      const invalidar = Queue.offer(invalidacoes, undefined).pipe(Effect.asVoid);
      const problema = yield* Ref.make<EditaiiJournalProblem | null>(null);
      // Each source signals once it is followed, so a change before that is read after it.
      const seguir = <A, E>(fonte: Stream.Stream<A, E>, antes: (a: A) => Effect.Effect<void>) =>
        fonte.pipe(
          Stream.runForEach((a) => antes(a).pipe(Effect.andThen(invalidar))),
          Effect.forkScoped,
        );
      yield* seguir(connection.changes, () => Effect.void);
      yield* seguir(connector.problema, (p) => Ref.set(problema, p));
      yield* seguir(journal.mudancas, () => Effect.void);
      yield* seguir(yield* settings.subscribeChanges, () => Effect.void);
      // A project renamed or deleted; followed from the sequence read before the signal.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const desde = yield* eventos.latestApplicationSequence;
          yield* invalidar;
          yield* eventos.streamApplicationEvents({ afterSequence: desde }).pipe(
            Stream.filter((e) => "aggregateKind" in e && e.aggregateKind === "project"),
            Stream.runForEach(() => invalidar),
          );
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Editaii panel stopped following T3 projects; retrying", error).pipe(
              Effect.andThen(Effect.sleep(PAUSA)),
            ),
          ),
          Effect.forever,
        ),
      );
      return Stream.fromQueue(invalidacoes).pipe(
        Stream.mapEffect(() => Ref.get(problema).pipe(Effect.flatMap(ler))),
      );
    }),
  );

  const desligar = Effect.fn("EditaiiPainel.desligar")(function* (
    alvo: typeof EditaiiDisconnectInput.Type.target,
  ) {
    const feito =
      alvo.type === "link"
        ? yield* connector.desligar({
            origem: alvo.origin,
            maquina: alvo.machineId,
            ambiente: alvo.environmentId,
          })
        : yield* connection.cancelPairing(alvo.attempt);
    return feito ? ("disconnected" as const) : ("not_current" as const);
  });

  return EditaiiPainel.of({ estado, desligar });
});

export const layer = Layer.effect(EditaiiPainel, make);
