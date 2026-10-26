import { describe, expect, it } from 'vitest';
import { LANGS } from '../../src/i18n/index.js';
import { stepMessages } from '../../src/i18n/steps.js';
import { uiMessages } from '../../src/i18n/ui.js';
import { PANEL_STEPS, buildPanelState, type PanelEventInput, type PanelLive } from '../../src/panel/state.js';
import { stepPosition, stepText, type StepTextInput } from '../../src/panel/steps.js';

const T0 = Date.UTC(2026, 9, 26, 10, 0, 0);
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const flow = (s: number, type: string, extra: Partial<PanelEventInput> = {}): PanelEventInput => ({ ts: at(s), source: 'flow', type, ...extra });
const hook = (s: number, type: string): PanelEventInput => ({ ts: at(s), source: 'hook', type });

const START = [flow(0, 'session.started'), flow(1, 'step.started', { step: 'idea' }), flow(2, 'step.finished', { step: 'idea', outcome: 'ok' })];
const INTERVIEW_OPEN = [...START, flow(3, 'step.started', { step: 'gap-analysis' }), flow(4, 'step.finished', { step: 'gap-analysis', outcome: 'ok' }), flow(5, 'step.started', { step: 'interview' })];

/** The panel's state, and the input the chat's tools build from it (`stepTextOf` in `src/chat/tools.ts`). */
function scene(events: PanelEventInput[], live?: PanelLive, extra: Partial<StepTextInput> = {}) {
  const state = buildPanelState(events, { now: new Date(T0 + 60_000), ...(live === undefined ? {} : { live }) });
  const current = state.steps.find((item) => item.state === 'running')?.step;
  const input: StepTextInput = { steps: state.steps, current, status: state.session.status, outcome: state.session.outcome, ...extra };
  return { state, current, input };
}

const SCENES = {
  open: scene(INTERVIEW_OPEN, { finished: false }),
  between: scene([...INTERVIEW_OPEN, flow(6, 'step.finished', { step: 'interview', outcome: 'ok' })], { finished: false }),
  waiting: scene(INTERVIEW_OPEN, { finished: false, pending: { id: 'p1', kind: 'question' } }, { waitingFor: 'question' }),
  finished: scene([...INTERVIEW_OPEN, flow(6, 'step.finished', { step: 'interview', outcome: 'skipped' }), flow(7, 'session.finished', { outcome: 'cancelled' })]),
  interrupted: scene([...INTERVIEW_OPEN, hook(6, 'session.end')]),
};

describe('stepText', () => {
  for (const lang of LANGS) {
    const t = uiMessages[lang];
    for (const [name, { state, current, input }] of Object.entries(SCENES)) {
      it(`names the step the panel shows (${name}, ${lang})`, () => {
        const position = stepPosition(state.steps, current);
        if (position === undefined) throw new Error('no position');
        // The panel's "step n / 9" comes from the same position, and its segment shows the same name.
        expect(stepText(input, lang)).toContain(stepMessages[lang].position(position.index, PANEL_STEPS.length, t.stepLabel(position.step)));
      });
    }
  }

  it('says what the creation does, waits for or how it ended', () => {
    expect(stepText(SCENES.open.input, 'en')).toBe('Step 3 of 9: Interview — working');
    expect(stepText(SCENES.between.input, 'en')).toBe('Step 3 of 9: Interview — working');
    expect(stepText(SCENES.waiting.input, 'en')).toBe('Step 3 of 9: Interview — waiting for your answers');
    expect(stepText(SCENES.finished.input, 'en')).toBe('Step 3 of 9: Interview — finished, cancelled');
    expect(stepText(SCENES.interrupted.input, 'en')).toBe('Step 3 of 9: Interview — interrupted');
    expect(stepText(SCENES.waiting.input, 'es')).toBe('Paso 3 de 9: Entrevista — esperando tus respuestas');
    expect(stepText(SCENES.finished.input, 'es')).toBe('Paso 3 de 9: Entrevista — terminada, cancelada');
    expect(stepText({ ...SCENES.open.input, cancelling: true, waitingFor: 'question' }, 'en')).toBe('Step 3 of 9: Interview — cancelling');
    expect(stepText({ ...SCENES.open.input, waitingFor: 'reply' }, 'es')).toBe('Paso 3 de 9: Entrevista — esperando tu respuesta');
  });

  it('between steps, keeps the last step reached, as the panel does', () => {
    expect(SCENES.between.current).toBeUndefined();
    expect(stepPosition(SCENES.between.state.steps, undefined)).toEqual({ index: 3, step: 'interview' });
  });

  it('prefers the step the manager knows open over the recorded ones', () => {
    expect(stepText({ ...SCENES.between.input, current: 'research' }, 'en')).toBe('Step 4 of 9: Research — working');
  });

  it('before the first step, says none started', () => {
    const { input } = scene([flow(0, 'session.started')], { finished: false });
    expect(stepText(input, 'en')).toBe('No step started yet — working');
    expect(stepText(input, 'es')).toBe('Aún no ha empezado ningún paso — trabajando');
  });

  it('has the same step names in both languages', () => {
    for (const lang of LANGS) expect(Object.keys(stepMessages[lang].labels)).toEqual([...PANEL_STEPS]);
  });
});
