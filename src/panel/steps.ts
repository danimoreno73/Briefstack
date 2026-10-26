import type { Lang } from '../i18n/index.js';
import { stepMessages, stepName } from '../i18n/steps.js';
import { PANEL_STEPS, type PanelStepState } from './state.js';

/**
 * Where a creation is, as the panel shows it (backlog 2, B10). The panel's
 * "step 3 / 9" and the chat's `stepText` come from the same function, so the
 * chat quotes the step instead of guessing it from which agent runs.
 */

export interface StepPosition {
  /** 1-based, in `PANEL_STEPS`. */
  index: number;
  step: string;
}

/** "step 3 / 9" for the step running now or, between steps, the last one reached. */
export function stepPosition(steps: readonly { step: string; state: PanelStepState }[], current: string | undefined): StepPosition | undefined {
  const reached = current ?? [...steps].reverse().find((item) => item.state !== 'waiting')?.step;
  if (reached === undefined) return undefined;
  const index = (PANEL_STEPS as readonly string[]).indexOf(reached);
  return index === -1 ? undefined : { index: index + 1, step: reached };
}

/** What the creation waits for: a request in the browser, or a reply to its last message. */
export type StepWaitingFor = 'question' | 'permission' | 'spec' | 'grant' | 'reply';

export interface StepTextInput {
  steps: readonly { step: string; state: PanelStepState }[];
  /** The step open now, if the caller knows one (the manager's or a running step). */
  current: string | undefined;
  status: 'running' | 'finished' | 'interrupted';
  /** `completed`, `cancelled` or `failed`, once finished. */
  outcome?: string | undefined;
  waitingFor?: StepWaitingFor | undefined;
  cancelling?: boolean | undefined;
}

/**
 * One line for the chat: "Step 3 of 9: Interview — waiting for your
 * answers". The position and the name are the panel's; the rest says what
 * the creation does or waits for, or how it ended.
 */
export function stepText(input: StepTextInput, lang: Lang): string {
  const m = stepMessages[lang];
  const position = stepPosition(input.steps, input.current);
  const where = position === undefined ? m.noStep : m.position(position.index, PANEL_STEPS.length, stepName(position.step, lang));
  const what =
    input.status === 'finished'
      ? m.finished(input.outcome)
      : input.status === 'interrupted'
        ? m.interrupted
        : input.cancelling === true
          ? m.cancelling
          : input.waitingFor !== undefined
            ? m.waiting(input.waitingFor)
            : m.working;
  return `${where} — ${what}`;
}
