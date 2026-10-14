import { defineCatalogue } from './index.js';

/** Strings of the web UI. Pure module: the browser imports it directly. */
export const uiMessages = defineCatalogue({
  en: {
    title: 'briefstack',
    connecting: 'Connecting…',
    connected: (version: string) => `Connected to briefstack ${version}.`,
    noToken: 'Open the address that briefstack web printed in the terminal, including the part after #.',
    rejected: 'The server refused the request. Restart briefstack web and open the new address.',
    unreachable: 'The server is not reachable. Is briefstack web still running?',
  },
  es: {
    title: 'briefstack',
    connecting: 'Conectando…',
    connected: (version: string) => `Conectado a briefstack ${version}.`,
    noToken: 'Abre la dirección que briefstack web ha mostrado en la terminal, incluida la parte después de #.',
    rejected: 'El servidor ha rechazado la petición. Reinicia briefstack web y abre la nueva dirección.',
    unreachable: 'No se puede contactar con el servidor. ¿Sigue en marcha briefstack web?',
  },
});
