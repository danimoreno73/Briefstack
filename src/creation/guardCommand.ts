import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { systemPathEnv } from '../config/paths.js';
import { redactSecretLines } from '../validate/secrets.js';
import { evaluateToolUse, type GuardContext } from './guard.js';

/**
 * The guard as a Claude Code command hook (docs/decisions.md, "What Claude
 * Code does without its host").
 *
 * The callback guard (`guard.ts`) is answered by the server: if the server
 * dies, nobody answers it, and Claude Code's behaviour then is not
 * documented. This hook is run by Claude Code itself, so it works without
 * the server. `SdkRunner` registers it only in creation sessions, through
 * the `settings` option of `query()`, with `onFailure: "block"`: a hook
 * that cannot start, crashes or times out blocks the tool call.
 *
 * It reads the session's rules from `guard.json` in the creation's run
 * folder (`<home>/runs/<creation id>/`, outside every folder the session
 * may write to), which the runner rewrites on each change, and applies the
 * same `evaluateToolUse` as the callback guard. It only denies, with exit
 * code 2: what the callback guard allows is left to it, so with the server
 * gone nothing is pre-approved. Rules it cannot read, input it cannot
 * parse, or any error: exit 2.
 *
 * Not repeated here: the folder claims between creations
 * (`folderClaims.ts`), which only the server knows.
 */

export const GUARD_RULES_FILE = 'guard.json';
const GUARD_LOG_FILE = 'guard.log';
/** Seconds Claude Code waits for the hook; a timeout blocks the call. */
export const GUARD_COMMAND_TIMEOUT_S = 60;

const absolute = z.string().refine((value) => path.isAbsolute(value), 'must be an absolute path');

const rulesSchema = z
  .object({
    v: z.literal(1),
    projectsDir: absolute,
    sessionsDir: absolute,
    /** The personal library: its `skills/` folder is never read. */
    libraryDir: absolute,
    /** The session's working folder. */
    cwd: absolute,
    /** Folders the user granted to this session. */
    granted: z.array(absolute),
    cancelled: z.boolean(),
    /** The library skills of the spec the user approved last; absent before an approval. */
    librarySkills: z.array(z.string()).optional(),
    /** Once known: a hook input from any other session is denied. */
    sessionId: z.string().optional(),
  })
  .strict();

export type GuardRules = z.infer<typeof rulesSchema>;

/**
 * Writes the rules whole and synchronously: a grant or a cancel is in the
 * file before the call that made it returns, so the next tool call sees it.
 */
export function writeGuardRulesSync(file: string, rules: GuardRules): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
  // A reader may hold the file for a moment on Windows: try again shortly.
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temp, file);
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

const inputSchema = z.looseObject({
  hook_event_name: z.string(),
  session_id: z.string(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
});

export interface CommandVerdict {
  /** 0: no objection (the callback guard and the permission mode decide); 2: denied. */
  code: 0 | 2;
  /** Shown to Claude when denied. */
  message?: string;
}

const deny = (message: string): CommandVerdict => ({ code: 2, message });

/** Decides one hook call from its stdin and the rules file. Never throws. */
export async function decideToolUse(stdin: string, rulesFile: string): Promise<CommandVerdict> {
  try {
    let rules: GuardRules;
    try {
      const parsed = rulesSchema.safeParse(JSON.parse(readFileSync(rulesFile, 'utf8')));
      if (!parsed.success) return deny('briefstack guard: the rules of this creation are not valid, so nothing is allowed.');
      rules = parsed.data;
    } catch {
      return deny('briefstack guard: the rules of this creation cannot be read, so nothing is allowed.');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(stdin);
    } catch {
      return deny('briefstack guard: the hook input is not JSON.');
    }
    const input = inputSchema.safeParse(raw);
    if (!input.success) return deny('briefstack guard: the hook input is not in the expected shape.');
    if (input.data.hook_event_name !== 'PreToolUse') return { code: 0 };
    if (input.data.tool_name === undefined) return deny('briefstack guard: the hook input names no tool.');
    const sessionId = input.data.session_id;
    if (rules.sessionId !== undefined && rules.sessionId !== sessionId) {
      return deny('briefstack guard: this hook belongs to another session.');
    }
    const ctx: GuardContext = {
      // Registered only in this creation's process: every input is its own until the session id is known.
      isOwnSession: (id) => rules.sessionId === undefined || rules.sessionId === id,
      sessionDir: (id) => path.join(rules.sessionsDir, id),
      projectsDir: rules.projectsDir,
      libraryDir: rules.libraryDir,
      cwd: rules.cwd,
      grantedDirs: () => rules.granted,
      cancelled: () => rules.cancelled,
      approvedLibrarySkills: () => rules.librarySkills,
      pathEnv: systemPathEnv(),
    };
    const verdict = await evaluateToolUse(ctx, {
      session_id: sessionId,
      tool_name: input.data.tool_name,
      tool_input: input.data.tool_input,
      agent_id: input.data.agent_id,
      agent_type: input.data.agent_type,
    });
    if (verdict.verdict !== 'deny') {
      log(rulesFile, input.data.tool_name, 'none');
      return { code: 0 };
    }
    log(rulesFile, input.data.tool_name, 'deny', verdict.reason);
    return deny(verdict.reason);
  } catch {
    return deny('briefstack guard: the check failed, so nothing is allowed.');
  }
}

/**
 * One line per tool call next to the rules: the tool, and the reason when
 * denied (redacted, short). It shows that Claude Code ran the hook; tool
 * inputs are never written. Best effort.
 */
function log(rulesFile: string, tool: string, decision: 'deny' | 'none', reason?: string): void {
  try {
    const line = {
      ts: new Date().toISOString(),
      tool: tool.slice(0, 100),
      decision,
      ...(reason === undefined ? {} : { reason: redactSecretLines(reason).slice(0, 300) }),
    };
    appendFileSync(path.join(path.dirname(rulesFile), GUARD_LOG_FILE), `${JSON.stringify(line)}\n`, 'utf8');
  } catch {
    // The verdict stands without the log.
  }
}

const SELF = fileURLToPath(import.meta.url);

/**
 * How Claude Code starts this hook: the running Node, in exec form (no
 * shell). From the sources (`npm run briefstack`) it goes through the tsx
 * loader, as the CLI does; from `dist` it is plain JavaScript.
 */
export function guardCommandLine(rulesFile: string): { command: string; args: string[] } {
  if (SELF.endsWith('.ts')) {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    return { command: process.execPath, args: ['--import', loader, SELF, rulesFile] };
  }
  return { command: process.execPath, args: [SELF, rulesFile] };
}

/** The `settings` the runner passes to `query()`: this hook on every tool, failing closed. */
export function guardCommandSettings(rulesFile: string): { hooks: { PreToolUse: unknown[] } } {
  const { command, args } = guardCommandLine(rulesFile);
  return {
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command, args, onFailure: 'block', timeout: GUARD_COMMAND_TIMEOUT_S }] }],
    },
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** The hook process: `node guardCommand.js <rules file>`. */
async function main(): Promise<void> {
  const rulesFile = process.argv[2];
  const verdict =
    rulesFile === undefined || !path.isAbsolute(rulesFile)
      ? deny('briefstack guard: started without its rules file.')
      : await decideToolUse(await readStdin(), rulesFile);
  if (verdict.message !== undefined) process.stderr.write(`${verdict.message}\n`);
  process.exitCode = verdict.code;
}

const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

if (process.argv[1] !== undefined && samePath(path.resolve(process.argv[1]), SELF)) {
  main().catch(() => {
    process.stderr.write('briefstack guard: the check failed, so nothing is allowed.\n');
    process.exitCode = 2;
  });
}
