import type { SpecIssue, SpecRule } from '../spec/index.js';
import { defineCatalogue, type Lang } from './index.js';

const rules = defineCatalogue<Record<SpecRule, string>>({
  en: {
    slug: 'use lowercase letters, digits and single hyphens (e.g. my-project)',
    safePath:
      'use a relative path with / separators, no "..", and no characters or names Windows rejects',
    reservedPath:
      'briefstack writes this path itself (.git, .briefstack, .gitignore, .claude settings, agents and skills)',
    toolName: 'not a valid tool name (e.g. Read, Bash(npm test:*), mcp__server__tool)',
    noAgentTool: 'generated agents may not launch other agents',
    duplicate: 'duplicate (names and paths are compared ignoring case)',
    claudeCodeOnly: 'only allowed when target is claude-code',
    documentOnly:
      'briefstack writes documents only (.md, .txt, .csv); application code, tests and build files are written later, in the project',
  },
  es: {
    slug: 'usa minúsculas, dígitos y guiones simples (p. ej. mi-proyecto)',
    safePath:
      'usa una ruta relativa con separadores /, sin "..", y sin caracteres ni nombres que Windows rechace',
    reservedPath:
      'briefstack escribe esta ruta por su cuenta (.git, .briefstack, .gitignore, ajustes, agentes y skills de .claude)',
    toolName: 'no es un nombre de herramienta válido (p. ej. Read, Bash(npm test:*), mcp__servidor__herramienta)',
    noAgentTool: 'los agentes generados no pueden lanzar otros agentes',
    duplicate: 'duplicado (los nombres y rutas se comparan sin distinguir mayúsculas)',
    claudeCodeOnly: 'solo se permite cuando target es claude-code',
    documentOnly:
      'briefstack solo escribe documentos (.md, .txt, .csv); el código de la aplicación, los tests y los archivos de build se escriben después, en el proyecto',
  },
});

export function formatSpecIssue(issue: SpecIssue, lang: Lang): string {
  const where = issue.path === '' ? '(spec)' : issue.path;
  const what = issue.rule === undefined ? issue.message : rules[lang][issue.rule];
  return `${where}: ${what}`;
}

export const specMessages = defineCatalogue({
  en: {
    usage: 'briefstack spec check <spec.json>',
    valid: (name: string, slug: string, template: string, target: string, profile: string) =>
      `Valid spec: ${name} (${slug}), template ${template}, target ${target}, profile ${profile}.`,
  },
  es: {
    usage: 'briefstack spec check <spec.json>',
    valid: (name: string, slug: string, template: string, target: string, profile: string) =>
      `Spec válida: ${name} (${slug}), plantilla ${template}, destino ${target}, perfil ${profile}.`,
  },
});