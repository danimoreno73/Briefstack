import type {
  BriefstackError,
  ErrorCode,
  ErrorParams,
  FieldExpectation,
  ProtectedRoot,
  SettingsField,
  SkillEntryProblem,
  SkillUrlProblem,
} from '../errors.js';
import { defineCatalogue, type Lang } from './index.js';
import { formatSpecIssue } from './spec.js';

const expectationEn: Record<FieldExpectation, string> = {
  text: 'a non-empty text',
  lang: 'one of: en, es',
  permissionPolicy: 'one of: ask, unattended',
  positiveInteger: 'a whole number from 1 up',
  percent: 'a whole number from 1 to 100',
};
const expectationEs: Record<FieldExpectation, string> = {
  text: 'un texto no vacío',
  lang: 'uno de: en, es',
  permissionPolicy: 'uno de: ask, unattended',
  positiveInteger: 'un número entero desde 1',
  percent: 'un número entero de 1 a 100',
};

const rootEn: Record<ProtectedRoot, string> = {
  repo: 'the briefstack repo',
  library: 'the personal library',
  home: "briefstack's own folder (config and sessions)",
  claudeConfig: "Claude Code's settings folder",
  appData: 'the Windows AppData\\Roaming folder',
  localAppData: 'the Windows AppData\\Local folder',
};
const rootEs: Record<ProtectedRoot, string> = {
  repo: 'el repo de briefstack',
  library: 'la biblioteca personal',
  home: 'la carpeta propia de briefstack (configuración y sesiones)',
  claudeConfig: 'la carpeta de configuración de Claude Code',
  appData: 'la carpeta AppData\\Roaming de Windows',
  localAppData: 'la carpeta AppData\\Local de Windows',
};

const settingsFieldEn: Record<SettingsField, string> = {
  root: 'the file must contain a JSON object',
  permissions: '"permissions" must be an object',
  additionalDirectories: '"permissions.additionalDirectories" must be a list of paths',
};
const settingsFieldEs: Record<SettingsField, string> = {
  root: 'el archivo debe contener un objeto JSON',
  permissions: '"permissions" debe ser un objeto',
  additionalDirectories: '"permissions.additionalDirectories" debe ser una lista de rutas',
};

const skillUrlEn: Record<SkillUrlProblem, string> = {
  notHttps: 'use an https:// link.',
  notGithub: 'only github.com links are supported.',
  shape: 'use a link to a repository, a folder (…/tree/<branch>/<folder>) or a SKILL.md (…/blob/<branch>/<folder>/SKILL.md).',
  notSkillFile: 'a file link must point at a SKILL.md.',
};
const skillUrlEs: Record<SkillUrlProblem, string> = {
  notHttps: 'usa un enlace https://.',
  notGithub: 'solo se admiten enlaces de github.com.',
  shape: 'usa un enlace a un repositorio, a una carpeta (…/tree/<rama>/<carpeta>) o a un SKILL.md (…/blob/<rama>/<carpeta>/SKILL.md).',
  notSkillFile: 'un enlace a un archivo debe apuntar a un SKILL.md.',
};

const skillEntryEn: Record<SkillEntryProblem, string> = {
  symlink: 'it holds a symbolic link',
  submodule: 'it holds a git submodule',
  lfs: 'it holds a Git LFS pointer instead of a file',
  gitControl: 'it holds a .gitattributes or .gitmodules file, which would change how the library stores files',
  unsafePath: 'it holds a file name that is not safe on every system',
  caseCollision: 'two of its names differ only in upper or lower case',
  truncated: 'GitHub cut the folder listing short, so it is too large',
};
const skillEntryEs: Record<SkillEntryProblem, string> = {
  symlink: 'contiene un enlace simbólico',
  submodule: 'contiene un submódulo de git',
  lfs: 'contiene un puntero de Git LFS en lugar de un archivo',
  gitControl: 'contiene un archivo .gitattributes o .gitmodules, que cambiaría cómo guarda los archivos la biblioteca',
  unsafePath: 'contiene un nombre de archivo que no es seguro en todos los sistemas',
  caseCollision: 'dos de sus nombres solo se distinguen por mayúsculas o minúsculas',
  truncated: 'GitHub recortó el listado de la carpeta, así que es demasiado grande',
};

const bullets = (lines: readonly string[]): string => lines.map((line) => `\n  - ${line}`).join('');

type ErrorMessages = { [C in ErrorCode]: (p: ErrorParams[C]) => string };

const errors = defineCatalogue<ErrorMessages>({
  en: {
    'config.invalidJson': (p) => `Config file ${p.file} is not valid JSON: ${p.detail}`,
    'config.notAnObject': (p) => `Config file ${p.file} must contain a JSON object.`,
    'config.invalidField': (p) =>
      `Config file ${p.file}: "${p.field}" must be ${expectationEn[p.expected]}.`,
    'config.relativePath': (p) =>
      `${p.source} must be a full absolute path (on Windows, with a drive letter such as C:/) or start with ~ (got "${p.value}").`,
    'frontmatter.unclosed': (p) => `${p.file}: frontmatter starts with --- but is never closed.`,
    'frontmatter.invalidYaml': (p) => `${p.file}: frontmatter is not valid YAML: ${p.detail}`,
    'frontmatter.notAMapping': (p) => `${p.file}: frontmatter must be a set of key: value fields.`,
    'frontmatter.blockValue': (p) =>
      `${p.file}: "${p.field}" spans several lines; briefstack only rewrites single-line values.`,
    'spec.notFound': (p) => `Spec file not found: ${p.file}`,
    'spec.invalidJson': (p) => `Spec ${p.file} is not valid JSON: ${p.detail}`,
    'spec.invalid': (p) =>
      `Spec ${p.file} is not valid:${bullets(p.issues.map((issue) => formatSpecIssue(issue, 'en')))}`,
    'scaffold.forbiddenOutput': (p) =>
      `Refusing to create the project in ${p.outDir}: it overlaps ${rootEn[p.root]} (${p.rootPath}).`,
    'scaffold.notADirectory': (p) => `${p.outDir} exists and is not a folder.`,
    'scaffold.nonEmptyOutput': (p) =>
      `${p.outDir} is not empty. Choose another folder, or pass --allow-non-empty to add the project there.`,
    'scaffold.wouldOverwrite': (p) =>
      `Refusing to overwrite existing files in ${p.outDir}:${bullets(p.paths)}`,
    'scaffold.templateNotFound': (p) =>
      `Template "${p.template}" not found. Looked in:${bullets(p.searched)}`,
    'scaffold.templateReservedPath': (p) =>
      `Template "${p.template}" contains ${p.path}, which briefstack writes itself.`,
    'usage.profilesNotFound': (p) => `Usage profiles file not found: ${p.file}`,
    'usage.invalidProfiles': (p) => `Usage profiles file ${p.file} is not valid:${bullets(p.issues)}`,
    'usage.unknownProfile': (p) =>
      `Unknown usage profile "${p.profile}". Available: ${p.available.join(', ')}.`,
    'usage.notABriefstackProject': (p) =>
      `${p.dir} was not created by briefstack (no .briefstack/profile.json); refusing to change it.`,
    'usage.invalidProjectProfile': (p) => `Project profile ${p.file} is not valid:${bullets(p.issues)}`,
    'validate.projectNotFound': (p) => `Project folder not found: ${p.dir}`,
    'validate.notADirectory': (p) => `${p.dir} is not a folder.`,
    'init.settingsInvalidJson': (p) =>
      `${p.file} is not valid JSON, so it was left untouched: ${p.detail}`,
    'init.settingsInvalidShape': (p) =>
      `${p.file} was left untouched: ${settingsFieldEn[p.field]}.`,
    'library.notInitialised': (p) =>
      `No personal library at ${p.dir}. Run "briefstack init" first.`,
    'library.unknownSection': (p) =>
      `Unknown library section "${p.section}". Available: ${p.available.join(', ')}.`,
    'library.invalidName': (p) =>
      `"${p.name}" is not a valid note name: use lowercase letters, digits and single hyphens.`,
    'library.nameRequired': (p) => `Section "${p.section}" needs a note name.`,
    'library.nameNotAllowed': (p) => `Section "${p.section}" is a single note; leave out the name.`,
    'library.fileNotFound': (p) => `File not found: ${p.file}`,
    'library.emptyContent': (p) => `${p.file} has no content to add.`,
    'library.secretContent': (p) =>
      `${p.file} looks like it contains a secret (line ${p.lines.join(', ')}). Nothing was written; remove it and try again.`,
    'library.noteNotFound': (p) => `No note "${p.name}" in ${p.section}.`,
    'library.invalidProjectStatus': (p) =>
      `The project status in ${p.file} is not valid:${bullets(p.issues)}`,
    'library.commitNotFound': (p) => `No change "${p.sha}" in the library history.`,
    'library.dirtyTree': (p) =>
      `The library in ${p.dir} has uncommitted changes. Commit or discard them before undoing a change.`,
    'library.revertConflict': (p) =>
      `Undoing ${p.sha.slice(0, 12)} clashes with later changes to:${bullets(p.files)}\nNothing was changed.`,
    'library.revertFailed': (p) => `Could not undo ${p.sha.slice(0, 12)}; nothing was changed: ${p.detail}`,
    'library.busy': (p) =>
      `Another change to the library is still running after ${Math.round(p.waitedMs / 1000)} s; nothing was written. Try again.`,
    'library.noteChanged': (p) => `${p.file} changed after the change was shown; nothing was saved. Look at it again and propose the change again.`,
    'events.invalidSession': (p) =>
      `"${p.session}" is not a valid session id (letters, digits, ".", "_" and "-" only).`,
    'events.sessionNotFound': (p) => `No creation session "${p.session}" (it has no events.jsonl).`,
    'web.invalidPort': (p) => `"${p.value}" is not a valid port (a whole number from 0 to 65535).`,
    'web.portInUse': (p) =>
      `Port ${p.port} is already in use. Run again with --port 0 to use any free port.`,
    'web.uiNotBuilt': (p) => `The web app is not built (${p.dir} is missing). Run npm run build first.`,
    'web.invalidJson': (p) => `The request body is not valid JSON: ${p.detail}`,
    'web.invalidBody': (p) => `The request body is not valid:${bullets(p.issues)}`,
    'web.invalidQuery': (p) => `"${p.value}" is not a valid value for "${p.name}".`,
    'web.bodyTooLarge': (p) => `The request body is larger than ${p.limit} bytes.`,
    'web.unsupportedMediaType': (p) =>
      `The request body must be JSON (Content-Type: application/json), not "${p.contentType}".`,
    'creation.unavailable': () => 'Creating projects is not available in this server.',
    'creation.limit': (p) =>
      `The limit of active creations is reached (${p.active.length} of ${p.limit}). Finish or cancel one, or raise the limit in Settings.`,
    'creation.noSpec': (p) => `Creation ${p.id} has not shown a spec yet.`,
    'creation.claudeNotFound': () =>
      'Claude Code was not found. Install it (https://claude.com/claude-code), log in with `claude`, and start briefstack web again.',
    'creation.slashCommandMissing': (p) =>
      `Claude Code did not list /${p.command} among its commands, so the creation cannot start. Check that the briefstack repository is the working folder and has .claude/skills/${p.command}.`,
    'creation.webToolsMissing': (p) =>
      `Claude Code started without the browser tools (${p.tools}; MCP server ${p.server}: ${p.status}), so the spec approval could not reach this page. The creation was stopped before doing anything. Start briefstack web again; if it happens again, report it with this message.`,
    'creation.notFound': (p) => `No creation with id ${p.id}.`,
    'creation.noPending': (p) => `Creation ${p.id} is not waiting for an answer.`,
    'creation.wrongPending': (p) =>
      `That answer is for ${p.pendingId}, but the creation is waiting for ${p.expected}. Reload and try again.`,
    'creation.invalidAnswer': (p) => `The answer to this ${p.kind} is not valid:${bullets(p.issues)}`,
    'creation.noReply': (p) => `Creation ${p.id} is not waiting for a reply.`,
    'chat.unavailable': () => 'The chat is not available in this server.',
    'chat.threadNotFound': (p) => `There is no chat ${p.id}.`,
    'chat.busy': () => 'The chat is still answering the last message. Wait for it to finish.',
    'chat.noConfirmation': (p) => `Nothing with id ${p.id} is waiting for a confirmation.`,
    'improve.unavailable': () => 'Improvements are not available in this server.',
    'improve.busy': (p) => `An improvement session is already running (${p.id}). Wait for it to finish.`,
    'improve.notFound': (p) => `There is no proposal ${p.id}.`,
    'improve.wrongState': (p) => `Proposal ${p.id} cannot do that now: it is ${p.status}.`,
    'improve.noRepo': (p) => `The briefstack repository cannot take an improvement: ${p.reason}`,
    'improve.notOnBranch': (p) => `The repository is on ${p.current}, not on ${p.branch}, where the proposal was prepared. Switch back to ${p.branch} and try again.`,
    'improve.uncommitted': (p) => `${p.file} has changes that are not committed in the part the proposal changes. Commit or discard them first.`,
    'improve.conflict': (p) => `${p.file} changed since the proposal was prepared, in the same lines. Ask for changes to prepare a new round.`,
    'improve.baseChanged': (p) => `${p.file} changed on ${p.branch} since the proposal was prepared, so what was checked and tested is not what would be applied. Ask for changes: the new round starts from the current ${p.branch}.`,
    'improve.staleReview': (p) => `Proposal ${p.id} was checked again since the page showed it. Reload the page, review the new round and approve that one.`,
    'improve.moved': () => 'The branch moved while the change was being applied. Nothing was changed; try again.',
    'improve.noCheck': (p) => `Proposal ${p.id} has no real check to run.`,
    'improve.checkBusy': (p) => `The real check of proposal ${p.id} is already running.`,
    'improve.suggestionNotFound': (p) => `There is no suggestion ${p.id}.`,
    'skills.invalidUrl': (p) => `${p.url} is not a link briefstack can fetch a skill from: ${skillUrlEn[p.reason]}`,
    'skills.repoNotFound': (p) => `GitHub has no public repository ${p.owner}/${p.repo}. Private repositories are not supported.`,
    'skills.refNotFound': (p) => `GitHub does not know the branch, tag or commit in "${p.ref}".`,
    'skills.pathNotFound': (p) => `The folder ${p.path === '' ? '(root)' : p.path} does not exist at that branch, tag or commit.`,
    'skills.noSkillFile': () => 'That folder has no SKILL.md at its top level, so it is not a skill.',
    'skills.rateLimited': (p) =>
      `GitHub's limit for requests without a token was reached.${p.reset === null ? ' Try again later.' : ` Try again after ${p.reset}.`}`,
    'skills.network': (p) => `The skill could not be fetched: ${p.detail}.`,
    'skills.tooLarge': (p) =>
      p.what === 'files'
        ? `The skill has ${p.actual} files; the limit is ${p.limit}.`
        : p.what === 'file'
          ? `${p.path ?? 'A file'} has ${p.actual} bytes; the limit per file is ${p.limit}.`
          : `The skill has ${p.actual} bytes in all; the limit is ${p.limit}.`,
    'skills.forbiddenEntry': (p) => `The skill was refused: ${skillEntryEn[p.kind]}${p.path === '' ? '' : ` (${p.path})`}.`,
    'skills.integrity': (p) => `${p.path} did not match the commit's content, so nothing was kept. Try again.`,
    'skills.unavailable': () => 'Skills are not available in this server.',
    'skills.notFound': (p) => `There is no skill ${p.name} in the library.`,
    'skills.unreadable': (p) => `The metadata note of skill ${p.name} cannot be read. Fix it in the library or delete the skill.`,
    'skills.invalidName': (p) => `"${p.name}" cannot be a skill name: use lower-case letters, digits and hyphens, at most 64 characters.`,
    'skills.invalidTag': (p) => `"${p.tag}" is not a tag: use lower-case letters, digits and hyphens, at most 30 characters, and at most 10 tags.`,
    'skills.exists': (p) =>
      p.sameSource
        ? `Skill ${p.name} is already in the library. Use "Check for a new version" on its page.`
        : `The library already has a skill named ${p.name}, from another source. Delete it first to add this one.`,
    'skills.wrongStatus': (p) => `Skill ${p.name} is ${p.status}, so it cannot ${p.action === 'checkUpdate' ? 'look for a new version (only approved skills can)' : p.action === 'approve' ? 'be approved' : p.action === 'reject' ? 'be rejected' : p.action}.`,
    'skills.modified': (p) => `The files of skill ${p.name} changed since they were reviewed (${p.path}). Delete the skill and add it again.`,
    'skills.fileNotFound': (p) => `Skill ${p.name} has no file ${p.path}.`,
    'skills.updatePending': (p) => `A new version of skill ${p.name} already waits for approval. Approve or reject it first.`,
    'skills.noUpdate': (p) => `Skill ${p.name} has no new version waiting.`,
    'skills.notApproved': (p) => `Skill ${p.name} is ${p.status}; only approved skills can be installed.`,
    'skills.projectNotFound': (p) => `There is no project folder ${p.dir}.`,
    'skills.notAProject': (p) => `${p.dir} was not made by briefstack (it has no .briefstack/spec.json).`,
    'skills.alreadyInstalled': (p) => `Skill ${p.name} is already installed in this project.`,
    'skills.wouldOverwrite': (p) => `${p.path} already exists in the project; nothing was overwritten.`,
    'skills.installRecordInvalid': (p) => `${p.file} cannot be read. Fix or remove it, then install again.`,
    'usage.high': (p) =>
      `Plan usage is high: 5-hour window ${p.fiveHour ?? '?'}% (warning from ${p.warnFiveHour}%), week ${p.sevenDay ?? '?'}% (warning from ${p.warnWeek}%). Start anyway to go on.`,
  },
  es: {
    'config.invalidJson': (p) =>
      `El archivo de configuración ${p.file} no es JSON válido: ${p.detail}`,
    'config.notAnObject': (p) =>
      `El archivo de configuración ${p.file} debe contener un objeto JSON.`,
    'config.invalidField': (p) =>
      `Archivo de configuración ${p.file}: "${p.field}" debe ser ${expectationEs[p.expected]}.`,
    'config.relativePath': (p) =>
      `${p.source} debe ser una ruta absoluta completa (en Windows, con letra de unidad como C:/) o empezar por ~ (se recibió "${p.value}").`,
    'frontmatter.unclosed': (p) => `${p.file}: el frontmatter empieza con --- pero no se cierra.`,
    'frontmatter.invalidYaml': (p) => `${p.file}: el frontmatter no es YAML válido: ${p.detail}`,
    'frontmatter.notAMapping': (p) =>
      `${p.file}: el frontmatter debe ser una lista de campos clave: valor.`,
    'frontmatter.blockValue': (p) =>
      `${p.file}: "${p.field}" ocupa varias líneas; briefstack solo reescribe valores de una línea.`,
    'spec.notFound': (p) => `No se encuentra el archivo de spec: ${p.file}`,
    'spec.invalidJson': (p) => `La spec ${p.file} no es JSON válido: ${p.detail}`,
    'spec.invalid': (p) =>
      `La spec ${p.file} no es válida:${bullets(p.issues.map((issue) => formatSpecIssue(issue, 'es')))}`,
    'scaffold.forbiddenOutput': (p) =>
      `No se crea el proyecto en ${p.outDir}: se solapa con ${rootEs[p.root]} (${p.rootPath}).`,
    'scaffold.notADirectory': (p) => `${p.outDir} existe y no es una carpeta.`,
    'scaffold.nonEmptyOutput': (p) =>
      `${p.outDir} no está vacía. Elige otra carpeta o pasa --allow-non-empty para añadir el proyecto ahí.`,
    'scaffold.wouldOverwrite': (p) =>
      `No se sobrescriben archivos existentes en ${p.outDir}:${bullets(p.paths)}`,
    'scaffold.templateNotFound': (p) =>
      `No se encuentra la plantilla "${p.template}". Se buscó en:${bullets(p.searched)}`,
    'scaffold.templateReservedPath': (p) =>
      `La plantilla "${p.template}" contiene ${p.path}, que briefstack escribe por su cuenta.`,
    'usage.profilesNotFound': (p) => `No se encuentra el archivo de perfiles de uso: ${p.file}`,
    'usage.invalidProfiles': (p) =>
      `El archivo de perfiles de uso ${p.file} no es válido:${bullets(p.issues)}`,
    'usage.unknownProfile': (p) =>
      `Perfil de uso desconocido "${p.profile}". Disponibles: ${p.available.join(', ')}.`,
    'usage.notABriefstackProject': (p) =>
      `${p.dir} no lo creó briefstack (no tiene .briefstack/profile.json); no se modifica.`,
    'usage.invalidProjectProfile': (p) =>
      `El perfil del proyecto ${p.file} no es válido:${bullets(p.issues)}`,
    'validate.projectNotFound': (p) => `No se encuentra la carpeta del proyecto: ${p.dir}`,
    'validate.notADirectory': (p) => `${p.dir} no es una carpeta.`,
    'init.settingsInvalidJson': (p) =>
      `${p.file} no es JSON válido, así que no se ha tocado: ${p.detail}`,
    'init.settingsInvalidShape': (p) =>
      `${p.file} no se ha tocado: ${settingsFieldEs[p.field]}.`,
    'library.notInitialised': (p) =>
      `No hay biblioteca personal en ${p.dir}. Ejecuta antes "briefstack init".`,
    'library.unknownSection': (p) =>
      `Sección de la biblioteca desconocida "${p.section}". Disponibles: ${p.available.join(', ')}.`,
    'library.invalidName': (p) =>
      `"${p.name}" no es un nombre de nota válido: usa minúsculas, dígitos y guiones simples.`,
    'library.nameRequired': (p) => `La sección "${p.section}" necesita un nombre de nota.`,
    'library.nameNotAllowed': (p) => `La sección "${p.section}" es una sola nota; no indiques nombre.`,
    'library.fileNotFound': (p) => `No se encuentra el archivo: ${p.file}`,
    'library.emptyContent': (p) => `${p.file} no tiene contenido que añadir.`,
    'library.secretContent': (p) =>
      `${p.file} parece contener un secreto (línea ${p.lines.join(', ')}). No se ha escrito nada; quítalo y vuelve a intentarlo.`,
    'library.noteNotFound': (p) => `No hay ninguna nota "${p.name}" en ${p.section}.`,
    'library.invalidProjectStatus': (p) =>
      `El estado del proyecto en ${p.file} no es válido:${bullets(p.issues)}`,
    'library.commitNotFound': (p) => `No hay ningún cambio "${p.sha}" en el historial de la biblioteca.`,
    'library.dirtyTree': (p) =>
      `La biblioteca en ${p.dir} tiene cambios sin confirmar. Confírmalos o descártalos antes de deshacer un cambio.`,
    'library.revertConflict': (p) =>
      `Deshacer ${p.sha.slice(0, 12)} choca con cambios posteriores en:${bullets(p.files)}\nNo se ha cambiado nada.`,
    'library.revertFailed': (p) => `No se ha podido deshacer ${p.sha.slice(0, 12)}; no se ha cambiado nada: ${p.detail}`,
    'library.busy': (p) =>
      `Otro cambio en la biblioteca sigue en curso tras ${Math.round(p.waitedMs / 1000)} s; no se ha escrito nada. Inténtalo de nuevo.`,
    'library.noteChanged': (p) => `${p.file} ha cambiado después de mostrar el cambio; no se ha guardado nada. Vuelve a mirarla y propón el cambio otra vez.`,
    'events.invalidSession': (p) =>
      `"${p.session}" no es un id de sesión válido (solo letras, dígitos, ".", "_" y "-").`,
    'events.sessionNotFound': (p) => `No hay ninguna sesión de creación "${p.session}" (no tiene events.jsonl).`,
    'web.invalidPort': (p) => `"${p.value}" no es un puerto válido (un número entero de 0 a 65535).`,
    'web.portInUse': (p) =>
      `El puerto ${p.port} ya está en uso. Vuelve a ejecutarlo con --port 0 para usar cualquier puerto libre.`,
    'web.uiNotBuilt': (p) => `La aplicación web no está compilada (falta ${p.dir}). Ejecuta antes npm run build.`,
    'web.invalidJson': (p) => `El cuerpo de la petición no es JSON válido: ${p.detail}`,
    'web.invalidBody': (p) => `El cuerpo de la petición no es válido:${bullets(p.issues)}`,
    'web.invalidQuery': (p) => `"${p.value}" no es un valor válido para "${p.name}".`,
    'web.bodyTooLarge': (p) => `El cuerpo de la petición ocupa más de ${p.limit} bytes.`,
    'web.unsupportedMediaType': (p) =>
      `El cuerpo de la petición debe ser JSON (Content-Type: application/json), no "${p.contentType}".`,
    'creation.unavailable': () => 'Este servidor no permite crear proyectos.',
    'creation.limit': (p) =>
      `Se ha llegado al límite de creaciones activas (${p.active.length} de ${p.limit}). Termina o cancela una, o sube el límite en Ajustes.`,
    'creation.noSpec': (p) => `La creación ${p.id} aún no ha mostrado ninguna spec.`,
    'creation.claudeNotFound': () =>
      'No se encontró Claude Code. Instálalo (https://claude.com/claude-code), inicia sesión con `claude` y vuelve a arrancar briefstack web.',
    'creation.slashCommandMissing': (p) =>
      `Claude Code no ha listado /${p.command} entre sus comandos, así que la creación no puede empezar. Comprueba que el repositorio de briefstack es la carpeta de trabajo y tiene .claude/skills/${p.command}.`,
    'creation.webToolsMissing': (p) =>
      `Claude Code ha arrancado sin las herramientas del navegador (${p.tools}; servidor MCP ${p.server}: ${p.status}), así que la aprobación de la spec no podría llegar a esta página. La creación se ha parado antes de hacer nada. Vuelve a arrancar briefstack web; si se repite, avisa con este mensaje.`,
    'creation.notFound': (p) => `No hay ninguna creación con id ${p.id}.`,
    'creation.noPending': (p) => `La creación ${p.id} no está esperando ninguna respuesta.`,
    'creation.wrongPending': (p) =>
      `Esa respuesta es para ${p.pendingId}, pero la creación espera ${p.expected}. Recarga e inténtalo de nuevo.`,
    'creation.invalidAnswer': (p) => `La respuesta a esta petición (${p.kind}) no es válida:${bullets(p.issues)}`,
    'creation.noReply': (p) => `La creación ${p.id} no está esperando una respuesta.`,
    'chat.unavailable': () => 'El chat no está disponible en este servidor.',
    'chat.threadNotFound': (p) => `No existe el chat ${p.id}.`,
    'chat.busy': () => 'El chat aún está respondiendo al último mensaje. Espera a que termine.',
    'chat.noConfirmation': (p) => `No hay nada con el id ${p.id} esperando confirmación.`,
    'improve.unavailable': () => 'Las mejoras no están disponibles en este servidor.',
    'improve.busy': (p) => `Ya hay una sesión de mejora en marcha (${p.id}). Espera a que termine.`,
    'improve.notFound': (p) => `No existe la propuesta ${p.id}.`,
    'improve.wrongState': (p) => `La propuesta ${p.id} no puede hacer eso ahora: está en estado ${p.status}.`,
    'improve.noRepo': (p) => `El repositorio de briefstack no puede recibir una mejora: ${p.reason}`,
    'improve.notOnBranch': (p) => `El repositorio está en ${p.current}, no en ${p.branch}, donde se preparó la propuesta. Vuelve a ${p.branch} e inténtalo de nuevo.`,
    'improve.uncommitted': (p) => `${p.file} tiene cambios sin commit en la parte que cambia la propuesta. Haz commit o descártalos primero.`,
    'improve.conflict': (p) => `${p.file} cambió desde que se preparó la propuesta, en las mismas líneas. Pide cambios para preparar una ronda nueva.`,
    'improve.baseChanged': (p) => `${p.file} cambió en ${p.branch} desde que se preparó la propuesta, así que lo que se comprobó y probó no es lo que se aplicaría. Pide cambios: la ronda nueva parte del ${p.branch} actual.`,
    'improve.staleReview': (p) => `La propuesta ${p.id} se volvió a comprobar desde que la página la mostró. Recarga la página, revisa la ronda nueva y aprueba esa.`,
    'improve.moved': () => 'La rama se movió mientras se aplicaba el cambio. No se cambió nada; inténtalo de nuevo.',
    'improve.noCheck': (p) => `La propuesta ${p.id} no tiene comprobación real que ejecutar.`,
    'improve.checkBusy': (p) => `La comprobación real de la propuesta ${p.id} ya está en marcha.`,
    'improve.suggestionNotFound': (p) => `No existe la sugerencia ${p.id}.`,
    'skills.invalidUrl': (p) => `${p.url} no es un enlace del que briefstack pueda traer una skill: ${skillUrlEs[p.reason]}`,
    'skills.repoNotFound': (p) => `GitHub no tiene ningún repositorio público ${p.owner}/${p.repo}. Los repositorios privados no se admiten.`,
    'skills.refNotFound': (p) => `GitHub no conoce la rama, etiqueta o commit de "${p.ref}".`,
    'skills.pathNotFound': (p) => `La carpeta ${p.path === '' ? '(raíz)' : p.path} no existe en esa rama, etiqueta o commit.`,
    'skills.noSkillFile': () => 'Esa carpeta no tiene SKILL.md en su primer nivel, así que no es una skill.',
    'skills.rateLimited': (p) =>
      `Se alcanzó el límite de GitHub para peticiones sin token.${p.reset === null ? ' Inténtalo más tarde.' : ` Inténtalo después de ${p.reset}.`}`,
    'skills.network': (p) => `No se pudo traer la skill: ${p.detail}.`,
    'skills.tooLarge': (p) =>
      p.what === 'files'
        ? `La skill tiene ${p.actual} archivos; el límite es ${p.limit}.`
        : p.what === 'file'
          ? `${p.path ?? 'Un archivo'} tiene ${p.actual} bytes; el límite por archivo es ${p.limit}.`
          : `La skill tiene ${p.actual} bytes en total; el límite es ${p.limit}.`,
    'skills.forbiddenEntry': (p) => `Se rechazó la skill: ${skillEntryEs[p.kind]}${p.path === '' ? '' : ` (${p.path})`}.`,
    'skills.integrity': (p) => `${p.path} no coincidía con el contenido del commit, así que no se guardó nada. Inténtalo de nuevo.`,
    'skills.unavailable': () => 'Las skills no están disponibles en este servidor.',
    'skills.notFound': (p) => `No hay ninguna skill ${p.name} en la biblioteca.`,
    'skills.unreadable': (p) => `No se puede leer la nota de metadatos de la skill ${p.name}. Corrígela en la biblioteca o borra la skill.`,
    'skills.invalidName': (p) => `"${p.name}" no puede ser el nombre de una skill: usa minúsculas, dígitos y guiones, como mucho 64 caracteres.`,
    'skills.invalidTag': (p) => `"${p.tag}" no es una etiqueta: usa minúsculas, dígitos y guiones, como mucho 30 caracteres y 10 etiquetas.`,
    'skills.exists': (p) =>
      p.sameSource
        ? `La skill ${p.name} ya está en la biblioteca. Usa "Buscar una versión nueva" en su página.`
        : `La biblioteca ya tiene una skill llamada ${p.name}, de otro origen. Bórrala primero para añadir esta.`,
    'skills.wrongStatus': (p) => `La skill ${p.name} está en estado ${p.status}, así que no puede ${p.action === 'checkUpdate' ? 'buscar una versión nueva (solo las aprobadas pueden)' : p.action === 'approve' ? 'aprobarse' : p.action === 'reject' ? 'rechazarse' : p.action}.`,
    'skills.modified': (p) => `Los archivos de la skill ${p.name} cambiaron desde que se revisaron (${p.path}). Borra la skill y añádela de nuevo.`,
    'skills.fileNotFound': (p) => `La skill ${p.name} no tiene ningún archivo ${p.path}.`,
    'skills.updatePending': (p) => `Ya hay una versión nueva de la skill ${p.name} esperando aprobación. Apruébala o recházala primero.`,
    'skills.noUpdate': (p) => `La skill ${p.name} no tiene ninguna versión nueva esperando.`,
    'skills.notApproved': (p) => `La skill ${p.name} está en estado ${p.status}; solo se pueden instalar las aprobadas.`,
    'skills.projectNotFound': (p) => `No existe la carpeta de proyecto ${p.dir}.`,
    'skills.notAProject': (p) => `${p.dir} no lo creó briefstack (no tiene .briefstack/spec.json).`,
    'skills.alreadyInstalled': (p) => `La skill ${p.name} ya está instalada en este proyecto.`,
    'skills.wouldOverwrite': (p) => `${p.path} ya existe en el proyecto; no se sobrescribió nada.`,
    'skills.installRecordInvalid': (p) => `No se puede leer ${p.file}. Corrígelo o bórralo y vuelve a instalar.`,
    'usage.high': (p) =>
      `El uso del plan está alto: ventana de 5 horas ${p.fiveHour ?? '?'} % (aviso desde ${p.warnFiveHour} %), semana ${p.sevenDay ?? '?'} % (aviso desde ${p.warnWeek} %). Empieza de todos modos para seguir.`,
  },
});

export function formatError(error: BriefstackError, lang: Lang): string {
  const format = errors[lang][error.code] as (p: ErrorParams[ErrorCode]) => string;
  return format(error.params);
}
