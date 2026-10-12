import type {
  BriefstackError,
  ErrorCode,
  ErrorParams,
  FieldExpectation,
  ProtectedRoot,
  SettingsField,
} from '../errors.js';
import { defineCatalogue, type Lang } from './index.js';
import { formatSpecIssue } from './spec.js';

const expectationEn: Record<FieldExpectation, string> = {
  text: 'a non-empty text',
  lang: 'one of: en, es',
};
const expectationEs: Record<FieldExpectation, string> = {
  text: 'un texto no vacío',
  lang: 'uno de: en, es',
};

const rootEn: Record<ProtectedRoot, string> = {
  repo: 'the briefstack repo',
  library: 'the personal library',
};
const rootEs: Record<ProtectedRoot, string> = {
  repo: 'el repo de briefstack',
  library: 'la biblioteca personal',
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

const bullets = (lines: readonly string[]): string => lines.map((line) => `\n  - ${line}`).join('');

type ErrorMessages = { [C in ErrorCode]: (p: ErrorParams[C]) => string };

const errors = defineCatalogue<ErrorMessages>({
  en: {
    'config.invalidJson': (p) => `Config file ${p.file} is not valid JSON: ${p.detail}`,
    'config.notAnObject': (p) => `Config file ${p.file} must contain a JSON object.`,
    'config.invalidField': (p) =>
      `Config file ${p.file}: "${p.field}" must be ${expectationEn[p.expected]}.`,
    'config.relativePath': (p) =>
      `${p.source} must be an absolute path or start with ~ (got "${p.value}").`,
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
  },
  es: {
    'config.invalidJson': (p) =>
      `El archivo de configuración ${p.file} no es JSON válido: ${p.detail}`,
    'config.notAnObject': (p) =>
      `El archivo de configuración ${p.file} debe contener un objeto JSON.`,
    'config.invalidField': (p) =>
      `Archivo de configuración ${p.file}: "${p.field}" debe ser ${expectationEs[p.expected]}.`,
    'config.relativePath': (p) =>
      `${p.source} debe ser una ruta absoluta o empezar por ~ (se recibió "${p.value}").`,
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
  },
});

export function formatError(error: BriefstackError, lang: Lang): string {
  const format = errors[lang][error.code] as (p: ErrorParams[ErrorCode]) => string;
  return format(error.params);
}
