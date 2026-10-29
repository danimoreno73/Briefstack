import { readFile } from 'node:fs/promises';
import { isPathInside, systemPathEnv, type PathEnv } from '../config/paths.js';
import { classifyPath, hasGitSegment } from '../creation/guard.js';
import { parseFrontmatter } from '../frontmatter/index.js';
import { realpathNearest } from '../scaffold/outputDir.js';

/**
 * The guard of a task session (BRIEF-phase-7 §3.2, §4). It decides every
 * tool call of the main session and its subagents:
 *
 * - only the task's tools (`TASK_BUILTIN_TOOLS`, `SubagentHandback` for
 *   subagents); anything else is denied;
 * - reads (`Read`, `Glob`, `Grep`) only inside the worktree, never in a
 *   `.git` folder; a `Glob` pattern must be relative and without `..`;
 * - writes (`Write`, `Edit`) only to files inside the worktree, never in
 *   `.git`, never to `.claude/settings*.json`, `.mcp.json` or hook files,
 *   and never a skill, command or agent file whose frontmatter would
 *   declare `hooks`;
 * - shell commands (`Bash`, `PowerShell`) and web tools are `ask`: the
 *   user decides each one in the task's dialog (`shell.ts`);
 * - the `Skill` tool only for the project's own skills;
 * - the `Agent` tool without `isolation` or `mode`.
 *
 * The project folder, the briefstack home, the library and the repo are out
 * of reach because nothing outside the worktree is allowed. Paths are
 * compared after links are resolved, so a link inside the worktree that
 * points outside it leads nowhere.
 */

export interface TaskGuardRules {
  /** The worktree the session works in. */
  worktree: string;
  /** The project's own skills and commands found at the start; the `Skill` tool takes no other. */
  skills: readonly string[];
}

export type TaskVerdict =
  | { verdict: 'allow'; reason: string }
  | { verdict: 'deny'; reason: string }
  /** The user decides: `key` is what "this exact one for the task" matches, byte for byte. */
  | { verdict: 'ask'; reason: string; kind: 'shell' | 'web'; key: string };

/**
 * The built-in tools a task session is offered (`--tools`). `Glob` and
 * `Grep` are named because macOS and Linux leave them out by default
 * (decisions.md, "Phase 7: H0"). `Skill` is added only when the project
 * has skills. No cron, routine, workflow, monitor, worktree or notebook
 * tool.
 */
export const TASK_BUILTIN_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'Bash',
  'PowerShell',
  'Agent',
  'AskUserQuestion',
  'WebSearch',
  'WebFetch',
  'ToolSearch',
] as const;

export const SKILL_TOOL = 'Skill';
const SUBAGENT_TOOLS = new Set(['SubagentHandback']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Write', 'Edit']);
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);
export const WEB_TOOLS: ReadonlySet<string> = new Set(['WebSearch', 'WebFetch']);
const FREE_TOOLS = new Set(['AskUserQuestion', 'ToolSearch']);

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const deny = (reason: string): TaskVerdict => ({ verdict: 'deny', reason });

/** Whether a glob pattern starts at a root of its own: absolute on any platform, a drive, a share, or `~`. */
function isRootedPattern(pattern: string, pathEnv: PathEnv): boolean {
  return pathEnv.pathApi.isAbsolute(pattern) || /^[\\/]/.test(pattern) || /^[A-Za-z]:/.test(pattern) || pattern.startsWith('~');
}

/** The segments of a path relative to the worktree, lower-cased where the file system ignores case. */
function segmentsOf(relative: string, pathEnv: PathEnv): string[] {
  const segments = relative.split(/[\\/]+/).filter((segment) => segment !== '');
  return pathEnv.caseInsensitive ? segments.map((segment) => segment.toLowerCase()) : segments;
}

/**
 * Why a file in the worktree may not be written by a task, or `undefined`:
 * settings files, `.mcp.json`, and hook files (`.claude/hooks/`, `.husky/`,
 * `.githooks/`) at any depth (BRIEF-phase-7 §3.2, §7).
 */
export function protectedProjectFile(relative: string, pathEnv: PathEnv = systemPathEnv()): string | undefined {
  const segments = segmentsOf(relative, pathEnv);
  const name = segments.at(-1) ?? '';
  const parent = segments.at(-2);
  if (parent === '.claude' && /^settings(\.local)?\.json$/i.test(name)) return 'Claude Code settings files are not changed by a task.';
  if (name === '.mcp.json') return '.mcp.json is not changed by a task.';
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (segment === '.husky' || segment === '.githooks') return 'Hook files are not changed by a task.';
    if (segment === '.claude' && segments[i + 1] === 'hooks') return 'Hook files are not changed by a task.';
  }
  return undefined;
}

/** Whether a worktree file is a skill, command or agent definition Claude Code reads: `.claude/{skills,commands,agents}/**.md`. */
export function isDefinitionFile(relative: string, pathEnv: PathEnv = systemPathEnv()): boolean {
  const segments = segmentsOf(relative, pathEnv);
  if (!(segments.at(-1) ?? '').endsWith('.md')) return false;
  return segments.some((segment, i) => segment === '.claude' && ['skills', 'commands', 'agents'].includes(segments[i + 1] ?? ''));
}

/**
 * Whether a definition file's text declares hooks, or cannot be read well
 * enough to tell (an unclosed or broken frontmatter): both are refused.
 * A `hooks:` line anywhere in the frontmatter counts, parsed or not.
 */
export function declaresHooks(text: string): boolean {
  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const block = /^---[ \t]*\r?\n([\s\S]*?)(?:\r?\n---[ \t]*(?:\r?\n|$)|$)/.exec(content);
  if (block === null) return false;
  if (/^[ \t]*["']?hooks["']?[ \t]*:/m.test(block[1] ?? '')) return true;
  try {
    const { data } = parseFrontmatter(content, 'definition');
    return Object.hasOwn(data, 'hooks');
  } catch {
    return true;
  }
}

/** The text an `Edit` call would leave, or `undefined` when it does not apply. */
async function editedText(file: string, fields: Record<string, unknown>): Promise<string | undefined> {
  const oldString = typeof fields.old_string === 'string' ? fields.old_string : undefined;
  const newString = typeof fields.new_string === 'string' ? fields.new_string : undefined;
  if (oldString === undefined || newString === undefined) return undefined;
  let current: string;
  try {
    current = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  if (oldString === '') return undefined;
  return fields.replace_all === true ? current.split(oldString).join(newString) : current.replace(oldString, () => newString);
}

async function resolveInside(target: string, worktree: string, pathEnv: PathEnv): Promise<{ real: string; relative: string } | undefined> {
  try {
    const real = await realpathNearest(pathEnv.pathApi.resolve(target));
    const root = await realpathNearest(worktree);
    if (!isPathInside(real, root, pathEnv)) return undefined;
    return { real, relative: pathEnv.pathApi.relative(root, real).split(pathEnv.pathApi.sep).join('/') };
  } catch {
    return undefined;
  }
}

export interface TaskToolInput {
  tool_name: string;
  tool_input: unknown;
  /** Set for a subagent's call. */
  agent_id?: string | undefined;
}

/** Decides one tool call. Pure apart from reading the disk (links, existing files). */
export async function evaluateTaskToolUse(rules: TaskGuardRules, input: TaskToolInput, pathEnv: PathEnv = systemPathEnv()): Promise<TaskVerdict> {
  const tool = input.tool_name;
  const fields = (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {}) as Record<string, unknown>;
  const { pathApi } = pathEnv;
  const isSubagent = input.agent_id !== undefined && input.agent_id !== '';

  if (FREE_TOOLS.has(tool)) return { verdict: 'allow', reason: 'asks the user or loads a tool schema' };
  if (SUBAGENT_TOOLS.has(tool)) return isSubagent ? { verdict: 'allow', reason: 'a subagent hands its report back' } : deny(`${tool} is for subagents only.`);

  if (tool === SKILL_TOOL) {
    const name = text(fields.skill);
    if (name === undefined) return deny('The Skill call names no skill.');
    return rules.skills.includes(name) ? { verdict: 'allow', reason: 'one of the project\'s skills' } : deny(`Only the project's own skills can be used in a task; "${name}" is not one of them.`);
  }

  if (tool === 'Agent') {
    if (fields.isolation !== undefined) return deny('A task\'s subagents work in the task\'s worktree: no isolation.');
    if (fields.mode !== undefined) return deny('A task\'s subagents keep the task\'s permission mode.');
    if (fields.run_in_background === true) return deny('A task\'s subagents run in the foreground.');
    return { verdict: 'allow', reason: 'a subagent, under the same guard' };
  }

  if (READ_TOOLS.has(tool)) {
    if (tool === 'Glob') {
      const pattern = typeof fields.pattern === 'string' ? fields.pattern : '';
      if (isRootedPattern(pattern, pathEnv) || pattern.includes('..')) return deny('Glob patterns must be relative to the worktree, without "..".');
    }
    const given = text(fields.file_path) ?? text(fields.path);
    // No path: Glob and Grep search the working folder, which is the worktree.
    const target = given === undefined ? rules.worktree : pathApi.resolve(rules.worktree, given);
    if (hasGitSegment(target)) return deny('Reading .git is not allowed in a task.');
    const inside = await resolveInside(target, rules.worktree, pathEnv);
    if (inside === undefined || hasGitSegment(inside.real)) return deny('Reads are only allowed inside the task\'s worktree.');
    return { verdict: 'allow', reason: 'a read inside the worktree' };
  }

  if (WRITE_TOOLS.has(tool)) {
    const target = text(fields.file_path);
    if (target === undefined) return deny('The write has no file path.');
    if (classifyPath(target, pathEnv) !== 'ok') return deny('Use the absolute path of the file inside the task\'s worktree.');
    if (hasGitSegment(target)) return deny('Writing inside a .git folder is not allowed.');
    const inside = await resolveInside(target, rules.worktree, pathEnv);
    if (inside === undefined || inside.relative === '' || hasGitSegment(inside.real)) return deny('Writes are only allowed inside the task\'s worktree.');
    const protectedReason = protectedProjectFile(inside.relative, pathEnv);
    if (protectedReason !== undefined) return deny(protectedReason);
    if (isDefinitionFile(inside.relative, pathEnv)) {
      const next = tool === 'Write' ? (typeof fields.content === 'string' ? fields.content : undefined) : await editedText(inside.real, fields);
      if (next === undefined) return deny(`The change to ${inside.relative} cannot be checked, so it is not made.`);
      if (declaresHooks(next)) return deny(`${inside.relative} would declare hooks; a task never adds hooks.`);
    }
    return { verdict: 'allow', reason: 'a file inside the worktree' };
  }

  if (SHELL_TOOLS.has(tool)) {
    const command = typeof fields.command === 'string' ? fields.command : undefined;
    if (command === undefined || command.trim() === '') return deny('The shell call has no command.');
    if (fields.run_in_background === true) return deny('Shell commands run in the foreground in a task.');
    return { verdict: 'ask', reason: 'every shell command is the user\'s decision', kind: 'shell', key: command };
  }

  if (WEB_TOOLS.has(tool)) {
    const key = tool === 'WebFetch' ? text(fields.url) : text(fields.query);
    if (key === undefined) return deny(`The ${tool} call names no ${tool === 'WebFetch' ? 'address' : 'query'}.`);
    return { verdict: 'ask', reason: 'every web request is the user\'s decision', kind: 'web', key };
  }

  return deny(`The tool ${tool} is not available in a task.`);
}
