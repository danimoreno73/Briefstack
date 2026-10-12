import type { ScaffoldWarning } from '../scaffold/index.js';
import { defineCatalogue } from './index.js';

export const scaffoldMessages = defineCatalogue({
  en: {
    usage: 'briefstack scaffold <spec.json> <out-dir> [--allow-non-empty]',
    created: (outDir: string, count: number, template: string) =>
      `Created ${count} files in ${outDir} (template: ${template}).`,
    gitInitialised: 'Initialised a git repository.',
    warning: (warning: ScaffoldWarning): string =>
      warning.code === 'gitUnavailable'
        ? 'Warning: git is not installed, so the project is not a git repository yet.'
        : `Warning: git init failed: ${warning.detail}`,
  },
  es: {
    usage: 'briefstack scaffold <spec.json> <carpeta> [--allow-non-empty]',
    created: (outDir: string, count: number, template: string) =>
      `Creados ${count} archivos en ${outDir} (plantilla: ${template}).`,
    gitInitialised: 'Repositorio git inicializado.',
    warning: (warning: ScaffoldWarning): string =>
      warning.code === 'gitUnavailable'
        ? 'Aviso: git no está instalado, así que el proyecto aún no es un repositorio git.'
        : `Aviso: git init ha fallado: ${warning.detail}`,
  },
});
