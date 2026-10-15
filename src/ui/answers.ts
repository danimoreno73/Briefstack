import type { UiQuestion } from './types.js';

/** What the user has picked for one question: option indexes, plus their own text. */
export interface Selection {
  picked: number[];
  own: string;
}

const RECOMMENDED = /\(recommended\)|\(recomendad[oa]\)/i;

/** The recommended option, marked in its label; else the first one. */
export function recommendedIndex(question: UiQuestion): number {
  const marked = question.options.findIndex((option) => RECOMMENDED.test(option.label));
  return marked === -1 ? 0 : marked;
}

export function defaultSelection(question: UiQuestion): Selection {
  return { picked: question.options.length === 0 ? [] : [recommendedIndex(question)], own: '' };
}

/**
 * The answer the server expects: the user's own text when they wrote any, else
 * the label of the picked option, or the labels joined by ", " when several can be picked.
 * `undefined` when nothing is chosen.
 */
export function answerFor(question: UiQuestion, selection: Selection): string | undefined {
  const own = selection.own.trim();
  if (own !== '') return own;
  const labels = [...selection.picked]
    .sort((a, b) => a - b)
    .map((index) => question.options[index]?.label)
    .filter((label): label is string => label !== undefined);
  if (labels.length === 0) return undefined;
  return question.multiSelect ? labels.join(', ') : (labels[0] as string);
}

/** Every question answered, keyed by question text; `undefined` while any is still open. */
export function answersFor(questions: readonly UiQuestion[], selections: readonly Selection[]): Record<string, string> | undefined {
  const answers: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    const selection = selections[index];
    const answer = selection === undefined ? undefined : answerFor(question, selection);
    if (answer === undefined) return undefined;
    answers[question.question] = answer;
  }
  return answers;
}
