// Claude Code hook: appends subagent and tool events to the session's
// events.jsonl (see docs/events.md and src/events/index.ts for the format).
// Plain JavaScript so it starts fast on every tool call. Run in exec form,
// without a shell:
//   { "type": "command", "command": "node",
//     "args": ["${CLAUDE_PROJECT_DIR}/scripts/hook-event.mjs"] }
// It records only sessions whose folder already exists (created by
// `briefstack event session started` in /new-project), so ordinary work in
// the repo is not logged. It never fails the hook: any problem is swallowed
// and it exits 0.
//
// Tool inputs are never recorded. A tool call keeps only a short `target`:
// a path relative to the session folder, the projects folder or the repo,
// or a briefstack CLI subcommand (docs/events.md, "Targets").

import { appendFileSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TYPES = {
  SubagentStart: 'subagent.start',
  SubagentStop: 'subagent.stop',
  PreToolUse: 'tool.pre',
  PostToolUse: 'tool.post',
  PostToolUseFailure: 'tool.failure',
  SessionEnd: 'session.end',
};

// Claude Code's SessionEnd reasons are short snake_case words; anything else is not recorded.
const REASON_RE = /^[a-z_]{1,32}$/;

// Same rule as SESSION_ID_RE in src/events/index.ts.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Tool use ids, effort levels and model names are short tokens; anything else is not recorded.
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/;

// Agent types that may name a file in .claude/agents.
const AGENT_TYPE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Longest target path kept; the end of the path is the part worth seeing. */
export const MAX_TARGET_LENGTH = 120;

/** Which input field holds the path, per tool. */
const PATH_FIELDS = {
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  NotebookEdit: 'notebook_path',
  Glob: 'path',
  Grep: 'path',
  'mcp__briefstack-web__approve_spec': 'specFile',
  'mcp__briefstack-web__grant_directory': 'dir',
};

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// `npm run [--silent] briefstack -- <sub> [<sub>]`: only the subcommand words are kept.
const CLI_RE = /^\s*npm\s+run\s+(?:--silent\s+)?briefstack\s+--\s+([a-z][a-z-]{0,31})(?:\s+([a-z][a-z-]{0,31}))?(?=\s|$)/;

/** Same rule as isFullyAbsolute in src/config/paths.ts: on Windows, a drive or UNC share. */
export function isFullyAbsolute(value, pathApi = path) {
  if (!pathApi.isAbsolute(value)) return false;
  if (pathApi.sep !== '\\') return true;
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]/.test(value);
}

/** Same rule as toAbsolute in src/config/paths.ts: `~` expanded, fully absolute or undefined. */
export function toAbsolute(value, homedir = os.homedir(), pathApi = path) {
  const trimmed = value.trim();
  let expanded = trimmed;
  if (trimmed === '~') expanded = homedir;
  else if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) expanded = pathApi.join(homedir, trimmed.slice(2));
  return isFullyAbsolute(expanded, pathApi) ? pathApi.resolve(expanded) : undefined;
}

/**
 * Same rule as resolveHome in src/config/config.ts: BRIEFSTACK_HOME or
 * ~/.briefstack. Returns undefined (record nothing) for a value that is not
 * fully absolute, e.g. a Git Bash `/c/Users/...` that would otherwise land
 * in `C:\c\Users\...`.
 */
export function briefstackHome(env, homedir = os.homedir(), pathApi = path) {
  const value = (env.BRIEFSTACK_HOME ?? '').trim();
  if (value === '') return pathApi.join(homedir, '.briefstack');
  return toAbsolute(value, homedir, pathApi);
}

/**
 * Same rule as resolvePaths in src/config/config.ts for `projectsDir`: the
 * config's value, else `~/briefstack-projects`. Undefined when the config's
 * value is not absolute (the CLI refuses it).
 */
export function projectsDirOf(config, homedir = os.homedir(), pathApi = path) {
  const value = config?.projectsDir;
  if (typeof value === 'string' && value.trim() !== '') return toAbsolute(value, homedir, pathApi);
  return pathApi.join(homedir, 'briefstack-projects');
}

function relativeInside(child, parent, pathApi, caseInsensitive) {
  let relative = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(child));
  if (caseInsensitive && (relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative))) {
    relative = pathApi.relative(pathApi.resolve(parent).toLowerCase(), pathApi.resolve(child).toLowerCase());
  }
  if (pathApi.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${pathApi.sep}`)) return undefined;
  return relative.split(pathApi.sep).join('/');
}

function shorten(value) {
  return value.length <= MAX_TARGET_LENGTH ? value : `…${value.slice(value.length - MAX_TARGET_LENGTH + 1)}`;
}

/**
 * A path as a target: relative to the closest of the known folders (`roots`
 * maps `session`, `projects`, `repo` to absolute folders), else `outside`
 * with no path. A path that is not fully absolute gives no target.
 */
export function pathTarget(file, roots, pathApi = path, caseInsensitive = process.platform === 'win32' || process.platform === 'darwin') {
  if (typeof file !== 'string' || file.trim() === '' || !isFullyAbsolute(file, pathApi)) return undefined;
  let best;
  for (const [root, folder] of Object.entries(roots ?? {})) {
    if (typeof folder !== 'string' || folder === '') continue;
    const relative = relativeInside(file, folder, pathApi, caseInsensitive);
    if (relative === undefined) continue;
    // The closest folder wins: the one that leaves the shortest relative path.
    if (best === undefined || relative.length < best.path.length) best = { root, path: relative };
  }
  if (best === undefined) return { root: 'outside' };
  return best.path === '' ? { root: best.root } : { root: best.root, path: shorten(best.path) };
}

/** The briefstack subcommand of a shell command, e.g. `library add`; undefined for any other command. */
export function cliTarget(command) {
  if (typeof command !== 'string') return undefined;
  const match = CLI_RE.exec(command);
  if (match === null) return undefined;
  return { root: 'cli', path: match[2] === undefined ? match[1] : `${match[1]} ${match[2]}` };
}

/** The short target of a tool call, or undefined. Never a query, URL, pattern or content. */
export function targetOf(toolName, toolInput, roots, pathApi = path, caseInsensitive) {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined;
  if (SHELL_TOOLS.has(toolName)) return cliTarget(toolInput.command);
  const field = PATH_FIELDS[toolName];
  if (field === undefined) return undefined;
  return pathTarget(toolInput[field], roots, pathApi, caseInsensitive);
}

/**
 * The `model` an agent file sets, as `briefstack usage set` writes it: a
 * `model:` line in the frontmatter. Undefined when the file or the line is
 * missing.
 */
export function agentModel(repoDir, agentType, readText = (file) => readFileSync(file, 'utf8'), pathApi = path) {
  if (typeof repoDir !== 'string' || repoDir === '' || typeof agentType !== 'string' || !AGENT_TYPE_RE.test(agentType)) return undefined;
  try {
    const text = readText(pathApi.join(repoDir, '.claude', 'agents', `${agentType}.md`));
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    const model = /^model:\s*["']?([^"'\s#]+)["']?\s*$/m.exec(frontmatter)?.[1];
    return model !== undefined && TOKEN_RE.test(model) ? model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The event for one hook payload, or undefined. `context` (optional) gives
 * the folders targets are relative to (`roots`) and how to find an agent's
 * model (`model(agentType)`); without it, events carry neither.
 */
export function toEvent(payload, now = new Date(), context = {}) {
  const type = TYPES[payload?.hook_event_name];
  const session = payload?.session_id;
  if (type === undefined || typeof session !== 'string' || !SESSION_ID_RE.test(session) || session.includes('..')) {
    return undefined;
  }
  const agentType = typeof payload.agent_type === 'string' && payload.agent_type !== '' ? payload.agent_type : undefined;
  // Claude Code's own background agents stop with an empty agent_type and no
  // start event (rehearsal run A, decisions.md): they are not flow agents.
  if (type.startsWith('subagent.') && agentType === undefined) return undefined;
  const event = { v: 1, ts: now.toISOString(), session, source: 'hook', type };
  if (typeof payload.agent_id === 'string') event.agentId = payload.agent_id;
  if (agentType !== undefined) event.agentType = agentType;
  if (typeof payload.tool_name === 'string') event.tool = payload.tool_name;
  if (type.startsWith('tool.') && typeof payload.tool_use_id === 'string' && TOKEN_RE.test(payload.tool_use_id)) {
    event.toolUseId = payload.tool_use_id;
  }
  if (type === 'tool.pre' && context.roots !== undefined) {
    const target = targetOf(payload.tool_name, payload.tool_input, context.roots, context.pathApi, context.caseInsensitive);
    if (target !== undefined) event.target = target;
  }
  const effort = payload.effort?.level;
  if ((type === 'tool.pre' || type === 'subagent.stop') && typeof effort === 'string' && TOKEN_RE.test(effort)) {
    event.effort = effort;
  }
  if (type === 'subagent.start' && context.model !== undefined) {
    const model = context.model(agentType);
    if (model !== undefined) event.model = model;
  }
  if (type === 'session.end' && typeof payload.reason === 'string' && REASON_RE.test(payload.reason)) {
    event.reason = payload.reason;
  }
  return event;
}

function readConfig(home) {
  try {
    const value = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'));
    return typeof value === 'object' && value !== null ? value : {};
  } catch {
    return {};
  }
}

function main() {
  try {
    const payload = JSON.parse(readFileSync(0, 'utf8'));
    const home = briefstackHome(process.env);
    if (home === undefined || typeof payload?.session_id !== 'string' || !SESSION_ID_RE.test(payload.session_id)) return;
    // Only sessions that /new-project opened (briefstack event session started)
    // are recorded; the hook never creates the folder itself.
    const dir = path.join(home, 'sessions', payload.session_id);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
    const repoDir = process.env.CLAUDE_PROJECT_DIR ?? (typeof payload.cwd === 'string' ? payload.cwd : undefined);
    const roots = { session: dir, projects: projectsDirOf(readConfig(home)), repo: repoDir };
    const event = toEvent(payload, new Date(), { roots, model: (agentType) => agentModel(repoDir, agentType) });
    if (event === undefined) return;
    appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  } catch {
    // Recording events must never disturb the session.
  }
}

function isEntryPoint() {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
