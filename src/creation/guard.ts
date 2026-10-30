import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { expandHome, isFullyAbsolute, isPathInside, systemPathEnv, type PathEnv } from '../config/paths.js';
import { realpathNearest } from '../scaffold/outputDir.js';
import { redactSecretLines } from '../validate/secrets.js';
import { APPROVE_SPEC_TOOL, GRANT_DIRECTORY_TOOL } from './toolNames.js';

/**
 * The guard of a creation session (PLAN-phase-2 §3 "SdkRunner", H6).
 *
 * It is a `PreToolUse` callback that only `SdkRunner` registers, through the
 * `hooks` option of its own `query()`. No settings file mentions it, so
 * ordinary Claude Code sessions in this repo never run it, and it ignores
 * any hook input whose `session_id` is not the creation's own. Hooks run
 * before the permission mode, so the auto classifier never decides what the
 * guard allows or denies.
 *
 * What it decides:
 * - file writes only inside `projectsDir`, the session folder and the
 *   folders the user granted to this session, and never in a `.git`
 *   folder; anything else is denied;
 * - shell commands only as `npm run --silent briefstack -- <sub> ...` with
 *   no shell operators, and only the subcommands each caller needs;
 * - after a cancel, nothing except the `briefstack event` calls that close
 *   the session;
 * - no caller reads the personal library's `skills/` folder (Read in it,
 *   Glob or Grep in it or above it); library skills reach a project only
 *   through `skills install`;
 * - no write or edit in a `.claude/skills/<name>/` whose name is that of
 *   any library skill (approved or not); other project skills are written
 *   as before;
 * - web access is allowed for the researcher and denied to everyone else;
 * - `SubagentHandback` is left to the permission mode for subagents, also
 *   after a cancel, and denied to the main session;
 * - a tool outside `FLOW_TOOLS` is denied.
 * Everything else is left to the permission mode and `canUseTool`.
 */

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);

/**
 * The library's skills folder (`SKILLS_DIR` in `skills/service.ts`, not
 * imported so the hook process stays small). No caller in a creation reads
 * it: library skills reach a project only through `skills install`.
 */
export const LIBRARY_SKILLS_DIR = 'skills';

/**
 * The built-in tools a creation offers: what the skill and the five agents
 * use (their `tools:` lists, the Agent tool and `AskUserQuestion`), plus
 * `ToolSearch`, which only loads the schemas of tools in this list. `query()`
 * gets it as `tools`, so `Monitor`, `CronCreate`, `EnterWorktree`,
 * `Workflow` and the rest are not offered at all.
 */
export const FLOW_BUILTIN_TOOLS = [
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

/**
 * Coordination tools Claude Code itself gives a subagent, whatever `tools`
 * says, and that a creation needs. `SubagentHandback` is how a subagent
 * delivers its final report in `auto` mode: only that call reaches the
 * caller. It sends text to the parent session and nothing else, and the
 * classifier reviews the report (docs/decisions.md, H10). Subagents only.
 */
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set<string>(['SubagentHandback']);

/** Every tool the guard knows: the built-ins above, the subagent tools and the two `briefstack-web` tools. Anything else is denied. */
export const FLOW_TOOLS: ReadonlySet<string> = new Set<string>([
  ...FLOW_BUILTIN_TOOLS,
  ...SUBAGENT_TOOLS,
  APPROVE_SPEC_TOOL,
  GRANT_DIRECTORY_TOOL,
]);

export type Caller = 'main' | 'generator' | 'reviewer' | 'other';

/** The subcommands of `briefstack` each caller may run (the table in PLAN-phase-2 "Pending for H6"). */
export const ALLOWED_SUBCOMMANDS: Readonly<Record<Exclude<Caller, 'other'>, readonly (readonly string[])[]>> = {
  main: [['event'], ['paths'], ['usage', 'show'], ['library', 'context'], ['library', 'add'], ['spec', 'check'], ['validate'], ['commit']],
  // `skills install` copies approved library skills into the project (BRIEF-phase-6 §4): the generator only.
  generator: [['scaffold'], ['skills', 'install'], ['validate']],
  reviewer: [['validate']],
};

/** Who is calling: the main session has no `agent_id`; a subagent is told apart by its type. */
export function callerOf(input: { agent_id?: string | undefined; agent_type?: string | undefined }): Caller {
  if (input.agent_id === undefined || input.agent_id === '') return 'main';
  if (input.agent_type === 'generator') return 'generator';
  if (input.agent_type === 'reviewer') return 'reviewer';
  return 'other';
}

const PREFIX = ['npm', 'run', '--silent', 'briefstack', '--'] as const;

/** Characters allowed outside double quotes. No operator, glob, expansion or escape character is among them. */
const PLAIN_CHARS = /^[A-Za-z0-9_.\-/:=,]$/;
/** Inside double quotes these still run code or escape in bash or PowerShell, or end the quote. */
const QUOTED_FORBIDDEN = /[$`\\"\r\n\0]/;

export type ParsedCommand = { ok: true; argv: string[] } | { ok: false; reason: string };

/**
 * Reads a shell command as `npm run --silent briefstack -- <args>` and returns
 * the arguments. Anything it does not understand token for token is refused:
 * no `;`, `&`, `|`, redirects, subshells, backticks, `$`, globs, single
 * quotes, backslashes or newlines, and no text after a closing quote that
 * could start something else.
 */
export function parseBriefstackCommand(command: string): ParsedCommand {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let i = 0;
  while (i < command.length) {
    const ch = command.charAt(i);
    if (ch === '"') {
      const end = command.indexOf('"', i + 1);
      if (end === -1) return { ok: false, reason: 'unterminated quote' };
      const body = command.slice(i + 1, end);
      if (QUOTED_FORBIDDEN.test(body)) return { ok: false, reason: 'a quoted argument has $, a backtick, a backslash or a line break' };
      current += body;
      inToken = true;
      i = end + 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inToken) tokens.push(current);
      current = '';
      inToken = false;
      i += 1;
      continue;
    }
    if (!PLAIN_CHARS.test(ch)) return { ok: false, reason: `the character ${JSON.stringify(ch)} is not allowed outside quotes` };
    current += ch;
    inToken = true;
    i += 1;
  }
  if (inToken) tokens.push(current);

  for (const [index, expected] of PREFIX.entries()) {
    if (tokens[index] !== expected) return { ok: false, reason: 'not a briefstack CLI command' };
  }
  return { ok: true, argv: tokens.slice(PREFIX.length) };
}

/**
 * Subcommands no session may run, even under an allowed prefix: `paths
 * rewrite` changes the config, the library notes, the tasks and the repo's
 * settings, and only the user runs it.
 */
export const NEVER_SUBCOMMANDS: readonly (readonly string[])[] = [['paths', 'rewrite']];

/** The subcommand that matches `argv` for `caller`, e.g. `['usage', 'show']`, or `undefined`. */
export function matchSubcommand(caller: Caller, argv: readonly string[]): readonly string[] | undefined {
  if (caller === 'other') return undefined;
  const starts = (sub: readonly string[]) => sub.every((word, index) => argv[index] === word);
  if (NEVER_SUBCOMMANDS.some(starts)) return undefined;
  return ALLOWED_SUBCOMMANDS[caller].find(starts);
}

export type PathClass = 'ok' | 'relative' | 'not-fully-absolute';

/**
 * Lexical look at a path before the disk is consulted: a relative path, or a
 * rooted one without a drive on Windows (a Git Bash `/c/Users/...`), is never
 * accepted as it stands.
 */
export function classifyPath(value: string, pathEnv: Pick<PathEnv, 'pathApi'>): PathClass {
  const { pathApi } = pathEnv;
  if (!pathApi.isAbsolute(value)) return 'relative';
  return isFullyAbsolute(value, pathApi) ? 'ok' : 'not-fully-absolute';
}

export interface GuardContext {
  /**
   * Whether a hook input belongs to this creation. The runner claims the
   * session id the first time it sees one, so a hook that fires before the
   * init message is read is still ours.
   */
  isOwnSession(sessionId: string): boolean;
  /** The folder of this creation's files, `<sessionsDir>/<session id>`. */
  sessionDir(sessionId: string): string;
  projectsDir: string;
  /** The personal library. Nothing in its `skills/` folder may be read. */
  libraryDir: string;
  /** The session's working folder: a relative read path, or a search with no `path`, starts there. */
  cwd: string;
  /** Folders the user confirmed for this session only. Read on every call. */
  grantedDirs(): readonly string[];
  /** Whether the user cancelled. Read on every call. */
  cancelled(): boolean;
  /**
   * The library skills of the spec the user approved last (after any they
   * unticked); `undefined` before an approval. Read on every call. Without
   * it, no library skill may be installed.
   */
  approvedLibrarySkills?(): readonly string[] | undefined;
  pathEnv?: PathEnv;
}

export interface GuardInput {
  session_id: string;
  tool_name: string;
  tool_input: unknown;
  agent_id?: string | undefined;
  agent_type?: string | undefined;
}

export type GuardVerdict =
  /** The guard pre-approves it. */
  | { verdict: 'allow'; reason: string }
  | { verdict: 'deny'; reason: string; summary: string }
  /** Not the guard's business: the permission mode decides. */
  | { verdict: 'pass' };

const CANCEL_MESSAGE =
  'The user cancelled this creation. Do nothing else: close the open step as skipped and then close the session with ' +
  '`event session finished --outcome cancelled`, as the skill says for a cancel, and stop.';

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** `file_path`, or `notebook_path`, of a write tool. */
function targetOf(toolName: string, input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const fields = input as Record<string, unknown>;
  return text(toolName === 'NotebookEdit' ? fields.notebook_path : fields.file_path);
}

/** Whether `target` is inside one of `roots`, after symlinks are resolved on both sides. */
export async function insideAny(target: string, roots: readonly string[], pathEnv: PathEnv): Promise<boolean> {
  let real: string;
  try {
    real = await realpathNearest(pathEnv.pathApi.resolve(target));
  } catch {
    return false;
  }
  for (const root of roots) {
    try {
      if (isPathInside(real, await realpathNearest(root), pathEnv)) return true;
    } catch {
      // A root that cannot be resolved allows nothing.
    }
  }
  return false;
}

/**
 * Whether a path has a `.git` segment, ignoring case. Windows also drops
 * trailing dots and spaces (`.git.` is `.git`) and may reach it by its short
 * name (`GIT~1`), so those count too.
 */
export function hasGitSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => {
    const name = segment.toLowerCase().replace(/[. ]+$/, '');
    return name === '.git' || /^git~\d+$/.test(name);
  });
}

/** `hasGitSegment` of the path as written, or of where it really leads after symlinks. */
async function touchesGitDir(target: string, pathEnv: PathEnv): Promise<boolean> {
  if (hasGitSegment(target)) return true;
  try {
    return hasGitSegment(await realpathNearest(pathEnv.pathApi.resolve(target)));
  } catch {
    return false;
  }
}

/**
 * The fixed folders a glob pattern starts with: everything before the
 * segment that holds the first glob character, so `../lib/skills/**` keeps
 * `../lib/skills/` and `**\/*.md` keeps nothing. A pattern without glob
 * characters is a path.
 */
export function globPrefix(pattern: string): string {
  const first = pattern.search(/[*?[\]{}]/);
  if (first === -1) return pattern;
  const head = pattern.slice(0, first);
  const cut = Math.max(head.lastIndexOf('/'), head.lastIndexOf(String.fromCharCode(92)));
  return cut === -1 ? '' : head.slice(0, cut + 1);
}

/**
 * Where a read tool looks: Read's file, or the folder Glob or Grep starts
 * from (Glob's `path` plus the fixed start of its pattern), resolved against
 * the session's folder, with `~` expanded. On Windows a Git Bash form
 * (`/d/x`) may reach a tool as `D:\x`, so both readings are returned.
 */
export function readRootsOf(tool: string, input: Record<string, unknown>, cwd: string, pathEnv: PathEnv): string[] {
  const { pathApi } = pathEnv;
  const readings = (value: string): string[] => {
    const home = expandHome(value, pathEnv);
    const drive = pathApi.sep === '\\' ? /^[\\/]([A-Za-z])(?:[\\/]|$)(.*)$/.exec(home) : null;
    return drive === null ? [home] : [home, `${drive[1] ?? ''}:/${drive[2] ?? ''}`];
  };
  const resolveAll = (bases: readonly string[], value: string): string[] =>
    bases.flatMap((base) => readings(value).map((reading) => pathApi.resolve(base, reading)));
  if (tool === 'Read') return resolveAll([cwd], text(input.file_path) ?? '');
  const bases = resolveAll([cwd], text(input.path) ?? '.');
  if (tool !== 'Glob') return bases;
  const prefix = globPrefix(text(input.pattern) ?? '');
  return prefix === '' ? bases : resolveAll(bases, prefix);
}

/**
 * Whether a read reaches the library's skills folder, after symlinks are
 * resolved on both sides: Read of a file in it, or a Glob or Grep that starts
 * in it or above it. A path that cannot be resolved counts as reaching it.
 */
export async function readsLibrarySkills(tool: string, input: Record<string, unknown>, ctx: Pick<GuardContext, 'libraryDir' | 'cwd'>, pathEnv: PathEnv): Promise<boolean> {
  try {
    const skills = await realpathNearest(pathEnv.pathApi.join(ctx.libraryDir, LIBRARY_SKILLS_DIR));
    for (const candidate of readRootsOf(tool, input, ctx.cwd, pathEnv)) {
      const root = await realpathNearest(candidate);
      if (isPathInside(root, skills, pathEnv)) return true;
      if (tool !== 'Read' && isPathInside(skills, root, pathEnv)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * The skill folder names a path writes into: the segment after each
 * `.claude/skills/`, lower case, without the trailing dots and spaces
 * Windows drops.
 */
export function projectSkillNames(value: string): string[] {
  const segments = value.split(/[\\/]+/).map((segment) => segment.toLowerCase().replace(/[. ]+$/, ''));
  const out: string[] = [];
  segments.forEach((segment, index) => {
    const name = segments[index + 2];
    if (segment === '.claude' && segments[index + 1] === 'skills' && name !== undefined && name !== '') out.push(name);
  });
  return out;
}

/**
 * The names of every skill in the library, whatever its status, lower case;
 * `undefined` when its skills folder exists but cannot be listed.
 */
async function librarySkillFolders(libraryDir: string, pathEnv: PathEnv): Promise<Set<string> | undefined> {
  try {
    const entries = await readdir(pathEnv.pathApi.join(libraryDir, LIBRARY_SKILLS_DIR));
    return new Set(entries.map((name) => name.toLowerCase()));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Set() : undefined;
  }
}

/**
 * The library skill a write would land in, as written or after symlinks;
 * `undefined` when none. When the library cannot be listed, any write into
 * a project's `.claude/skills/` counts.
 */
async function libraryNamedSkillWrite(target: string, libraryDir: string, pathEnv: PathEnv): Promise<string | undefined> {
  const written = projectSkillNames(pathEnv.pathApi.resolve(target));
  let real: string[] = [];
  try {
    real = projectSkillNames(await realpathNearest(pathEnv.pathApi.resolve(target)));
  } catch {
    // The written form is still checked.
  }
  const names = [...written, ...real];
  if (names.length === 0) return undefined;
  const library = await librarySkillFolders(libraryDir, pathEnv);
  return library === undefined ? names[0] : names.find((name) => library.has(name));
}

const libraryNamedSkillMessage = (name: string): string =>
  `.claude/skills/${name} has the name of a skill in the user's library. A library skill reaches a project only through ` +
  '`skills install`, exactly as the user approved it; do not write or edit its files. A skill of the project\'s own needs ' +
  'another name.';

const LIBRARY_SKILLS_MESSAGE =
  "The personal library's skills folder is not readable in a creation. What you may know about library skills is in the " +
  'library context (approved ones only: name, description, tags); the generator installs them with `skills install`, ' +
  'which copies the approved files itself. Search other folders by giving Glob or Grep a `path` that does not contain it.';

const GIT_MESSAGE =
  'Writing inside a .git folder is not allowed: git runs hooks and settings from there. Let `briefstack scaffold` create ' +
  'the repository and `briefstack commit` commit it.';

/**
 * Appended to a denial for a folder outside the allowed ones: how to get it
 * granted. Without it the main session in the web app asked in plain text
 * (docs/decisions.md, "check-server-crash: a denied write answered in text").
 */
export function grantHint(caller: Caller): string {
  return caller === 'main'
    ? ' To write there, ask the user to grant that folder first: call `grant_directory` (MCP server `briefstack-web`) with it ' +
        'if that tool is among yours, otherwise ask them to run `/add-dir` with it. Never ask for it in plain text when you have ' +
        '`grant_directory`.'
    : ' Do not try another path: stop and name the folder in your report, so the main session can ask the user to grant it.';
}

const redact = (value: string): string => redactSecretLines(value).slice(0, 500);

/** The names in a spec file's `librarySkills`; `undefined` when the file cannot be read as JSON. */
export async function specLibrarySkillNames(file: string): Promise<string[] | undefined> {
  try {
    const text = await readFile(file, 'utf8');
    const data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as { librarySkills?: unknown };
    const list = Array.isArray(data.librarySkills) ? (data.librarySkills as unknown[]) : [];
    return list.map((item) => (typeof item === 'object' && item !== null ? String((item as { name?: unknown }).name) : String(item)));
  } catch {
    return undefined;
  }
}

/** The names after `--skill` (or in `--skill=<name>`). */
function skillOptions(words: readonly string[]): string[] {
  const out: string[] = [];
  words.forEach((word, index) => {
    if (word === '--skill') out.push(words[index + 1] ?? '');
    else if (word.startsWith('--skill=')) out.push(word.slice('--skill='.length));
  });
  return out;
}

/**
 * Why `skills install <dir> …` may not run, or `undefined`: every skill it
 * would install (the one `--skill` names, or the project spec's
 * `librarySkills`) must be one the user approved in this creation's spec.
 */
async function libraryInstallRefusal(dir: string, words: readonly string[], approved: readonly string[] | undefined): Promise<string | undefined> {
  if (approved === undefined) return 'No spec has been approved in this creation yet, so no library skill may be installed.';
  const unapproved = (names: readonly string[]) => names.filter((name) => !approved.includes(name));
  const named = unapproved(skillOptions(words));
  if (named.length > 0) {
    return `The user did not approve library skill ${named.join(', ')} for this project. Install only the spec's library skills: \`skills install "<project-dir>"\` without --skill.`;
  }
  const chosen = await specLibrarySkillNames(path.join(dir, '.briefstack', 'spec.json'));
  if (chosen === undefined) return 'The project has no readable .briefstack/spec.json: scaffold it from the approved spec first.';
  const extra = unapproved(chosen);
  if (extra.length > 0) {
    return `The project's spec names library skill ${extra.join(', ')}, which the user did not approve (or unticked). Its spec must be the approved one: remove them from .briefstack/spec.json.`;
  }
  return undefined;
}

/** Decides one tool call. Pure apart from reading symlinks on the disk. */
export async function evaluateToolUse(ctx: GuardContext, input: GuardInput): Promise<GuardVerdict> {
  if (!ctx.isOwnSession(input.session_id)) return { verdict: 'pass' };
  const pathEnv = ctx.pathEnv ?? systemPathEnv();
  const caller = callerOf(input);
  const tool = input.tool_name;
  const toolInput = (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {}) as Record<string, unknown>;

  const deny = (reason: string, summary: string): GuardVerdict => ({ verdict: 'deny', reason, summary: redact(summary) });
  const roots = (): string[] => [ctx.projectsDir, ctx.sessionDir(input.session_id), ...ctx.grantedDirs()];

  if (SHELL_TOOLS.has(tool)) {
    const command = text(toolInput.command) ?? '';
    const summary = command;
    const parsed = parseBriefstackCommand(command);
    if (ctx.cancelled()) {
      // Only the calls that close the session still go through.
      if (parsed.ok && caller === 'main' && parsed.argv[0] === 'event') return { verdict: 'allow', reason: 'closing a cancelled session' };
      return deny(CANCEL_MESSAGE, summary);
    }
    if (!parsed.ok) {
      // The usual cause on Windows: a path copied with backslashes. Say what to do instead of only what is wrong.
      const hint = command.includes(String.fromCharCode(92))
        ? ' It has a backslash: write every path with forward slashes, for example "C:/Users/you/projects/app", in double quotes.'
        : '';
      return deny(
        `This command is not allowed (${parsed.reason}).${hint} The only shell commands are ` +
          '`npm run --silent briefstack -- <command> ...`, one per call, with no `;`, `&&`, `|`, redirects or `$(...)`, ' +
          'and with absolute paths in double quotes using forward slashes.',
        summary,
      );
    }
    const sub = matchSubcommand(caller, parsed.argv);
    if (sub === undefined) {
      return deny(
        caller === 'other'
          ? 'This agent has no shell access.'
          : `The briefstack command \`${parsed.argv.slice(0, 2).join(' ')}\` is not allowed for ${caller === 'main' ? 'the main session' : `the ${caller} agent`}.`,
        summary,
      );
    }
    // Commands that write on their own must point inside the folders a creation may write to.
    if (sub[0] === 'scaffold' || sub[0] === 'commit' || sub[0] === 'skills') {
      const words = parsed.argv.slice(sub.length);
      // `--skill <name>` takes a value: it is not the folder.
      const positionals = words.filter((word, index) => !word.startsWith('-') && words[index - 1] !== '--skill');
      const target = sub[0] === 'scaffold' ? positionals[1] : positionals[0];
      // `skills install` with no folder is refused by the CLI; the guard asks for one first.
      if (target === undefined && sub[0] === 'skills') return deny('Name the project folder: `skills install "<project-dir>"`.', summary);
      if (target !== undefined) {
        const kind = classifyPath(target, pathEnv);
        if (kind !== 'ok') {
          return deny('Use a full path with a drive letter or a leading slash, in double quotes with forward slashes.', summary);
        }
        if (await touchesGitDir(target, pathEnv)) return deny(GIT_MESSAGE, summary);
        if (!(await insideAny(target, roots(), pathEnv))) {
          return deny(`That folder is outside the projects folder and the folders the user granted for this creation.${grantHint(caller)}`, summary);
        }
      }
      if (sub[0] === 'skills' && target !== undefined) {
        const refusal = await libraryInstallRefusal(target, words, ctx.approvedLibrarySkills?.());
        if (refusal !== undefined) return deny(refusal, summary);
      }
    }
    return { verdict: 'allow', reason: 'a briefstack CLI command this caller needs' };
  }

  if (SUBAGENT_TOOLS.has(tool)) {
    if (caller === 'main') return deny(`${tool} is only for subagents.`, tool);
    // Also after a cancel: denying the report only makes the agent retry before it stops.
    return { verdict: 'pass' };
  }

  if (ctx.cancelled()) return deny(CANCEL_MESSAGE, `${tool}`);

  if (READ_TOOLS.has(tool) && (await readsLibrarySkills(tool, toolInput, ctx, pathEnv))) {
    return deny(LIBRARY_SKILLS_MESSAGE, `${tool}: ${text(toolInput.file_path) ?? text(toolInput.path) ?? ''} ${text(toolInput.pattern) ?? ''}`.trim());
  }

  if (WRITE_TOOLS.has(tool)) {
    const target = targetOf(tool, toolInput);
    if (target === undefined) return deny('The write has no file path.', tool);
    const kind = classifyPath(target, pathEnv);
    if (kind === 'relative') return deny('Use an absolute path.', target);
    if (kind === 'not-fully-absolute') return deny('Use a full path with a drive letter, not a /c/... form.', target);
    if (await touchesGitDir(target, pathEnv)) return deny(GIT_MESSAGE, target);
    const librarySkill = await libraryNamedSkillWrite(target, ctx.libraryDir, pathEnv);
    if (librarySkill !== undefined) return deny(libraryNamedSkillMessage(librarySkill), target);
    if (await insideAny(target, roots(), pathEnv)) return { verdict: 'allow', reason: 'inside an allowed folder' };
    return deny(
      `Writes are only allowed inside the projects folder, this creation's session folder and folders the user granted for it.${grantHint(caller)}`,
      target,
    );
  }

  if (WEB_TOOLS.has(tool)) {
    if (input.agent_type === 'researcher') return { verdict: 'allow', reason: 'read-only web access for the researcher' };
    const query = text(toolInput.url) ?? text(toolInput.query) ?? '';
    return deny('Only the researcher agent may use the web. Ask it through the Agent tool if the spec needs outside facts.', `${tool}: ${query}`);
  }
  if (!FLOW_TOOLS.has(tool)) {
    return deny(`The tool ${tool} is not available in a creation. Use only the tools the /new-project flow names.`, tool);
  }
  return { verdict: 'pass' };
}

export interface GuardDenial {
  toolName: string;
  summary: string;
  agentType?: string;
  /** The subagent that made the call; absent for the main session. */
  agentId?: string;
  /** Claude Code's id for the call, which pairs the denial with its `tool.pre` line. */
  toolUseId?: string;
  reason: string;
}

/**
 * The `PreToolUse` callback for `query({ options: { hooks } })`. `onDeny`
 * reports each denial so it is listed with the creation's other denials.
 */
export function guardHook(ctx: GuardContext, onDeny: (denial: GuardDenial) => void = () => undefined): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const verdict = await evaluateToolUse(ctx, {
      session_id: input.session_id,
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      agent_id: input.agent_id,
      agent_type: input.agent_type,
    });
    if (verdict.verdict === 'pass') return {};
    if (verdict.verdict === 'allow') {
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: verdict.reason },
      };
    }
    const denial: GuardDenial = { toolName: input.tool_name, summary: verdict.summary, reason: verdict.reason };
    if (input.agent_type !== undefined && input.agent_type !== '') denial.agentType = input.agent_type;
    if (input.agent_id !== undefined && input.agent_id !== '') denial.agentId = input.agent_id;
    if (input.tool_use_id !== '') denial.toolUseId = input.tool_use_id;
    onDeny(denial);
    return {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason },
    };
  };
}

/** The session folder of a creation. */
export function sessionDirOf(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, sessionId);
}
