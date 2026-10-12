import { defineCatalogue } from './index.js';

export const pathsMessages = defineCatalogue({
  en: {
    usage: 'briefstack paths [--json] | briefstack paths check <dir> [--json]',
    home: (dir: string) => `briefstack home: ${dir}`,
    library: (dir: string, exists: boolean) =>
      exists ? `Personal library: ${dir}` : `Personal library: ${dir} (not created yet; run briefstack init)`,
    projects: (dir: string) => `Projects folder: ${dir}`,
    sessions: (dir: string) => `Sessions: ${dir}`,
    allowedDirs: (dirs: readonly string[]) =>
      `Folders allowed in .claude/settings.local.json: ${dirs.length > 0 ? dirs.join(', ') : '(none)'}`,
    missing: (dir: string) => `${dir} does not exist yet; scaffold will create it.`,
    empty: (dir: string) => `${dir} exists and is empty.`,
    nonEmpty: (dir: string) => `${dir} exists and is not empty; scaffold needs --allow-non-empty.`,
    allowedBy: (entry: string) => `Claude Code may already write there (allowed through ${entry}).`,
    notAllowed: (dir: string) => `Not allowed yet: run /add-dir ${dir} in Claude Code before generating.`,
  },
  es: {
    usage: 'briefstack paths [--json] | briefstack paths check <carpeta> [--json]',
    home: (dir: string) => `Carpeta de briefstack: ${dir}`,
    library: (dir: string, exists: boolean) =>
      exists
        ? `Biblioteca personal: ${dir}`
        : `Biblioteca personal: ${dir} (aún no existe; ejecuta briefstack init)`,
    projects: (dir: string) => `Carpeta de proyectos: ${dir}`,
    sessions: (dir: string) => `Sesiones: ${dir}`,
    allowedDirs: (dirs: readonly string[]) =>
      `Carpetas permitidas en .claude/settings.local.json: ${dirs.length > 0 ? dirs.join(', ') : '(ninguna)'}`,
    missing: (dir: string) => `${dir} aún no existe; scaffold la creará.`,
    empty: (dir: string) => `${dir} existe y está vacía.`,
    nonEmpty: (dir: string) => `${dir} existe y no está vacía; scaffold necesita --allow-non-empty.`,
    allowedBy: (entry: string) => `Claude Code ya puede escribir ahí (permitida a través de ${entry}).`,
    notAllowed: (dir: string) => `Aún no está permitida: ejecuta /add-dir ${dir} en Claude Code antes de generar.`,
  },
});
