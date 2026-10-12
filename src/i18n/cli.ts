import { defineCatalogue } from './index.js';

export const cliMessages = defineCatalogue({
  en: {
    usage: [
      'Usage: briefstack <command> [options]',
      '',
      'Commands:',
      '  scaffold <spec.json> <out-dir> [--allow-non-empty]   Create a project folder from a spec',
      '  usage show                                           Show the active usage profile',
      '  usage set <profile> [--project <dir>]                Apply a usage profile to the agent files',
      '  validate <project-dir> [--json]                      Check a generated project',
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
      '  usage show                                           Muestra el perfil de uso activo',
      '  usage set <perfil> [--project <carpeta>]             Aplica un perfil de uso a los archivos de agentes',
      '  validate <carpeta-proyecto> [--json]                 Comprueba un proyecto generado',
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
