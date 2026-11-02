import type { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";

import type { AnswerPlan } from "./EditaiiT3Adapter.ts";
import * as Protocol from "./EditaiiProtocol.ts";

/**
 * A T3 question as the Editaii received it, frozen when the intervention opens. Question and
 * option ids are ours (`p1`, `1`), so any T3 id or label fits the Editaii's rules, and each maps
 * back to the T3 question id and the exact option value, spaces included.
 */
export const Traducao = Schema.Struct({
  versao: Schema.Literal(1),
  perguntas: Schema.NonEmptyArray(Protocol.Pergunta),
  destinos: Schema.Record(
    Schema.String,
    Schema.Struct({
      questionId: Schema.String,
      valores: Schema.Record(Schema.String, Schema.String),
    }),
  ),
});
export type Traducao = typeof Traducao.Type;

export type T3Answers = AnswerPlan["answers"];

export function translateQuestions(
  questions: readonly [OrchestrationV2UserInputQuestion, ...OrchestrationV2UserInputQuestion[]],
): Traducao {
  const perguntas = Arr.map(questions, (q, i) => ({
    id: `p${i + 1}`,
    titulo: q.header,
    pergunta: q.question,
    opcoes: q.options.map((o, j) => ({
      id: `${j + 1}`,
      rotulo: o.label,
      descricao: o.description,
    })),
    multipla: q.multiSelect ?? false,
    // T3 allows the person's own words unless the question says otherwise; without options they are the only answer.
    livre: (q.allowCustomAnswer ?? true) || q.options.length === 0,
  }));
  const destinos = Object.fromEntries(
    questions.map((q, i) => [
      `p${i + 1}`,
      {
        questionId: q.id,
        valores: Object.fromEntries(q.options.map((o, j) => [`${j + 1}`, o.value ?? o.label])),
      },
    ]),
  );
  return { versao: 1, perguntas, destinos };
}

/**
 * The T3 answers for the Editaii's answers to a frozen question set, or null when they do not fit
 * it (the Worker validates them against the same questions, so null means a broken contract).
 */
export function answersFor(traducao: Traducao, respostas: Protocol.Respostas): T3Answers | null {
  const answers: Array<[string, T3Answers[string]]> = [];
  for (const pergunta of traducao.perguntas) {
    const resposta = Object.hasOwn(respostas, pergunta.id) ? respostas[pergunta.id] : undefined;
    const destino = traducao.destinos[pergunta.id];
    if (resposta === undefined || destino === undefined) return null;
    if ("texto" in resposta) {
      if (!pergunta.livre) return null;
      answers.push([destino.questionId, resposta.texto]);
      continue;
    }
    const valores = resposta.opcoes.map((id) =>
      Object.hasOwn(destino.valores, id) ? destino.valores[id] : undefined,
    );
    if (valores.some((v) => v === undefined)) return null;
    const escolhidos = valores.filter((v): v is string => v !== undefined);
    const [unico] = escolhidos;
    if (pergunta.multipla) answers.push([destino.questionId, escolhidos]);
    else if (unico !== undefined && escolhidos.length === 1)
      answers.push([destino.questionId, unico]);
    else return null;
  }
  return Object.fromEntries(answers);
}
