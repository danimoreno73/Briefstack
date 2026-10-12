import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { systemPathEnv, type PathEnv } from '../config/paths.js';
import { BriefstackError, isBriefstackError } from '../errors.js';
import { DENY_RULES } from '../scaffold/secrets.js';
import { TARGETS, parseSpec, type Target } from '../spec/index.js';
import { checkAgentFile, checkSkillFile } from './agents.js';
import { compareFindings, finding, type Finding } from './findings.js';
import { extractLinks, resolvesRelative, resolvesWikilink, type ProjectPaths } from './links.js';
import { findAbsolutePaths, findSecrets } from './text.js';

export * from './findings.js';
export {
  EFFORT_LEVELS,
  MODEL_ALIASES,
  SPAWN_TOOLS,
  checkAgentFile,
  checkSkillFile,
  isValidEffort,
  isValidModel,
  splitToolList,
} from './agents.js';
export { extractLinks, maskCode, resolvesRelative, resolvesWikilink, type MarkdownLink, type ProjectPaths } from './links.js';
export { findAbsolutePaths, findSecrets, looksRandom, type AbsolutePathMatch } from './text.js';

export const SPEC_FILE = '.briefstack/spec.json';
export const SETTINGS_FILE = '.claude/settings.json';
/** `CLAUDE.md` must stay under this many lines. */
export const CLAUDE_MD_LINE_LIMIT = 60;
/** Larger files are not scanned for secrets, paths or links. */
export const MAX_SCANNED_BYTES = 2 * 1024 * 1024;
/** Names never scanned, at any depth: folders, and a `.git` file. */
export const SKIPPED_DIRS: readonly string[] = ['.git', 'node_modules'];

/** `.git` means an initialised git repository (folder, or file for worktrees). */
export const GIT_MARKER = '.git';

/** Files each target must contain, non-empty (BRIEF §5, PLAN "Targets"). */
export const REQUIRED_FILES: { readonly [T in Target]: readonly string[] } = {
  'claude-code': [
    'CLAUDE.md',
    'docs/BRIEF.md',
    SETTINGS_FILE,
    '.gitignore',
    '.briefstack/profile.json',
    SPEC_FILE,
    GIT_MARKER,
  ],
  'claude-app': [
    'INSTRUCTIONS.md',
    'NEXT_STEPS.md',
    'docs/BRIEF.md',
    '.gitignore',
    '.briefstack/profile.json',
    SPEC_FILE,
    GIT_MARKER,
  ],
};

/** Required whatever the target; used when the target cannot be read. */
const COMMON_REQUIRED: readonly string[] = REQUIRED_FILES['claude-code'].filter((file) =>
  REQUIRED_FILES['claude-app'].includes(file),
);

export interface ValidateOptions {
  /** Home directory and path style for absolute-path detection. */
  pathEnv?: PathEnv;
}

export interface ValidationResult {
  projectDir: string;
  /** `undefined` when the spec is missing or has no valid target. */
  target: Target | undefined;
  /** Sorted with `compareFindings`. */
  findings: Finding[];
  errors: number;
  warnings: number;
}

interface Walk extends ProjectPaths {
  /** Regular files whose content can be scanned (not symlinks, not a `.git` file). */
  regular: string[];
}

async function walk(root: string): Promise<Walk> {
  const files: string[] = [];
  const directories: string[] = [];
  const regular: string[] = [];
  const visit = async (relative: string): Promise<void> => {
    const absolute = relative === '' ? root : path.join(root, ...relative.split('/'));
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.includes(entry.name)) continue;
        directories.push(child);
        await visit(child);
      } else {
        files.push(child);
        // A `.git` file (worktree or submodule) holds git's own absolute path.
        if (entry.isFile() && !SKIPPED_DIRS.includes(entry.name)) regular.push(child);
      }
    }
  };
  await visit('');
  const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return { files: files.sort(byCodePoint), directories: directories.sort(byCodePoint), regular: regular.sort(byCodePoint) };
}

/** UTF-8 text, or `undefined` for binary and oversized files. */
async function readText(absolute: string): Promise<string | undefined> {
  const info = await stat(absolute);
  if (info.size > MAX_SCANNED_BYTES) return undefined;
  const buffer = await readFile(absolute);
  if (buffer.subarray(0, 8000).includes(0)) return undefined;
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

const splitLines = (text: string): string[] => {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const errorDetail = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface SpecCheck {
  target: Target | undefined;
  findings: Finding[];
}

/** Reads the target from the spec. A missing spec is left to the required-files rule. */
function checkSpec(text: string | undefined): SpecCheck {
  if (text === undefined || text.trim() === '') return { target: undefined, findings: [] };
  const file = SPEC_FILE;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { target: undefined, findings: [finding('spec.invalidJson', { detail: errorDetail(error) }, { file })] };
  }
  try {
    return { target: parseSpec(data, file).target, findings: [] };
  } catch (error) {
    if (!isBriefstackError(error) || error.code !== 'spec.invalid') throw error;
    const issues = (error as BriefstackError<'spec.invalid'>).params.issues;
    // Still use the target when it is valid, so the other checks can run.
    const raw = typeof data === 'object' && data !== null ? (data as { target?: unknown }).target : undefined;
    const target = TARGETS.find((candidate) => candidate === raw);
    return { target, findings: [finding('spec.invalid', { issues }, { file })] };
  }
}

/**
 * `.claude/settings.json` holds deny rules only: no hooks (they run before
 * the folder is trusted) and no allow rules (`decisions.md` §8).
 */
export function checkSettings(text: string, requireDeny: boolean): Finding[] {
  const file = SETTINGS_FILE;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return [finding('settings.invalidJson', { detail: errorDetail(error) }, { file })];
  }
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isObject(data)) return [finding('settings.noDeny', {}, { file })];

  const findings: Finding[] = [];
  if (data.hooks !== undefined) findings.push(finding('settings.hooks', {}, { file }));
  const permissions = isObject(data.permissions) ? data.permissions : {};
  if (permissions.allow !== undefined) findings.push(finding('settings.allow', {}, { file }));

  const deny = permissions.deny;
  if (!Array.isArray(deny)) {
    if (requireDeny) findings.push(finding('settings.noDeny', {}, { file }));
  } else {
    for (const rule of DENY_RULES) {
      if (!deny.includes(rule)) findings.push(finding('settings.missingDenyRule', { rule }, { file }));
    }
  }
  return findings;
}

/** Findings for text content: secrets, machine paths, and links in markdown. */
function scanText(text: string, file: string, paths: ProjectPaths, pathEnv: PathEnv): Finding[] {
  const findings: Finding[] = [];
  splitLines(text).forEach((line, index) => {
    const location = { file, line: index + 1 };
    for (const kind of findSecrets(line)) findings.push(finding('secret.found', { kind }, location));
    for (const match of findAbsolutePaths(line, pathEnv)) {
      findings.push(finding('path.absolute', { kind: match.kind, match: match.match }, location));
    }
  });
  if (file.toLowerCase().endsWith('.md')) {
    for (const link of extractLinks(text)) {
      const location = { file, line: link.line };
      if (link.kind === 'wikilink' && !resolvesWikilink(link.target, paths)) {
        findings.push(finding('link.wikilink', { target: link.target }, location));
      }
      if (link.kind === 'relative' && !resolvesRelative(link.target, file, paths)) {
        findings.push(finding('link.relative', { target: link.target }, location));
      }
    }
  }
  return findings;
}

const AGENT_FILE_RE = /^\.claude\/agents\/[^/]+\.md$/;
const SKILL_FILE_RE = /^\.claude\/skills\/[^/]+\/SKILL\.md$/;
const SKILL_DIR_RE = /^\.claude\/skills\/[^/]+$/;

/**
 * Checks a generated project (BRIEF §6). Never writes anything. Throws only
 * when `projectDir` is not a folder; every problem inside it is a finding.
 */
export async function validateProject(projectDir: string, options: ValidateOptions = {}): Promise<ValidationResult> {
  const pathEnv = options.pathEnv ?? systemPathEnv();
  const root = path.resolve(projectDir);
  try {
    if (!(await stat(root)).isDirectory()) throw new BriefstackError('validate.notADirectory', { dir: root });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BriefstackError('validate.projectNotFound', { dir: root }, { cause: error });
    }
    throw error;
  }

  const tree = await walk(root);
  const texts = new Map<string, string>();
  for (const file of tree.regular) {
    const text = await readText(path.join(root, ...file.split('/')));
    if (text !== undefined) texts.set(file, text);
  }

  const findings: Finding[] = [];
  const spec = checkSpec(texts.get(SPEC_FILE));
  findings.push(...spec.findings);
  const { target } = spec;
  if (target === undefined) findings.push(finding('target.unknown', {}));

  // Required files.
  for (const required of target === undefined ? COMMON_REQUIRED : REQUIRED_FILES[target]) {
    const absolute = path.join(root, ...required.split('/'));
    let info;
    try {
      info = await lstat(absolute);
    } catch {
      info = undefined;
    }
    if (required === GIT_MARKER) {
      if (info === undefined) findings.push(finding('required.missing', { kind: 'gitRepo' }, { file: required }));
      continue;
    }
    if (info === undefined || !info.isFile()) {
      findings.push(finding('required.missing', { kind: 'file' }, { file: required }));
    } else if ((texts.get(required) ?? (info.size === 0 ? '' : 'binary')).trim() === '') {
      findings.push(finding('required.empty', {}, { file: required }));
    }
  }

  // Agent and skill frontmatter.
  for (const file of tree.regular) {
    const text = texts.get(file);
    if (text === undefined) continue;
    if (AGENT_FILE_RE.test(file)) findings.push(...checkAgentFile(text, file));
    if (SKILL_FILE_RE.test(file)) findings.push(...checkSkillFile(text, file));
  }
  for (const directory of tree.directories) {
    const skillFile = `${directory}/SKILL.md`;
    if (SKILL_DIR_RE.test(directory) && !tree.files.includes(skillFile)) {
      findings.push(finding('skill.missingFile', {}, { file: skillFile }));
    }
  }

  // CLAUDE.md length, only when the file exists.
  const claudeMd = texts.get('CLAUDE.md');
  if (claudeMd !== undefined) {
    const lines = claudeMd === '' ? 0 : splitLines(claudeMd).length;
    if (lines >= CLAUDE_MD_LINE_LIMIT) {
      findings.push(finding('claudeMd.tooLong', { lines, limit: CLAUDE_MD_LINE_LIMIT }, { file: 'CLAUDE.md' }));
    }
  }

  // Settings: deny rules only. Checked whenever the file exists.
  const settings = texts.get(SETTINGS_FILE);
  if (settings !== undefined && settings.trim() !== '') {
    findings.push(...checkSettings(settings, target === 'claude-code'));
  }

  // Secrets, machine paths and links in every text file.
  for (const [file, text] of texts) findings.push(...scanText(text, file, tree, pathEnv));

  findings.sort(compareFindings);
  const errors = findings.filter((item) => item.severity === 'error').length;
  return { projectDir: root, target, findings, errors, warnings: findings.length - errors };
}
