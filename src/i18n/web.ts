import { defineCatalogue } from './index.js';

export const webMessages = defineCatalogue({
  en: {
    usage: 'briefstack web [--port <n>]',
    listening: 'briefstack web is running. Open this address in your browser (Ctrl+C to stop):',
    stopped: 'briefstack web stopped.',
    sweptKilled: (pid: number) =>
      `A creation was still running from a briefstack web that did not stop cleanly: its Claude Code process (pid ${pid}) has been ended.`,
    sweptUnverified: (pid: number) =>
      `A creation from a briefstack web that did not stop cleanly names process ${pid}, which is running but could not be checked to be the same one. It was left alone: if it is Claude Code, end it yourself.`,
    sweptLive: (pid: number) =>
      `Another briefstack web on the same home is running a creation (Claude Code pid ${pid}); it was left alone.`,
    sweptClosed: (session: string) => `Session ${session} was closed as interrupted.`,
    crashed: (detail: string) =>
      `briefstack web hit an error it did not expect and is stopping; running creations are closed as interrupted.\n${detail}`,
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
    sweptKilled: (pid: number) =>
      `Una creación seguía en marcha de un briefstack web que no se paró bien: se ha terminado su proceso de Claude Code (pid ${pid}).`,
    sweptUnverified: (pid: number) =>
      `Una creación de un briefstack web que no se paró bien nombra el proceso ${pid}, que está en marcha pero no se ha podido comprobar que sea el mismo. No se ha tocado: si es Claude Code, termínalo tú.`,
    sweptLive: (pid: number) =>
      `Otro briefstack web con el mismo home tiene una creación en marcha (pid de Claude Code ${pid}); no se ha tocado.`,
    sweptClosed: (session: string) => `La sesión ${session} se ha cerrado como interrumpida.`,
    crashed: (detail: string) =>
      `briefstack web ha tenido un error inesperado y se está parando; las creaciones en marcha se cierran como interrumpidas.\n${detail}`,
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
