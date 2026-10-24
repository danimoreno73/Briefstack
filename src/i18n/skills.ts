import { defineCatalogue } from './index.js';

/** `briefstack skills …` output, and the text `skills install` adds to a `claude-app` project's NEXT_STEPS.md. */
export const skillsMessages = defineCatalogue({
  en: {
    usage: 'briefstack skills install <project-dir> [--skill <name>] [--json]',
    installed: (name: string, location: string, commit: string) => `Installed ${name} in ${location} (commit ${commit.slice(0, 7)}).`,
    already: (name: string) => `${name} was already installed.`,
    nothing: 'No library skills to install.',
    nextStepsTitle: 'Next steps',
    nextStepsHeading: 'Skills',
    nextStepsIntro:
      'Skills from your library come as ZIP files in `skills/`. To add one in the Claude app: turn on "Code execution and file creation" in Settings > Capabilities, then open Customize > Skills, press "+", choose "Create skill", then "Upload a skill", and pick the ZIP. The skill then shows in your list with a switch to turn it on.',
    nextStepsLine: (location: string, name: string, description: string) =>
      `- \`${location}\`: ${name}${description === '' ? '' : `. ${description.length > 200 ? `${description.slice(0, 199)}…` : description}`}`,
  },
  es: {
    usage: 'briefstack skills install <carpeta-del-proyecto> [--skill <nombre>] [--json]',
    installed: (name: string, location: string, commit: string) => `Instalada ${name} en ${location} (commit ${commit.slice(0, 7)}).`,
    already: (name: string) => `${name} ya estaba instalada.`,
    nothing: 'No hay skills de la biblioteca que instalar.',
    nextStepsTitle: 'Próximos pasos',
    nextStepsHeading: 'Skills',
    nextStepsIntro:
      'Las skills de tu biblioteca vienen como archivos ZIP en `skills/`. Para añadir una en la app de Claude (los nombres de los menús, como aparecen en inglés): activa "Code execution and file creation" en Settings > Capabilities, abre Customize > Skills, pulsa "+", elige "Create skill", luego "Upload a skill", y selecciona el ZIP. La skill aparece entonces en tu lista con un interruptor para activarla.',
    nextStepsLine: (location: string, name: string, description: string) =>
      `- \`${location}\`: ${name}${description === '' ? '' : `. ${description.length > 200 ? `${description.slice(0, 199)}…` : description}`}`,
  },
});
