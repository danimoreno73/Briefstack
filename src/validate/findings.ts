import type { ApplicationFileKind, SpecIssue } from '../spec/index.js';
import type { SecretKind } from './secrets.js';

export { SECRET_KINDS, type SecretKind } from './secrets.js';

/** Kinds of machine-specific absolute paths. */
export const ABSOLUTE_PATH_KINDS = ['homeDir', 'windowsDrive', 'usersDir', 'homeFolder'] as const;
export type AbsolutePathKind = (typeof ABSOLUTE_PATH_KINDS)[number];

export type FrontmatterProblem = 'unclosed' | 'invalidYaml' | 'notAMapping';

type NoParams = Record<string, never>;

/**
 * Parameters for each validation rule. Like `ErrorParams`, they carry data,
 * never user-facing text: `src/i18n/validate.ts` renders them.
 */
export interface FindingParams {
  'spec.invalidJson': { detail: string };
  'spec.invalid': { issues: SpecIssue[] };
  'target.unknown': NoParams;
  'required.missing': { kind: 'file' | 'gitRepo' };
  'required.empty': NoParams;
  'frontmatter.missing': NoParams;
  'frontmatter.invalid': { problem: FrontmatterProblem; detail: string };
  'frontmatter.missingField': { field: string };
  'agent.invalidTools': NoParams;
  'agent.toolsOmitted': NoParams;
  'agent.spawnTool': { tool: string };
  'agent.invalidModel': { value: string };
  'agent.invalidEffort': { value: string };
  'skill.missingFile': NoParams;
  'claudeMd.tooLong': { lines: number; limit: number };
  'code.applicationFile': { kind: ApplicationFileKind };
  'secret.found': { kind: SecretKind };
  'path.absolute': { kind: AbsolutePathKind; match: string };
  'link.wikilink': { target: string };
  'link.relative': { target: string };
  'settings.invalidJson': { detail: string };
  'settings.noDeny': NoParams;
  'settings.hooks': NoParams;
  'settings.allow': NoParams;
  'settings.missingDenyRule': { rule: string };
  'librarySkill.invalidRecord': NoParams;
  'librarySkill.missing': { name: string };
  'librarySkill.modified': { name: string; path: string };
  'librarySkill.notInstalled': { name: string };
  'librarySkill.notChosen': { name: string };
  'librarySkill.nextSteps': { name: string; location: string };
  'librarySkill.unapproved': { name: string; path: string };
}

export type RuleId = keyof FindingParams;
export type Severity = 'error' | 'warning';

/** Severity of every rule, in one table. */
export const RULE_SEVERITY: { readonly [R in RuleId]: Severity } = {
  'spec.invalidJson': 'error',
  'spec.invalid': 'error',
  'target.unknown': 'warning',
  'required.missing': 'error',
  'required.empty': 'error',
  'frontmatter.missing': 'error',
  'frontmatter.invalid': 'error',
  'frontmatter.missingField': 'error',
  'agent.invalidTools': 'error',
  'agent.toolsOmitted': 'error',
  'agent.spawnTool': 'error',
  'agent.invalidModel': 'error',
  'agent.invalidEffort': 'error',
  'skill.missingFile': 'warning',
  'claudeMd.tooLong': 'error',
  'code.applicationFile': 'error',
  'secret.found': 'error',
  'path.absolute': 'error',
  'link.wikilink': 'error',
  'link.relative': 'error',
  'settings.invalidJson': 'error',
  'settings.noDeny': 'error',
  'settings.hooks': 'error',
  'settings.allow': 'error',
  'settings.missingDenyRule': 'warning',
  'librarySkill.invalidRecord': 'error',
  'librarySkill.missing': 'error',
  'librarySkill.modified': 'error',
  'librarySkill.notInstalled': 'error',
  'librarySkill.notChosen': 'error',
  'librarySkill.nextSteps': 'error',
  'librarySkill.unapproved': 'error',
};

export type Finding = {
  [R in RuleId]: {
    rule: R;
    severity: Severity;
    /** Relative to the project, with `/` separators. */
    file?: string;
    /** 1-based. */
    line?: number;
    params: FindingParams[R];
  };
}[RuleId];

/** Where a finding points, without its rule. */
export interface Location {
  file?: string;
  line?: number;
}

export function finding<R extends RuleId>(
  rule: R,
  params: FindingParams[R],
  location: Location = {},
): Finding {
  const result: { rule: R; severity: Severity; file?: string; line?: number; params: FindingParams[R] } = {
    rule,
    severity: RULE_SEVERITY[rule],
    params,
  };
  if (location.file !== undefined) result.file = location.file;
  if (location.line !== undefined) result.line = location.line;
  return result as Finding;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Deterministic order in code-point order: project-level findings first,
 * then by file, line, rule and parameters.
 */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    compare(a.file ?? '', b.file ?? '') ||
    (a.line ?? 0) - (b.line ?? 0) ||
    compare(a.rule, b.rule) ||
    compare(JSON.stringify(a.params), JSON.stringify(b.params))
  );
}
