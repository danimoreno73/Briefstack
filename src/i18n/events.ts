import { FLOW_STEPS } from '../events/index.js';
import { defineCatalogue } from './index.js';

const steps = ['session', ...FLOW_STEPS].join(', ');

export const eventMessages = defineCatalogue({
  en: {
    usage:
      'briefstack event <session|step> <started|finished> --session <id> [--outcome <outcome>]',
    unknownStep: (step: string) => `Unknown flow step "${step}". Steps: ${steps}.`,
    unknownPhase: (phase: string) => `"${phase}" must be started or finished.`,
    unknownOutcome: (outcome: string, allowed: readonly string[]) =>
      `Unknown outcome "${outcome}". Use one of: ${allowed.join(', ')}.`,
  },
  es: {
    usage:
      'briefstack event <session|paso> <started|finished> --session <id> [--outcome <resultado>]',
    unknownStep: (step: string) => `Paso del flujo desconocido "${step}". Pasos: ${steps}.`,
    unknownPhase: (phase: string) => `"${phase}" debe ser started o finished.`,
    unknownOutcome: (outcome: string, allowed: readonly string[]) =>
      `Resultado desconocido "${outcome}". Usa uno de: ${allowed.join(', ')}.`,
  },
});
