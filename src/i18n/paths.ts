import { defineCatalogue } from './index.js';

export const pathsMessages = defineCatalogue({
  en: {
    usage:
      'briefstack paths [--json] | briefstack paths check <dir> [--json] [--session <id>] | briefstack paths rewrite --from <dir> --to <dir> [--apply] [--json]',
    rewriteDryRun: 'Dry run: nothing was written. Run it again with --apply to write these changes.',
    rewriteApplied: 'Written:',
    rewriteNothing: (from: string) => `Nothing briefstack works with points inside ${from}; nothing to change.`,
    rewriteChange: (field: string, before: string, after: string) => `  ${field}: ${before} -> ${after}`,
    rewriteCount: (files: number, applied: boolean) =>
      applied ? `${files} ${files === 1 ? 'file' : 'files'} changed.` : `${files} ${files === 1 ? 'file' : 'files'} would change.`,
    rewriteCommitted: 'The library notes were committed together, in one commit.',
    rewriteHistory: 'Records of what happened (session summaries, the creation log, chat threads, finished improvements) keep their old paths.',
    rewriteTargetMissing: (dir: string) => `${dir} is not a folder yet: --apply refuses to write until it is.`,
    rewriteLibraryEnv: (value: string) => `BRIEFSTACK_LIBRARY is ${value}, inside the old folder: change that variable yourself.`,
    rewriteNoLibrary: (dir: string) => `No library in ${dir}: its notes were not read.`,
    rewriteOpenTask: (id: string, project: string, state: string) =>
      `Task ${id} (${project}) is ${state} and keeps a git worktree that a moved folder breaks: discard it, or run "git worktree repair" in the project.`,
    rewriteOpenImprovement: (id: string, status: string) =>
      `Improvement ${id} is ${status} and keeps a git worktree that a moved folder breaks: discard it, or run "git worktree repair" in the repo.`,
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
    notAllowed: (dir: string) =>
      `Not in .claude/settings.local.json: run /add-dir ${dir} in Claude Code before generating (folders added with /add-dir last for the session and are not visible here).`,
  },
  es: {
    usage:
      'briefstack paths [--json] | briefstack paths check <carpeta> [--json] [--session <id>] | briefstack paths rewrite --from <carpeta> --to <carpeta> [--apply] [--json]',
    rewriteDryRun: 'Modo prueba: no se ha escrito nada. Vuelve a ejecutarlo con --apply para escribir estos cambios.',
    rewriteApplied: 'Escrito:',
    rewriteNothing: (from: string) => `Nada de lo que usa briefstack apunta dentro de ${from}; no hay nada que cambiar.`,
    rewriteChange: (field: string, before: string, after: string) => `  ${field}: ${before} -> ${after}`,
    rewriteCount: (files: number, applied: boolean) =>
      applied
        ? `${files} ${files === 1 ? 'archivo cambiado' : 'archivos cambiados'}.`
        : `${files} ${files === 1 ? 'archivo cambiaría' : 'archivos cambiarían'}.`,
    rewriteCommitted: 'Las notas de la biblioteca se han guardado juntas, en un solo commit.',
    rewriteHistory: 'Los registros de lo que pasó (resúmenes de sesión, el registro de creaciones, los hilos del chat, las mejoras terminadas) conservan sus rutas antiguas.',
    rewriteTargetMissing: (dir: string) => `${dir} aún no es una carpeta: --apply no escribirá nada hasta que lo sea.`,
    rewriteLibraryEnv: (value: string) => `BRIEFSTACK_LIBRARY vale ${value}, dentro de la carpeta antigua: cambia tú esa variable.`,
    rewriteNoLibrary: (dir: string) => `No hay biblioteca en ${dir}: no se han leído sus notas.`,
    rewriteOpenTask: (id: string, project: string, state: string) =>
      `La tarea ${id} (${project}) está en estado ${state} y tiene un worktree de git que se rompe al mover la carpeta: descártala o ejecuta "git worktree repair" en el proyecto.`,
    rewriteOpenImprovement: (id: string, status: string) =>
      `La mejora ${id} está en estado ${status} y tiene un worktree de git que se rompe al mover la carpeta: descártala o ejecuta "git worktree repair" en el repo.`,
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
    notAllowed: (dir: string) =>
      `No está en .claude/settings.local.json: ejecuta /add-dir ${dir} en Claude Code antes de generar (las carpetas añadidas con /add-dir duran la sesión y aquí no se ven).`,
  },
});
