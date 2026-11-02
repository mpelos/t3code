/**
 * Carries Editaii work to the T3 and the T3's facts back, for the connected machine. It
 * coordinates I/O only: every decision is a journal transition (EditaiiJournal.ts), and every
 * T3 effect goes through the adapter (EditaiiT3Adapter.ts). How it works, its guarantees and
 * limits: docs/conector-t3.md in the editaii repository.
 */
import type { EditaiiJournalProblem } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { forkParked } from "../serverActivation.ts";
import * as Connection from "./EditaiiConnection.ts";
import * as Journal from "./EditaiiJournal.ts";
import type * as Protocol from "./EditaiiProtocol.ts";
import * as Adapter from "./EditaiiT3Adapter.ts";

/** How long to wait for the Worker to have work again, or to retry a call that did not land. */
const PAUSA = Duration.seconds(5);

export class EditaiiConnector extends Context.Service<
  EditaiiConnector,
  {
    /**
     * Abandons the expected link. The intent is durable first: from then on nothing of that link
     * starts or is sent, also after a restart. Then the link is disconnected, which stops its
     * work and waits for it, unless another link is connected by now: then the result is false
     * and that link is left as it is. Never waits on the network.
     */
    readonly desligar: (
      vinculo: Connection.EditaiiVinculo,
    ) => Effect.Effect<boolean, Journal.EditaiiJournalError | Connection.EditaiiConnectionError>;
    /**
     * The journal problem that stopped the last connected period, until one starts again: the
     * connector does nothing meanwhile. Emits the current value first.
     */
    readonly problema: Stream.Stream<EditaiiJournalProblem | null>;
  }
>()("t3/editaii/EditaiiConnector") {}

const desfechoDaResposta = (resultado: Adapter.AnswerResult): Journal.Desfecho => {
  switch (resultado.type) {
    case "accepted":
      return { tipo: "respondida", comando: resultado.commandId };
    case "superseded":
      return { tipo: "superada" };
    case "not_resumable":
      return { tipo: "nao_retomavel" };
    case "unknown":
      return { tipo: "incerta" };
  }
};

/**
 * `configuracao` says how a new conversation's thread runs, read when a request starts one.
 */
const make = Effect.fn("EditaiiConnector.make")(function* <R>(
  configuracao: Effect.Effect<Journal.Configuracao, Journal.EditaiiConfiguracaoIlegivel, R>,
) {
  const lerConfiguracao = Effect.provide(configuracao, yield* Effect.context<R>());
  const connection = yield* Connection.EditaiiConnection;
  const journal = yield* Journal.EditaiiJournal;
  const adapter = yield* Adapter.EditaiiT3Adapter;
  // A link the session found abandoned; it is disconnected from outside the session's work.
  const abandonado = yield* Ref.make<Connection.EditaiiVinculo | null>(null);
  const problema = yield* SubscriptionRef.make<EditaiiJournalProblem | null>(null);

  /** Retries what did not land until it does; the session's end interrupts the wait. */
  const insistir = <A, E>(efeito: Effect.Effect<A, E>): Effect.Effect<A> =>
    efeito.pipe(
      Effect.catch(() =>
        Effect.sleep(PAUSA).pipe(Effect.andThen(Effect.suspend(() => insistir(efeito)))),
      ),
    );

  /** Invokes the T3 for a delivery the journal says was not invoked yet. */
  const executar = (execucao: Journal.Execucao): Effect.Effect<Journal.Desfecho> =>
    execucao.tipo === "pedido"
      ? adapter.accept(execucao.plano).pipe(
          Effect.map((aceitacao): Journal.Desfecho => ({ tipo: "aceita", aceitacao })),
          Effect.catchTags({
            EditaiiT3AcceptRefused: () => Effect.succeed<Journal.Desfecho>({ tipo: "recusada" }),
            EditaiiT3ThreadMissing: () =>
              Effect.succeed<Journal.Desfecho>({ tipo: "thread_ausente" }),
            EditaiiT3AcceptUnknown: () => Effect.succeed<Journal.Desfecho>({ tipo: "incerta" }),
          }),
        )
      : adapter.respond(execucao.plano).pipe(Effect.map(desfechoDaResposta));

  /** The T3 was invoked and the outcome is unknown: only reading may decide, never invoking again. */
  const inspecionar = (execucao: Journal.Execucao): Effect.Effect<Journal.Desfecho> =>
    insistir(
      execucao.tipo === "pedido"
        ? adapter
            .inspect(execucao.plano, null)
            .pipe(
              Effect.map((i): Journal.Desfecho =>
                i.type === "found"
                  ? { tipo: "aceita", aceitacao: i.acceptance }
                  : { tipo: "incerta" },
              ),
            )
        : adapter
            .inspectAnswer(execucao.plano)
            .pipe(
              Effect.map((i): Journal.Desfecho =>
                i.type === "found"
                  ? { tipo: "respondida", comando: i.commandId }
                  : { tipo: "incerta" },
              ),
            ),
    );

  /**
   * The work of one connected period. Its loops and followers run together; a journal failure in
   * any of them ends the period, and the next one starts again from the journal.
   */
  const sessao = Effect.fn("EditaiiConnector.session")(function* (
    session: Connection.EditaiiSession,
  ) {
    const v = session.vinculo;
    const partida = yield* journal.partida(v);
    yield* SubscriptionRef.set(problema, null);
    if (partida.type === "desligar") {
      yield* Ref.set(abandonado, v);
      return;
    }
    const tarefas = yield* FiberSet.make<void, Journal.EditaiiJournalError>();
    // The outbox wakes when there may be something to send; the deliveries, when something went.
    const acordar = yield* Queue.sliding<void>(1);
    const avisar = Queue.offer(acordar, undefined).pipe(Effect.asVoid);
    const enviou = yield* Queue.sliding<void>(1);

    /** Follows one confirmed job until it ends here, resuming after the last applied fact. */
    const seguir = Effect.fn("EditaiiConnector.follow")(function* (observado: Journal.Observado) {
      let cursor = observado.cursor;
      for (;;) {
        const fim = yield* adapter.observe(observado.aceitacao, cursor ?? undefined).pipe(
          Stream.mapEffect((o) =>
            journal.observar(v, observado.trabalhoId, o).pipe(
              Effect.tap(() => {
                cursor = o.sequence;
                return avisar;
              }),
            ),
          ),
          Stream.takeUntil((r) => r === "fim"),
          Stream.runLast,
          Effect.map((ultimo) => Option.contains(ultimo, "fim")),
          Effect.catchTags({ EditaiiT3ReadError: () => Effect.succeed(false) }),
        );
        if (fim) return;
        yield* Effect.sleep(PAUSA);
      }
    });
    const acompanhar = (observado: Journal.Observado) =>
      FiberSet.run(tarefas, seguir(observado)).pipe(Effect.asVoid);

    /** Sends the receipt until the Worker takes it or refuses it, and records which. */
    const confirmar = Effect.fn("EditaiiConnector.confirm")(function* (
      entregaId: string,
      recibo: Parameters<Connection.EditaiiSession["confirmar"]>[1],
    ) {
      const resultado = yield* insistir(
        session.confirmar(entregaId, recibo).pipe(
          Effect.as("ok" as const),
          Effect.catchIf(
            (e) => e.reason === "conflict",
            () => Effect.succeed("conflito" as const),
          ),
        ),
      );
      const observado = yield* journal.confirmada(v, entregaId, resultado);
      if (observado !== null) yield* acompanhar(observado);
    });

    /**
     * Takes a delivery through the journal's steps to where only the Worker can move it. Says
     * whether it settled without a receipt, in which case the Worker serves it again until the
     * events it owes reach it.
     */
    const conduzir = Effect.fn("EditaiiConnector.drive")(function* (entrega: Protocol.Entrega) {
      // Settings that cannot be read leave the delivery unrecorded; it is received again.
      const receber: Effect.Effect<Journal.Passo, Journal.EditaiiJournalError> = journal
        .receber(v, entrega, lerConfiguracao)
        .pipe(
          Effect.catchTags({
            EditaiiConfiguracaoIlegivel: (erro) =>
              Effect.logWarning("Editaii could not read the T3 settings; retrying", erro).pipe(
                Effect.andThen(Effect.sleep(PAUSA)),
                Effect.andThen(Effect.suspend(() => receber)),
              ),
          }),
        );
      let passo = yield* receber;
      for (;;) {
        switch (passo.type) {
          case "aguardar":
            return true;
          case "confirmar":
            yield* confirmar(passo.entregaId, passo.recibo);
            return false;
          case "conferir":
            yield* seguir(passo.observado);
            passo = yield* receber;
            break;
          case "executar":
            passo = yield* journal.resolver(
              v,
              passo.execucao.entregaId,
              yield* executar(passo.execucao),
            );
            break;
          case "inspecionar":
            passo = yield* journal.resolver(
              v,
              passo.execucao.entregaId,
              yield* inspecionar(passo.execucao),
            );
            break;
        }
      }
    });

    const entregas = Effect.gen(function* () {
      for (;;) {
        const entrega = yield* insistir(session.proxima);
        if (entrega === null) {
          yield* Effect.sleep(PAUSA);
          continue;
        }
        const semRecibo = yield* conduzir(entrega);
        // What the delivery's outcome owes the Worker goes now, not at the next poll.
        yield* avisar;
        if (semRecibo) {
          yield* Queue.take(enviou).pipe(
            Effect.timeoutOrElse({ duration: PAUSA, orElse: () => Effect.void }),
          );
        }
      }
    });

    const enviar = Effect.gen(function* () {
      for (;;) {
        const evento = yield* journal.proximoEvento(v);
        if (evento === null) {
          yield* Queue.take(acordar);
          continue;
        }
        const resultado = yield* session.eventos([evento]).pipe(
          Effect.as("ok" as const),
          Effect.catchIf(
            (e) => e.reason === "conflict",
            () => Effect.succeed("conflito" as const),
          ),
          Effect.catch(() => Effect.sleep(PAUSA).pipe(Effect.as("repetir" as const))),
        );
        if (resultado === "repetir") continue;
        yield* journal.eventoEnviado(v, evento, resultado);
        yield* Queue.offer(enviou, undefined);
      }
    });

    // A receipt the Worker does not take yet holds back new deliveries, not the jobs already running.
    for (const observado of partida.observar) yield* acompanhar(observado);
    yield* FiberSet.run(tarefas, enviar);
    yield* FiberSet.run(
      tarefas,
      Effect.gen(function* () {
        for (const { entregaId, recibo } of partida.confirmar) yield* confirmar(entregaId, recibo);
        return yield* entregas;
      }),
    );
    return yield* FiberSet.join(tarefas);
  });

  const abandonar = Effect.gen(function* () {
    const v = yield* Ref.getAndSet(abandonado, null);
    if (v !== null) yield* connection.disconnect(v);
  });

  // One connected period after another; a failed one is logged and the next starts after a pause.
  yield* forkParked(
    connection.withSession(sessao).pipe(
      Effect.andThen(abandonar),
      Effect.catch((error) =>
        Effect.logError("Editaii connector stopped; retrying", error).pipe(
          Effect.andThen(
            error._tag === "EditaiiJournalError"
              ? SubscriptionRef.set(problema, error.reason)
              : Effect.void,
          ),
          Effect.andThen(Effect.sleep(PAUSA)),
        ),
      ),
      Effect.forever,
    ),
  );

  const desligar = Effect.fn("EditaiiConnector.desligar")(function* (
    vinculo: Connection.EditaiiVinculo,
  ) {
    // Once the intent is written, the disconnect completes even if the caller goes away.
    return yield* journal
      .desligar(vinculo)
      .pipe(Effect.andThen(connection.disconnect(vinculo)), Effect.uninterruptible);
  });

  return EditaiiConnector.of({ desligar, problema: SubscriptionRef.changes(problema) });
});

export const layer = <R>(
  configuracao: Effect.Effect<Journal.Configuracao, Journal.EditaiiConfiguracaoIlegivel, R>,
) => Layer.effect(EditaiiConnector, make(configuracao));
