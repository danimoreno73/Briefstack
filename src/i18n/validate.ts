import type {
  AbsolutePathKind,
  Finding,
  FindingParams,
  FrontmatterProblem,
  RuleId,
  SecretKind,
  Severity,
} from '../validate/findings.js';
import { defineCatalogue, type Lang } from './index.js';
import { formatSpecIssue } from './spec.js';

const secretEn: Record<SecretKind, string> = {
  privateKey: 'a private key block',
  anthropic: 'an Anthropic API key',
  openai: 'an OpenAI API key',
  aws: 'an AWS access key ID',
  github: 'a GitHub token',
  slack: 'a Slack token',
  google: 'a Google API key',
  stripe: 'a Stripe live key',
  assignment: 'a hard-coded credential',
};
const secretEs: Record<SecretKind, string> = {
  privateKey: 'un bloque de clave privada',
  anthropic: 'una clave de API de Anthropic',
  openai: 'una clave de API de OpenAI',
  aws: 'un ID de clave de acceso de AWS',
  github: 'un token de GitHub',
  slack: 'un token de Slack',
  google: 'una clave de API de Google',
  stripe: 'una clave live de Stripe',
  assignment: 'una credencial escrita en el archivo',
};

const pathEn: Record<AbsolutePathKind, string> = {
  homeDir: 'this machine\'s home folder',
  windowsDrive: 'a Windows drive path',
  usersDir: 'a macOS user folder',
  homeFolder: 'a Linux user folder',
};
const pathEs: Record<AbsolutePathKind, string> = {
  homeDir: 'la carpeta personal de esta máquina',
  windowsDrive: 'una ruta de unidad de Windows',
  usersDir: 'una carpeta de usuario de macOS',
  homeFolder: 'una carpeta de usuario de Linux',
};

const problemEn: Record<FrontmatterProblem, string> = {
  unclosed: 'it starts with --- but is never closed',
  invalidYaml: 'it is not valid YAML',
  notAMapping: 'it must be a set of key: value fields',
};
const problemEs: Record<FrontmatterProblem, string> = {
  unclosed: 'empieza con --- pero no se cierra',
  invalidYaml: 'no es YAML válido',
  notAMapping: 'debe ser una lista de campos clave: valor',
};

const withDetail = (text: string, detail: string): string => (detail === '' ? text : `${text}: ${detail}`);
const bullets = (lines: readonly string[]): string => lines.map((line) => `\n      - ${line}`).join('');

type RuleMessages = { [R in RuleId]: (p: FindingParams[R]) => string };

const rules = defineCatalogue<RuleMessages>({
  en: {
    'spec.invalidJson': (p) => `The spec is not valid JSON: ${p.detail}`,
    'spec.invalid': (p) =>
      `The spec is not valid:${bullets(p.issues.map((issue) => formatSpecIssue(issue, 'en')))}`,
    'target.unknown': () =>
      'The target could not be read from .briefstack/spec.json; only the checks common to both targets ran.',
    'required.missing': (p) =>
      p.kind === 'gitRepo' ? 'The project is not an initialised git repository.' : 'Required file is missing.',
    'required.empty': () => 'Required file is empty.',
    'frontmatter.missing': () => 'No frontmatter: the file must start with a --- block.',
    'frontmatter.invalid': (p) => withDetail(`Frontmatter cannot be read: ${problemEn[p.problem]}`, p.detail),
    'frontmatter.missingField': (p) => `Frontmatter needs a non-empty "${p.field}".`,
    'agent.invalidTools': () => '"tools" must be a comma-separated text or a list of tool names.',
    'agent.toolsOmitted': () =>
      'No "tools" list: the agent gets every tool, including Agent, so it can launch other agents.',
    'agent.spawnTool': (p) => `"tools" includes ${p.tool}; generated agents may not launch other agents.`,
    'agent.invalidModel': (p) =>
      `"model: ${p.value}" is not valid. Use haiku, sonnet, opus, fable (optionally with [1m]), a full claude-... ID, or inherit.`,
    'agent.invalidEffort': (p) => `"effort: ${p.value}" is not valid. Use low, medium, high, xhigh or max.`,
    'skill.missingFile': () => 'Skill folder without SKILL.md; Claude Code will not load it.',
    'claudeMd.tooLong': (p) => `CLAUDE.md has ${p.lines} lines; keep it under ${p.limit}.`,
    'code.applicationFile': (p) =>
      `Application ${p.kind === 'source' ? 'source code' : 'build file'}: briefstack prepares the project; the project's own work is done later, inside it.`,
    'secret.found': (p) => `Looks like ${secretEn[p.kind]}. Remove it and keep secrets out of the project.`,
    'path.absolute': (p) =>
      `Absolute path from a real machine (${pathEn[p.kind]}): ${p.match}. Use a relative path or one starting with ~.`,
    'link.wikilink': (p) => `[[${p.target}]] does not match any note in the project.`,
    'link.relative': (p) => `Link target "${p.target}" does not exist in the project.`,
    'settings.invalidJson': (p) => `Not valid JSON: ${p.detail}`,
    'settings.noDeny': () => 'Must contain a permissions.deny list.',
    'settings.hooks': () =>
      'Must not declare hooks: project hooks run before the folder is trusted. Keep deny rules only.',
    'settings.allow': () =>
      'Must not contain permissions.allow; generated settings hold deny rules only.',
    'settings.missingDenyRule': (p) => `Default deny rule missing: ${p.rule}`,
    'librarySkill.invalidRecord': () => 'The record of installed library skills cannot be read.',
    'librarySkill.missing': (p) => `Library skill ${p.name} is recorded as installed but is not there. Run skills install again.`,
    'librarySkill.modified': (p) =>
      `Library skill ${p.name} differs from the approved files (${p.path}). Do not edit installed library skills; remove the change.`,
    'librarySkill.notInstalled': (p) => `The spec chose library skill ${p.name}, but it is not installed. Run skills install.`,
    'librarySkill.notChosen': (p) => `Library skill ${p.name} is installed, but the spec's librarySkills does not choose it. Remove it: only skills the user approved in the spec may be installed.`,
    'librarySkill.nextSteps': (p) => `NEXT_STEPS.md does not mention ${p.location}, so the user will not know to add skill ${p.name} in the app.`,
  },
  es: {
    'spec.invalidJson': (p) => `La spec no es JSON válido: ${p.detail}`,
    'spec.invalid': (p) =>
      `La spec no es válida:${bullets(p.issues.map((issue) => formatSpecIssue(issue, 'es')))}`,
    'target.unknown': () =>
      'No se pudo leer el target de .briefstack/spec.json; solo se hicieron las comprobaciones comunes a ambos targets.',
    'required.missing': (p) =>
      p.kind === 'gitRepo'
        ? 'El proyecto no es un repositorio git inicializado.'
        : 'Falta un archivo obligatorio.',
    'required.empty': () => 'Un archivo obligatorio está vacío.',
    'frontmatter.missing': () => 'Sin frontmatter: el archivo debe empezar con un bloque ---.',
    'frontmatter.invalid': (p) => withDetail(`No se puede leer el frontmatter: ${problemEs[p.problem]}`, p.detail),
    'frontmatter.missingField': (p) => `El frontmatter necesita un "${p.field}" no vacío.`,
    'agent.invalidTools': () =>
      '"tools" debe ser un texto separado por comas o una lista de nombres de herramientas.',
    'agent.toolsOmitted': () =>
      'Sin lista "tools": el agente recibe todas las herramientas, incluida Agent, y puede lanzar otros agentes.',
    'agent.spawnTool': (p) => `"tools" incluye ${p.tool}; los agentes generados no pueden lanzar otros agentes.`,
    'agent.invalidModel': (p) =>
      `"model: ${p.value}" no es válido. Usa haiku, sonnet, opus, fable (opcionalmente con [1m]), un ID completo claude-... o inherit.`,
    'agent.invalidEffort': (p) => `"effort: ${p.value}" no es válido. Usa low, medium, high, xhigh o max.`,
    'skill.missingFile': () => 'Carpeta de skill sin SKILL.md; Claude Code no la cargará.',
    'claudeMd.tooLong': (p) => `CLAUDE.md tiene ${p.lines} líneas; mantenlo por debajo de ${p.limit}.`,
    'code.applicationFile': (p) =>
      `${p.kind === 'source' ? 'Código fuente' : 'Archivo de build'} de la aplicación: briefstack prepara el proyecto; el trabajo del proyecto se hace después, dentro de él.`,
    'secret.found': (p) =>
      `Parece ${secretEs[p.kind]}. Elimínala y mantén los secretos fuera del proyecto.`,
    'path.absolute': (p) =>
      `Ruta absoluta de una máquina real (${pathEs[p.kind]}): ${p.match}. Usa una ruta relativa o que empiece por ~.`,
    'link.wikilink': (p) => `[[${p.target}]] no coincide con ninguna nota del proyecto.`,
    'link.relative': (p) => `El destino del enlace "${p.target}" no existe en el proyecto.`,
    'settings.invalidJson': (p) => `No es JSON válido: ${p.detail}`,
    'settings.noDeny': () => 'Debe contener una lista permissions.deny.',
    'settings.hooks': () =>
      'No debe declarar hooks: los hooks del proyecto se ejecutan antes de confiar en la carpeta. Deja solo reglas deny.',
    'settings.allow': () =>
      'No debe contener permissions.allow; los ajustes generados solo llevan reglas deny.',
    'settings.missingDenyRule': (p) => `Falta una regla deny por defecto: ${p.rule}`,
    'librarySkill.invalidRecord': () => 'No se puede leer el registro de skills de la biblioteca instaladas.',
    'librarySkill.missing': (p) => `La skill de la biblioteca ${p.name} figura como instalada pero no está. Ejecuta skills install de nuevo.`,
    'librarySkill.modified': (p) =>
      `La skill de la biblioteca ${p.name} no coincide con los archivos aprobados (${p.path}). No edites las skills instaladas de la biblioteca; quita el cambio.`,
    'librarySkill.notInstalled': (p) => `La spec eligió la skill de la biblioteca ${p.name}, pero no está instalada. Ejecuta skills install.`,
    'librarySkill.notChosen': (p) => `La skill de la biblioteca ${p.name} está instalada, pero librarySkills de la spec no la elige. Quítala: solo se pueden instalar las skills que el usuario aprobó en la spec.`,
    'librarySkill.nextSteps': (p) => `NEXT_STEPS.md no menciona ${p.location}, así que el usuario no sabrá que debe añadir la skill ${p.name} en la app.`,
  },
});

const severityLabel = defineCatalogue<Record<Severity, string>>({
  en: { error: 'error', warning: 'warning' },
  es: { error: 'error', warning: 'aviso' },
});

export const validateMessages = defineCatalogue({
  en: {
    usage: 'briefstack validate <project-dir> [--json]',
    clean: (dir: string) => `${dir}: no problems found.`,
    summary: (dir: string, errors: number, warnings: number) =>
      `${dir}: ${errors} ${errors === 1 ? 'error' : 'errors'}, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}.`,
  },
  es: {
    usage: 'briefstack validate <carpeta-proyecto> [--json]',
    clean: (dir: string) => `${dir}: no se han encontrado problemas.`,
    summary: (dir: string, errors: number, warnings: number) =>
      `${dir}: ${errors} ${errors === 1 ? 'error' : 'errores'}, ${warnings} ${warnings === 1 ? 'aviso' : 'avisos'}.`,
  },
});

/** The finding's message without location or severity. */
export function formatFindingMessage(item: Finding, lang: Lang): string {
  const format = rules[lang][item.rule] as (p: FindingParams[RuleId]) => string;
  return format(item.params);
}

/** One line such as `error  CLAUDE.md:61  CLAUDE.md has 75 lines; ...`. */
export function formatFinding(item: Finding, lang: Lang): string {
  const where = item.file === undefined ? '' : item.line === undefined ? item.file : `${item.file}:${item.line}`;
  const label = severityLabel[lang][item.severity].padEnd(7);
  return where === ''
    ? `${label} ${formatFindingMessage(item, lang)}`
    : `${label} ${where}  ${formatFindingMessage(item, lang)}`;
}
