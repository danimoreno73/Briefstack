import { defineCatalogue } from './index.js';

export const webMessages = defineCatalogue({
  en: {
    usage: 'briefstack web [--port <n>] [--server --allowed-hosts <name:port,...> --access-secret-file <path> [--listen <address>]]',
    listening: 'briefstack web is running. Open this address in your browser (Ctrl+C to stop):',
    serverListening: 'briefstack web is running in server mode. Open this address and sign in with the access secret:',
    serverWarning: (listen: string, port: number, names: readonly string[]) =>
      `Warning: server mode. briefstack listens on ${listen}:${port} and accepts only these names besides 127.0.0.1 and localhost: ${names.join(', ')}. Publish its port on the host's 127.0.0.1 only and reach it through your own private network.`,
    serverSecretOpen: 'Warning: the access secret file can be read by other users of this system. Make it readable by its owner only (chmod 600).',
    buildsResumed: (count: number) => (count === 1 ? 'One build the restart interrupted resumes by itself (Settings: builds resume after a restart).' : `${count} builds the restart interrupted resume by themselves (Settings: builds resume after a restart).`),
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
      'Warning: Claude Code was not found (claude on PATH or in ~/.local/bin). Install it (https://code.claude.com/docs/en/setup), run `claude` once to sign in, then start briefstack web again. You can browse meanwhile, but creating a project will not work.',
    claudeOlder: (installed: string, expected: string) =>
      `Warning: Claude Code ${installed} is older than the ${expected} this version of briefstack was built for. Update it with \`claude update\`, then start briefstack web again.`,
    claudeUntested: (installed: string, expected: string) =>
      `Warning: Claude Code ${installed} has not been tested with this version of briefstack (built for ${expected}). Creating a project may fail.`,
    claudeUnknownVersion: 'Warning: could not read the version of Claude Code. Creating a project may fail.',
    authSignIn: (plan: string | undefined) =>
      `Claude Code: signed in with a Claude plan${plan === undefined ? '' : ` (${plan})`}. Creations use your plan's limits.`,
    authApiKey: (source: string) => `Claude Code: API key (${source}). Creations are billed per use to that key.`,
    authCloud: (provider: string) => `Claude Code: cloud provider (${provider}). Creations are billed by that provider.`,
    authNone:
      'Warning: Claude Code is not signed in. Run `claude` in a terminal and sign in with your Claude account, or set ANTHROPIC_API_KEY to your own key in the terminal that starts briefstack web, then start it again.',
    authUnknown: 'Warning: could not ask Claude Code how it signs in. Run `claude` once to check that it starts and is signed in.',
  },
  es: {
    usage: 'briefstack web [--port <n>] [--server --allowed-hosts <nombre:puerto,...> --access-secret-file <ruta> [--listen <dirección>]]',
    listening: 'briefstack web está en marcha. Abre esta dirección en el navegador (Ctrl+C para pararlo):',
    serverListening: 'briefstack web está en marcha en modo servidor. Abre esta dirección e inicia sesión con el secreto de acceso:',
    serverWarning: (listen: string, port: number, names: readonly string[]) =>
      `Aviso: modo servidor. briefstack escucha en ${listen}:${port} y solo acepta estos nombres además de 127.0.0.1 y localhost: ${names.join(', ')}. Publica su puerto solo en el 127.0.0.1 del anfitrión y llega a él por tu propia red privada.`,
    serverSecretOpen: 'Aviso: otros usuarios de este sistema pueden leer el fichero del secreto de acceso. Haz que solo lo lea su dueño (chmod 600).',
    buildsResumed: (count: number) => (count === 1 ? 'Un build que el reinicio interrumpió se reanuda solo (Ajustes: los builds se reanudan tras un reinicio).' : `${count} builds que el reinicio interrumpió se reanudan solos (Ajustes: los builds se reanudan tras un reinicio).`),
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
      'Aviso: no se encuentra Claude Code (claude en el PATH o en ~/.local/bin). Instálalo (https://code.claude.com/docs/en/setup), ejecuta `claude` una vez para iniciar sesión y vuelve a arrancar briefstack web. Mientras tanto puedes navegar, pero crear un proyecto no funcionará.',
    claudeOlder: (installed: string, expected: string) =>
      `Aviso: Claude Code ${installed} es más antiguo que la versión ${expected} para la que se hizo esta versión de briefstack. Actualízalo con \`claude update\` y vuelve a arrancar briefstack web.`,
    claudeUntested: (installed: string, expected: string) =>
      `Aviso: Claude Code ${installed} no se ha probado con esta versión de briefstack (hecha para ${expected}). Crear un proyecto podría fallar.`,
    claudeUnknownVersion: 'Aviso: no se ha podido leer la versión de Claude Code. Crear un proyecto podría fallar.',
    authSignIn: (plan: string | undefined) =>
      `Claude Code: sesión iniciada con un plan de Claude${plan === undefined ? '' : ` (${plan})`}. Las creaciones usan los límites de tu plan.`,
    authApiKey: (source: string) => `Claude Code: clave de API (${source}). Las creaciones se cobran por uso a esa clave.`,
    authCloud: (provider: string) => `Claude Code: proveedor en la nube (${provider}). Las creaciones las cobra ese proveedor.`,
    authNone:
      'Aviso: Claude Code no tiene sesión iniciada. Ejecuta `claude` en un terminal e inicia sesión con tu cuenta de Claude, o define ANTHROPIC_API_KEY con tu propia clave en el terminal desde el que arrancas briefstack web, y vuelve a arrancarlo.',
    authUnknown: 'Aviso: no se ha podido preguntar a Claude Code cómo inicia sesión. Ejecuta `claude` una vez para comprobar que arranca y tiene sesión.',
  },
});
