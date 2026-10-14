import { defineCatalogue } from './index.js';

export const webMessages = defineCatalogue({
  en: {
    usage: 'briefstack web [--port <n>]',
    listening: 'briefstack web is running. Open this address in your browser (Ctrl+C to stop):',
    stopped: 'briefstack web stopped.',
    claudeNotFound:
      'Warning: Claude Code was not found (claude on PATH or in ~/.local/bin). You can browse, but creating a project will not work.',
    claudeOlder: (installed: string, expected: string) =>
      `Warning: Claude Code ${installed} is older than the ${expected} this version of briefstack was built for. Update Claude Code before creating a project.`,
    claudeUntested: (installed: string, expected: string) =>
      `Warning: Claude Code ${installed} has not been tested with this version of briefstack (built for ${expected}). Creating a project may fail.`,
    claudeUnknownVersion: (executable: string) =>
      `Warning: could not read the version of ${executable}. Creating a project may fail.`,
  },
  es: {
    usage: 'briefstack web [--port <n>]',
    listening: 'briefstack web está en marcha. Abre esta dirección en el navegador (Ctrl+C para pararlo):',
    stopped: 'briefstack web se ha parado.',
    claudeNotFound:
      'Aviso: no se encuentra Claude Code (claude en el PATH o en ~/.local/bin). Puedes navegar, pero crear un proyecto no funcionará.',
    claudeOlder: (installed: string, expected: string) =>
      `Aviso: Claude Code ${installed} es más antiguo que la versión ${expected} para la que se hizo esta versión de briefstack. Actualiza Claude Code antes de crear un proyecto.`,
    claudeUntested: (installed: string, expected: string) =>
      `Aviso: Claude Code ${installed} no se ha probado con esta versión de briefstack (hecha para ${expected}). Crear un proyecto podría fallar.`,
    claudeUnknownVersion: (executable: string) =>
      `Aviso: no se ha podido leer la versión de ${executable}. Crear un proyecto podría fallar.`,
  },
});
