/**
 * What self-improvement may change (BRIEF-phase-5 §3.1). This module, the
 * locked-block markers (`locked.ts`) and the filters (`filters.ts`) are the
 * rules an improvement is checked against; none of them is in the
 * allowlist, so an improvement can never change them.
 *
 * Allowed, and only as edits of files that already exist (no new, deleted
 * or renamed files):
 * - the body of each agent file `.claude/agents/<name>.md` (never its
 *   frontmatter: `tools`, `model` and `effort` stay as they are);
 * - the body of the `/new-project` skill (never its frontmatter);
 * - the base library's templates and rules, `library/templates/**` and
 *   `library/rules/**`, whole files.
 *
 * Everything else is out of reach: `src/`, `scripts/`, `tests/`, settings
 * files, hooks, `package*.json`, CI, the briefs and plans, `CLAUDE.md`, the
 * usage profiles and the library's skills.
 */

export type AssetKind = 'agent' | 'skill' | 'library';

export interface AllowedAsset {
  kind: AssetKind;
  /** Only the text after the frontmatter may change. */
  bodyOnly: boolean;
}

/** The skill an improvement may change. */
export const SKILL_FILE = '.claude/skills/new-project/SKILL.md';

const AGENT_RE = /^\.claude\/agents\/[a-z0-9][a-z0-9-]*\.md$/;
const LIBRARY_ROOTS = ['library/templates/', 'library/rules/'] as const;
/** A path segment the library part may use: no `..`, no empty segment, no git or settings folder. */
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$|^\.gitignore$/;
const FORBIDDEN_SEGMENTS = new Set(['.git', '.claude', 'node_modules']);

/**
 * The asset a repo-relative path names, or `undefined` when an improvement
 * may not touch it. The path must use `/`, be relative and match exactly
 * (case included): anything else is refused.
 */
export function classifyAsset(relative: string): AllowedAsset | undefined {
  if (relative === '' || relative.includes('\\') || relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) return undefined;
  if (relative === SKILL_FILE) return { kind: 'skill', bodyOnly: true };
  if (AGENT_RE.test(relative)) return { kind: 'agent', bodyOnly: true };
  const root = LIBRARY_ROOTS.find((prefix) => relative.startsWith(prefix));
  if (root === undefined) return undefined;
  const segments = relative.slice(root.length).split('/');
  if (segments.length === 0 || segments.some((segment) => !SAFE_SEGMENT.test(segment) || FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))) {
    return undefined;
  }
  return { kind: 'library', bodyOnly: false };
}

export function isAllowedAsset(relative: string): boolean {
  return classifyAsset(relative) !== undefined;
}

/** What the session is told it may change, in the prompt. */
export const ALLOWLIST_TEXT = [
  '- the body of an existing agent file in `.claude/agents/` (never the frontmatter between the `---` lines);',
  `- the body of \`${SKILL_FILE}\` (never its frontmatter);`,
  '- existing files under `library/templates/` and `library/rules/`.',
  'Only edits of files that exist: no new, deleted or renamed files. Everything else is out of reach.',
].join('\n');
