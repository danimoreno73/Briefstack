import { defineCatalogue } from './index.js';

/** Strings of the web UI. Pure module: the browser imports it directly. */
export const uiMessages = defineCatalogue({
  en: {
    title: 'briefstack',
    connecting: 'Connecting…',
    noToken: 'Open the address that briefstack web printed in the terminal, including the part after #.',
    rejected: 'The server refused the request. Restart briefstack web and open the new address.',
    unreachable: 'The server is not reachable. Is briefstack web still running?',

    navLabel: 'Main',
    navProjects: 'Projects',
    navLibrary: 'Library',
    navUsage: 'Usage',
    navSettings: 'Settings',

    loading: 'Loading…',
    retry: 'Try again',
    back: 'Back',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'The browser did not allow copying.',
    none: 'None',
    notFound: 'Nothing here.',

    // Errors by code. The server's own text is never shown.
    errGeneric: (code: string) => `Something went wrong (${code}).`,
    errSecret: (lines: readonly number[]) =>
      `The note looks like it contains a secret (line ${lines.join(', ')}). Remove it and save again. Nothing was saved.`,
    errSecretNoLines: 'The note looks like it contains a secret. Remove it and save again. Nothing was saved.',
    errRelativePath: 'Use a full path, such as C:\\Users\\you\\projects or /home/you/projects, or one starting with ~.',
    errForbiddenOutput: (root: string) =>
      root === 'library'
        ? 'That folder overlaps your personal library. Choose another one.'
        : 'That folder overlaps the briefstack repository. Choose another one.',
    errNotADirectory: 'That path is a file, not a folder.',
    errNoteNotFound: 'That note does not exist.',
    errCommitNotFound: 'That commit does not exist.',
    errDirtyTree: 'The library has changes that are not saved yet. Save or discard them first.',
    errRevertConflict: 'The commit could not be reverted without conflicts. The library was not changed.',
    errUnknownProfile: 'That usage profile does not exist.',
    errInvalidBody: 'The server did not accept those values.',

    projectsTitle: 'Projects',
    projectsEmpty: 'No projects yet. Create one with /new-project.',
    colName: 'Name',
    colTarget: 'Target',
    colStatus: 'Status',
    colProfile: 'Profile',
    colCreated: 'Created',
    colPath: 'Path',
    invalidNote: 'Invalid status block',
    invalidIssues: (issues: readonly string[]) => `Problems: ${issues.join('; ')}`,
    allProjects: 'All projects',
    summary: 'Summary',
    statusBlock: 'Status',
    sessionId: 'Creation session',
    timelineTitle: 'Creation history',
    timelineEmpty: 'There is no history for this project.',
    stepColumn: 'Step',
    startedColumn: 'Started',
    finishedColumn: 'Finished',
    resultColumn: 'Result',
    stillRunning: 'not finished',
    nextSteps: 'Next steps',
    instructions: 'Instructions for the Claude app',
    copyInstructions: 'Copy INSTRUCTIONS.md',
    copyPath: 'Copy path',
    openInClaude: 'Open in Claude Code',
    openHint: 'Run these two commands in a terminal:',
    copyCommand: 'Copy commands',
    unfinishedTitle: 'Interrupted and cancelled creations',
    unfinishedEmpty: 'None.',
    lastStep: (step: string | undefined) => (step === undefined ? 'before the first step' : `last step: ${step}`),
    outcome: (value: string | undefined): string => {
      switch (value) {
        case 'ok':
          return 'ok';
        case 'completed':
          return 'completed';
        case 'cancelled':
          return 'cancelled';
        case 'failed':
          return 'failed';
        case 'interrupted':
          return 'interrupted';
        case 'in-progress':
          return 'in progress';
        case 'finished':
          return 'finished';
        default:
          return value ?? '—';
      }
    },

    libraryTitle: 'Personal library',
    sectionIndex: 'Index',
    sectionProfile: 'Profile',
    sectionProjects: 'Project notes',
    sectionLog: 'Session logs',
    sectionSkills: 'Skills',
    sectionLessons: 'Lessons',
    sectionHistory: 'History',
    noNotes: 'No notes in this section.',
    indexReadOnly: 'INDEX.md is updated by briefstack when you save a note.',
    editorLabel: 'Markdown',
    previewLabel: 'Preview',
    unsaved: 'Unsaved changes',
    saveMode: (mode: string): string => {
      switch (mode) {
        case 'append':
          return 'Saved. Your addition went in under today’s date.';
        case 'create':
          return 'Saved. The note was created.';
        case 'unchanged':
          return 'Nothing changed.';
        default:
          return 'Saved.';
      }
    },
    redactedWarning:
      'Some lines look like secrets and are hidden as [redacted]. Remove those lines to save, so the hidden text is not overwritten.',
    historyTitle: 'Library history',
    historyEmpty: 'The library has no history yet.',
    filesChanged: (count: number) => (count === 1 ? '1 file' : `${count} files`),
    revert: 'Revert',
    revertTitle: 'Revert this commit?',
    revertBody: (shortSha: string, subject: string) =>
      `This adds a new commit that undoes ${shortSha} (“${subject}”). Nothing is deleted from the history.`,
    revertConfirm: 'Revert commit',
    reverted: (shortSha: string) => `Reverted ${shortSha}.`,

    usageTitle: 'Usage profile',
    usageIntro: 'Decides which models and how much effort the creation flow uses. More effort means more thorough results and heavier use of your plan.',
    usageSlider: 'Usage level',
    levelSaver: 'Saver',
    levelBalanced: 'Balanced',
    levelMax: 'Max',
    levelHint: (level: string): string => {
      switch (level) {
        case 'saver':
          return 'Lightest use. Lighter models, little research and one short review.';
        case 'max':
          return 'Heaviest use. The strongest models, deeper research and more review rounds.';
        default:
          return 'Moderate use with good results. A mix of models and a normal review.';
      }
    },
    usageActive: (label: string) => `Active: ${label}`,
    usageCustomActive: 'A custom preset is active.',
    presetsLabel: 'Your presets',
    presetsChoose: 'Choose a preset…',
    presetsNone: 'You have not defined any presets.',
    usageSaved: (profile: string) => `Profile set to ${profile}.`,
    warningsTitle: 'Warnings',
    warningsNone: 'No warnings.',
    warnDrift: (file: string, field: string) => `${file}: the ${field} differs from the committed agent file.`,
    warnEnv: (variable: string) => `The environment variable ${variable} overrides the profile.`,
    openUsageHint: 'To see your real consumption, type /usage in Claude Code.',

    settingsTitle: 'Settings',
    projectsDirLabel: 'Projects folder',
    projectsDirHint: 'Where new projects go. The folder is created if it does not exist.',
    languageLabel: 'Language',
    langSystem: 'Follow the system',
    langEn: 'English',
    langEs: 'Español',
    policyLabel: 'When Claude asks for something unexpected',
    policyAsk: 'Ask me',
    policyAskHint: 'A dialog shows exactly what is requested, and you approve or deny.',
    policyUnattended: 'Unattended',
    policyUnattendedHint: 'It is denied automatically, recorded in the history, and the flow continues.',
    settingsSaved: 'Settings saved.',
    pathsTitle: 'Resolved paths',
    pathHome: 'briefstack home',
    pathConfig: 'Config file',
    pathLibrary: 'Personal library',
    pathProjects: 'Projects folder',
    pathSessions: 'Sessions',
    pathRepo: 'briefstack repository',
    pathAllowed: 'Folders Claude may write to',
  },
  es: {
    title: 'briefstack',
    connecting: 'Conectando…',
    noToken: 'Abre la dirección que briefstack web ha mostrado en la terminal, incluida la parte después de #.',
    rejected: 'El servidor ha rechazado la petición. Reinicia briefstack web y abre la nueva dirección.',
    unreachable: 'No se puede contactar con el servidor. ¿Sigue en marcha briefstack web?',

    navLabel: 'Principal',
    navProjects: 'Proyectos',
    navLibrary: 'Librería',
    navUsage: 'Uso',
    navSettings: 'Ajustes',

    loading: 'Cargando…',
    retry: 'Reintentar',
    back: 'Volver',
    save: 'Guardar',
    saving: 'Guardando…',
    cancel: 'Cancelar',
    copy: 'Copiar',
    copied: 'Copiado',
    copyFailed: 'El navegador no ha permitido copiar.',
    none: 'Ninguno',
    notFound: 'No hay nada aquí.',

    errGeneric: (code: string) => `Algo ha ido mal (${code}).`,
    errSecret: (lines: readonly number[]) =>
      `La nota parece contener un secreto (línea ${lines.join(', ')}). Quítalo y guarda otra vez. No se ha guardado nada.`,
    errSecretNoLines: 'La nota parece contener un secreto. Quítalo y guarda otra vez. No se ha guardado nada.',
    errRelativePath: 'Usa una ruta completa, como C:\\Users\\tu\\proyectos o /home/tu/proyectos, o una que empiece por ~.',
    errForbiddenOutput: (root: string) =>
      root === 'library'
        ? 'Esa carpeta se solapa con tu librería personal. Elige otra.'
        : 'Esa carpeta se solapa con el repositorio de briefstack. Elige otra.',
    errNotADirectory: 'Esa ruta es un archivo, no una carpeta.',
    errNoteNotFound: 'Esa nota no existe.',
    errCommitNotFound: 'Ese commit no existe.',
    errDirtyTree: 'La librería tiene cambios sin guardar. Guárdalos o descártalos primero.',
    errRevertConflict: 'No se pudo revertir el commit sin conflictos. La librería no ha cambiado.',
    errUnknownProfile: 'Ese perfil de uso no existe.',
    errInvalidBody: 'El servidor no ha aceptado esos valores.',

    projectsTitle: 'Proyectos',
    projectsEmpty: 'Aún no hay proyectos. Crea uno con /new-project.',
    colName: 'Nombre',
    colTarget: 'Destino',
    colStatus: 'Estado',
    colProfile: 'Perfil',
    colCreated: 'Creado',
    colPath: 'Ruta',
    invalidNote: 'Bloque de estado no válido',
    invalidIssues: (issues: readonly string[]) => `Problemas: ${issues.join('; ')}`,
    allProjects: 'Todos los proyectos',
    summary: 'Resumen',
    statusBlock: 'Estado',
    sessionId: 'Sesión de creación',
    timelineTitle: 'Historial de creación',
    timelineEmpty: 'Este proyecto no tiene historial.',
    stepColumn: 'Paso',
    startedColumn: 'Inicio',
    finishedColumn: 'Fin',
    resultColumn: 'Resultado',
    stillRunning: 'sin terminar',
    nextSteps: 'Próximos pasos',
    instructions: 'Instrucciones para la app de Claude',
    copyInstructions: 'Copiar INSTRUCTIONS.md',
    copyPath: 'Copiar ruta',
    openInClaude: 'Abrir en Claude Code',
    openHint: 'Ejecuta estos dos comandos en una terminal:',
    copyCommand: 'Copiar comandos',
    unfinishedTitle: 'Creaciones interrumpidas y canceladas',
    unfinishedEmpty: 'Ninguna.',
    lastStep: (step: string | undefined) => (step === undefined ? 'antes del primer paso' : `último paso: ${step}`),
    outcome: (value: string | undefined): string => {
      switch (value) {
        case 'ok':
          return 'correcto';
        case 'completed':
          return 'completada';
        case 'cancelled':
          return 'cancelada';
        case 'failed':
          return 'fallida';
        case 'interrupted':
          return 'interrumpida';
        case 'in-progress':
          return 'en curso';
        case 'finished':
          return 'terminada';
        default:
          return value ?? '—';
      }
    },

    libraryTitle: 'Librería personal',
    sectionIndex: 'Índice',
    sectionProfile: 'Perfil',
    sectionProjects: 'Notas de proyectos',
    sectionLog: 'Registros de sesiones',
    sectionSkills: 'Skills',
    sectionLessons: 'Lecciones',
    sectionHistory: 'Historial',
    noNotes: 'No hay notas en esta sección.',
    indexReadOnly: 'briefstack actualiza INDEX.md cuando guardas una nota.',
    editorLabel: 'Markdown',
    previewLabel: 'Vista previa',
    unsaved: 'Cambios sin guardar',
    saveMode: (mode: string): string => {
      switch (mode) {
        case 'append':
          return 'Guardado. Lo que has añadido quedó bajo la fecha de hoy.';
        case 'create':
          return 'Guardado. La nota se ha creado.';
        case 'unchanged':
          return 'No ha cambiado nada.';
        default:
          return 'Guardado.';
      }
    },
    redactedWarning:
      'Algunas líneas parecen secretos y se ocultan como [redacted]. Quita esas líneas para guardar, así no se sobrescribe el texto oculto.',
    historyTitle: 'Historial de la librería',
    historyEmpty: 'La librería aún no tiene historial.',
    filesChanged: (count: number) => (count === 1 ? '1 archivo' : `${count} archivos`),
    revert: 'Revertir',
    revertTitle: '¿Revertir este commit?',
    revertBody: (shortSha: string, subject: string) =>
      `Se añade un commit nuevo que deshace ${shortSha} («${subject}»). No se borra nada del historial.`,
    revertConfirm: 'Revertir commit',
    reverted: (shortSha: string) => `Se ha revertido ${shortSha}.`,

    usageTitle: 'Perfil de uso',
    usageIntro: 'Decide qué modelos y cuánto esfuerzo usa el flujo de creación. Más esfuerzo da resultados más completos y gasta más de tu plan.',
    usageSlider: 'Nivel de uso',
    levelSaver: 'Ahorro',
    levelBalanced: 'Equilibrado',
    levelMax: 'Máximo',
    levelHint: (level: string): string => {
      switch (level) {
        case 'saver':
          return 'El menor consumo. Modelos más ligeros, poca investigación y una revisión corta.';
        case 'max':
          return 'El mayor consumo. Los modelos más potentes, investigación más profunda y más rondas de revisión.';
        default:
          return 'Consumo moderado con buenos resultados. Una mezcla de modelos y una revisión normal.';
      }
    },
    usageActive: (label: string) => `Activo: ${label}`,
    usageCustomActive: 'Hay un preset propio activo.',
    presetsLabel: 'Tus presets',
    presetsChoose: 'Elige un preset…',
    presetsNone: 'No has definido ningún preset.',
    usageSaved: (profile: string) => `Perfil cambiado a ${profile}.`,
    warningsTitle: 'Avisos',
    warningsNone: 'Sin avisos.',
    warnDrift: (file: string, field: string) => `${file}: ${field} difiere del archivo de agente guardado en git.`,
    warnEnv: (variable: string) => `La variable de entorno ${variable} anula el perfil.`,
    openUsageHint: 'Para ver tu consumo real, escribe /usage en Claude Code.',

    settingsTitle: 'Ajustes',
    projectsDirLabel: 'Carpeta de proyectos',
    projectsDirHint: 'Donde van los proyectos nuevos. Si la carpeta no existe, se crea.',
    languageLabel: 'Idioma',
    langSystem: 'Seguir el sistema',
    langEn: 'English',
    langEs: 'Español',
    policyLabel: 'Cuando Claude pide algo inesperado',
    policyAsk: 'Preguntarme',
    policyAskHint: 'Un diálogo muestra exactamente lo que se pide y tú apruebas o deniegas.',
    policyUnattended: 'Desatendido',
    policyUnattendedHint: 'Se deniega automáticamente, queda en el historial y el flujo continúa.',
    settingsSaved: 'Ajustes guardados.',
    pathsTitle: 'Rutas resueltas',
    pathHome: 'Carpeta de briefstack',
    pathConfig: 'Archivo de configuración',
    pathLibrary: 'Librería personal',
    pathProjects: 'Carpeta de proyectos',
    pathSessions: 'Sesiones',
    pathRepo: 'Repositorio de briefstack',
    pathAllowed: 'Carpetas donde Claude puede escribir',
  },
});
