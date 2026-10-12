import { defineCatalogue } from './index.js';

export const cliMessages = defineCatalogue({
  en: {
    usage: [
      'Usage: briefstack <command> [options]',
      '',
      'Commands:',
      '  scaffold <spec.json> <out-dir> [--allow-non-empty]   Create a project folder from a spec',
      '',
      'Options:',
      '  --help       Show this help',
      '  --version    Show the version',
    ].join('\n'),
    unknownCommand: (command: string) => `Unknown command: ${command}`,
    unknownOption: (option: string) => `Unknown option: ${option}`,
    wrongArguments: (usage: string) => `Wrong arguments. Usage: ${usage}`,
    unexpected: (detail: string) => `Unexpected error: ${detail}`,
  },
  es: {
    usage: [
      'Uso: briefstack <comando> [opciones]',
      '',
      'Comandos:',
      '  scaffold <spec.json> <carpeta> [--allow-non-empty]   Crea la carpeta de un proyecto a partir de una spec',
      '',
      'Opciones:',
      '  --help       Muestra esta ayuda',
      '  --version    Muestra la versión',
    ].join('\n'),
    unknownCommand: (command: string) => `Comando desconocido: ${command}`,
    unknownOption: (option: string) => `Opción desconocida: ${option}`,
    wrongArguments: (usage: string) => `Argumentos incorrectos. Uso: ${usage}`,
    unexpected: (detail: string) => `Error inesperado: ${detail}`,
  },
});
