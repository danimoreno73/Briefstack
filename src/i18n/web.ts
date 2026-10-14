import { defineCatalogue } from './index.js';

export const webMessages = defineCatalogue({
  en: {
    usage: 'briefstack web [--port <n>]',
    listening: 'briefstack web is running. Open this address in your browser (Ctrl+C to stop):',
    stopped: 'briefstack web stopped.',
  },
  es: {
    usage: 'briefstack web [--port <n>]',
    listening: 'briefstack web está en marcha. Abre esta dirección en el navegador (Ctrl+C para pararlo):',
    stopped: 'briefstack web se ha parado.',
  },
});
