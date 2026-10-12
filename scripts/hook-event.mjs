// Claude Code hook: appends subagent and tool events to the session's
// events.jsonl (see src/events/index.ts for the format). Plain JavaScript so
// it starts fast on every tool call. Run in exec form, without a shell:
//   { "type": "command", "command": "node",
//     "args": ["${CLAUDE_PROJECT_DIR}/scripts/hook-event.mjs"] }
// It records only sessions whose folder already exists (created by
// `briefstack event session started` in /new-project), so ordinary work in
// the repo is not logged. It never fails the hook: any problem is swallowed
// and it exits 0.

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

/** Same rule as isFullyAbsolute in src/config/paths.ts: on Windows, a drive or UNC share. */
export function isFullyAbsolute(value, pathApi = path) {
  if (!pathApi.isAbsolute(value)) return false;
  if (pathApi.sep !== '\\') return true;
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]/.test(value);
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
  let expanded = value;
  if (value === '~') expanded = homedir;
  else if (value.startsWith('~/') || value.startsWith('~\\')) expanded = pathApi.join(homedir, value.slice(2));
  return isFullyAbsolute(expanded, pathApi) ? pathApi.resolve(expanded) : undefined;
}

export function toEvent(payload, now = new Date()) {
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
  if (type === 'session.end' && typeof payload.reason === 'string' && REASON_RE.test(payload.reason)) {
    event.reason = payload.reason;
  }
  return event;
}

function main() {
  try {
    const payload = JSON.parse(readFileSync(0, 'utf8'));
    const event = toEvent(payload);
    const home = briefstackHome(process.env);
    if (event === undefined || home === undefined) return;
    // Only sessions that /new-project opened (briefstack event session started)
    // are recorded; the hook never creates the folder itself.
    const dir = path.join(home, 'sessions', event.session);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
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
