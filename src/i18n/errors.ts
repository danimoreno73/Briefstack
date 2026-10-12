import type { BriefstackError, ErrorCode, ErrorParams, FieldExpectation } from '../errors.js';
import { defineCatalogue, type Lang } from './index.js';

const expectationEn: Record<FieldExpectation, string> = {
  text: 'a non-empty text',
  lang: 'one of: en, es',
};
const expectationEs: Record<FieldExpectation, string> = {
  text: 'un texto no vacío',
  lang: 'uno de: en, es',
};

type ErrorMessages = { [C in ErrorCode]: (p: ErrorParams[C]) => string };

const errors = defineCatalogue<ErrorMessages>({
  en: {
    'config.invalidJson': (p) => `Config file ${p.file} is not valid JSON: ${p.detail}`,
    'config.notAnObject': (p) => `Config file ${p.file} must contain a JSON object.`,
    'config.invalidField': (p) => `Config file ${p.file}: "${p.field}" must be ${expectationEn[p.expected]}.`,
    'config.relativePath': (p) =>
      `${p.source} must be an absolute path or start with ~ (got "${p.value}").`,
    'frontmatter.unclosed': (p) => `${p.file}: frontmatter starts with --- but is never closed.`,
    'frontmatter.invalidYaml': (p) => `${p.file}: frontmatter is not valid YAML: ${p.detail}`,
    'frontmatter.notAMapping': (p) => `${p.file}: frontmatter must be a set of key: value fields.`,
    'frontmatter.blockValue': (p) =>
      `${p.file}: "${p.field}" spans several lines; briefstack only rewrites single-line values.`,
  },
  es: {
    'config.invalidJson': (p) => `El archivo de configuración ${p.file} no es JSON válido: ${p.detail}`,
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
  },
});

export function formatError(error: BriefstackError, lang: Lang): string {
  const format = errors[lang][error.code] as (p: ErrorParams[ErrorCode]) => string;
  return format(error.params);
}
