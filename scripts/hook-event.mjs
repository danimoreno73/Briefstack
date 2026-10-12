// Claude Code hook: appends subagent and tool events to the session's
// events.jsonl (see src/events/index.ts for the format). Plain JavaScript so
// it starts fast on every tool call. Run in exec form, without a shell:
//   { "type": "command", "command": "node",
//     "args": ["${CLAUDE_PROJECT_DIR}/scripts/hook-event.mjs"] }
// It never fails the hook: any problem is swallowed and it exits 0.

import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
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
};

// Same rule as SESSION_ID_RE in src/events/index.ts.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Same rule as resolveHome in src/config/config.ts: BRIEFSTACK_HOME or ~/.briefstack. */
function briefstackHome(env) {
  const value = (env.BRIEFSTACK_HOME ?? '').trim();
  if (value === '') return path.join(os.homedir(), '.briefstack');
  let expanded = value;
  if (value === '~') expanded = os.homedir();
  else if (value.startsWith('~/') || value.startsWith('~\\')) expanded = path.join(os.homedir(), value.slice(2));
  return path.isAbsolute(expanded) ? path.resolve(expanded) : undefined;
}

export function toEvent(payload, now = new Date()) {
  const type = TYPES[payload?.hook_event_name];
  const session = payload?.session_id;
  if (type === undefined || typeof session !== 'string' || !SESSION_ID_RE.test(session) || session.includes('..')) {
    return undefined;
  }
  const event = { v: 1, ts: now.toISOString(), session, source: 'hook', type };
  if (typeof payload.agent_id === 'string') event.agentId = payload.agent_id;
  if (typeof payload.agent_type === 'string') event.agentType = payload.agent_type;
  if (typeof payload.tool_name === 'string') event.tool = payload.tool_name;
  return event;
}

function main() {
  try {
    const payload = JSON.parse(readFileSync(0, 'utf8'));
    const event = toEvent(payload);
    const home = briefstackHome(process.env);
    if (event === undefined || home === undefined) return;
    const dir = path.join(home, 'sessions', event.session);
    mkdirSync(dir, { recursive: true });
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
