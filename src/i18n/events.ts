import { FLOW_STEPS, STEP_OUTCOMES } from '../events/index.js';
import { defineCatalogue } from './index.js';

const steps = FLOW_STEPS.join(', ');
const outcomes = STEP_OUTCOMES.join(', ');

export const eventMessages = defineCatalogue({
  en: {
    usage: 'briefstack event <step> <started|finished> --session <id> [--outcome <ok|skipped|failed>]',
    unknownStep: (step: string) => `Unknown flow step "${step}". Steps: ${steps}.`,
    unknownPhase: (phase: string) => `"${phase}" must be started or finished.`,
    unknownOutcome: (outcome: string) => `Unknown outcome "${outcome}". Use one of: ${outcomes}.`,
  },
  es: {
    usage: 'briefstack event <paso> <started|finished> --session <id> [--outcome <ok|skipped|failed>]',
    unknownStep: (step: string) => `Paso del flujo desconocido "${step}". Pasos: ${steps}.`,
    unknownPhase: (phase: string) => `"${phase}" debe ser started o finished.`,
    unknownOutcome: (outcome: string) => `Resultado desconocido "${outcome}". Usa uno de: ${outcomes}.`,
  },
});
