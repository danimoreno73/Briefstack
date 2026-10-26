import { defineCatalogue, type Lang } from './index.js';

/**
 * The flow steps' names and the chat's one-line account of where a creation
 * is (`stepText` in `src/panel/steps.ts`). Pure module: the web UI and the
 * chat's tools import the same names, so the chat quotes what the panel
 * shows.
 */
export const stepMessages = defineCatalogue({
  en: {
    labels: {
      idea: 'Idea',
      'gap-analysis': 'Gap analysis',
      interview: 'Interview',
      research: 'Research',
      spec: 'Spec',
      generate: 'Generate',
      'validate-review': 'Validate and review',
      learn: 'Learn',
      handoff: 'Hand-off',
    } as Record<string, string>,
    position: (index: number, total: number, name: string) => `Step ${index} of ${total}: ${name}`,
    noStep: 'No step started yet',
    working: 'working',
    waiting: (kind: string): string => {
      const labels: Record<string, string> = {
        question: 'waiting for your answers',
        permission: 'waiting for you to allow or deny an action',
        spec: 'waiting for you to approve the spec',
        grant: 'waiting for you to grant an output folder',
        reply: 'waiting for your reply',
      };
      return labels[kind] ?? 'waiting for you';
    },
    cancelling: 'cancelling',
    interrupted: 'interrupted',
    finished: (outcome: string | undefined): string => {
      const labels: Record<string, string> = {
        completed: 'finished, completed',
        cancelled: 'finished, cancelled',
        failed: 'finished, failed',
      };
      return labels[outcome ?? 'completed'] ?? 'finished';
    },
  },
  es: {
    labels: {
      idea: 'Idea',
      'gap-analysis': 'Análisis de huecos',
      interview: 'Entrevista',
      research: 'Investigación',
      spec: 'Spec',
      generate: 'Generación',
      'validate-review': 'Validación y revisión',
      learn: 'Aprendizaje',
      handoff: 'Entrega',
    } as Record<string, string>,
    position: (index: number, total: number, name: string) => `Paso ${index} de ${total}: ${name}`,
    noStep: 'Aún no ha empezado ningún paso',
    working: 'trabajando',
    waiting: (kind: string): string => {
      const labels: Record<string, string> = {
        question: 'esperando tus respuestas',
        permission: 'esperando a que permitas o deniegues una acción',
        spec: 'esperando a que apruebes la spec',
        grant: 'esperando a que concedas una carpeta de salida',
        reply: 'esperando tu respuesta',
      };
      return labels[kind] ?? 'esperándote';
    },
    cancelling: 'cancelando',
    interrupted: 'interrumpida',
    finished: (outcome: string | undefined): string => {
      const labels: Record<string, string> = {
        completed: 'terminada, completada',
        cancelled: 'terminada, cancelada',
        failed: 'terminada, fallida',
      };
      return labels[outcome ?? 'completed'] ?? 'terminada';
    },
  },
});

/** A step's name as the panel shows it; an unknown id as it is. */
export function stepName(step: string, lang: Lang): string {
  return stepMessages[lang].labels[step] ?? step;
}
