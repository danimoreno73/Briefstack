import type { SpecIssue, SpecRule } from '../spec/index.js';
import { defineCatalogue, type Lang } from './index.js';

/** Most rules are one sentence; the tool rules name the tool and its replacement. */
type RuleText = string | ((issue: SpecIssue) => string);

const rules = defineCatalogue<Record<SpecRule, RuleText>>({
  en: {
    slug: 'use lowercase letters, digits and single hyphens (e.g. my-project)',
    safePath:
      'use a relative path with / separators, no "..", and no characters or names Windows rejects',
    reservedPath:
      'briefstack writes this path itself (.git, .briefstack, .gitignore, .claude settings, agents and skills)',
    toolName: 'not a valid tool name (e.g. Read, Bash(npm test:*), mcp__server__tool)',
    noAgentTool: 'generated agents may not launch other agents',
    unknownTool: (issue) =>
      `"${issue.tool ?? ''}" is not a Claude Code tool: use a built-in tool name (e.g. Read, Grep, Glob, Edit, Write, Bash, WebFetch) or an MCP tool (mcp__server__tool)`,
    retiredTool: (issue) => `"${issue.tool ?? ''}" is no longer a Claude Code tool: use ${issue.replacement ?? 'another tool'} instead`,
    duplicate: 'duplicate (names and paths are compared ignoring case)',
    claudeCodeOnly: 'only allowed when target is claude-code',
    documentOnly:
      'briefstack writes documents only (.md, .txt, .csv); application code, tests and build files are written later, in the project',
    unknownAgent: 'names no agent of this spec (leave it out for the whole project)',
    librarySkill: 'is not an approved skill of the library',
  },
  es: {
    slug: 'usa minúsculas, dígitos y guiones simples (p. ej. mi-proyecto)',
    safePath:
      'usa una ruta relativa con separadores /, sin "..", y sin caracteres ni nombres que Windows rechace',
    reservedPath:
      'briefstack escribe esta ruta por su cuenta (.git, .briefstack, .gitignore, ajustes, agentes y skills de .claude)',
    toolName: 'no es un nombre de herramienta válido (p. ej. Read, Bash(npm test:*), mcp__servidor__herramienta)',
    noAgentTool: 'los agentes generados no pueden lanzar otros agentes',
    unknownTool: (issue) =>
      `"${issue.tool ?? ''}" no es una herramienta de Claude Code: usa un nombre de herramienta integrada (p. ej. Read, Grep, Glob, Edit, Write, Bash, WebFetch) o una herramienta MCP (mcp__servidor__herramienta)`,
    retiredTool: (issue) => `"${issue.tool ?? ''}" ya no es una herramienta de Claude Code: usa ${issue.replacement ?? 'otra herramienta'} en su lugar`,
    duplicate: 'duplicado (los nombres y rutas se comparan sin distinguir mayúsculas)',
    claudeCodeOnly: 'solo se permite cuando target es claude-code',
    documentOnly:
      'briefstack solo escribe documentos (.md, .txt, .csv); el código de la aplicación, los tests y los archivos de build se escriben después, en el proyecto',
    unknownAgent: 'no nombra ningún agente de esta spec (quítalo para todo el proyecto)',
    librarySkill: 'no es una skill aprobada de la biblioteca',
  },
});

export function formatSpecIssue(issue: SpecIssue, lang: Lang): string {
  const where = issue.path === '' ? '(spec)' : issue.path;
  const text = issue.rule === undefined ? issue.message : rules[lang][issue.rule];
  const what = typeof text === 'function' ? text(issue) : text;
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