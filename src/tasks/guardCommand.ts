import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { systemPathEnv } from '../config/paths.js';
import { evaluateTaskToolUse } from './guard.js';
import { approvalFile, approvalHash, TASK_HOOK_TIMEOUT_S } from './shell.js';

/**
 * The task guard as a Claude Code command hook (BRIEF-phase-7 §3.2: "the
 * independent command-hook guard from phase 4, configured for the
 * worktree"). Claude Code runs it itself, in parallel with the server's
 * callback, so it holds when the server is gone. It reads the rules from
 * `guard.json` in the task's folder (outside the worktree), applies
 * `evaluateTaskToolUse`, and:
 *
 * - a deny: exit 2 with the reason;
 * - an allow: exit 0, silent (the callback decides as well);
 * - a shell command or web request: it waits for the server's record of the
 *   user's decision for this very call (`TaskApprovals`), and lets the call
 *   through only when that record says allow for the same tool and the same
 *   whole command. A deny, a different command, the server gone, or no
 *   record before its deadline: exit 2.
 *
 * Rules it cannot read, input it cannot parse, a session other than the
 * task's, or any error: exit 2. Registered with `onFailure: "block"`.
 */

export const TASK_RULES_FILE = 'guard.json';
/** Claude Code's timeout for this hook: a minute over the callback's, so a recorded answer always arrives first. */
export const TASK_GUARD_TIMEOUT_S = TASK_HOOK_TIMEOUT_S + 60;
/** The hook stops waiting for a decision this long before its own timeout, and denies. */
const DECISION_MARGIN_MS = 20_000;
const POLL_MS = 200;

const absolute = z.string().refine((value) => path.isAbsolute(value), 'must be an absolute path');

const rulesSchema = z
  .object({
    v: z.literal(1),
    worktree: absolute,
    skills: z.array(z.string()),
    approvalsDir: absolute,
    /** The server's process: when it is gone, nothing waits for it. */
    serverPid: z.int().positive(),
    /** Once known: a hook input from any other session is denied. */
    sessionIds: z.array(z.string()).optional(),
    cancelled: z.boolean(),
  })
  .strict();

export type TaskRulesFile = z.infer<typeof rulesSchema>;

/** Writes the rules whole and synchronously, aside and renamed. */
export function writeTaskRulesSync(file: string, rules: TaskRulesFile): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
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
  session_id: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  agent_id: z.string().optional(),
});

export interface CommandVerdict {
  code: 0 | 2;
  message?: string;
}

const deny = (message: string): CommandVerdict => ({ code: 2, message: `briefstack task guard: ${message}` });

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface WaitOptions {
  /** When the hook gives up waiting. */
  deadline: number;
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Waits for the server's record of the decision on one call. */
async function waitForDecision(file: string, hash: string, serverPid: number, options: WaitOptions): Promise<CommandVerdict> {
  const alive = options.alive ?? processAlive;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  for (;;) {
    let raw: string | undefined;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      raw = undefined;
    }
    if (raw !== undefined) {
      let record: { decision?: unknown; hash?: unknown };
      try {
        record = JSON.parse(raw) as { decision?: unknown; hash?: unknown };
      } catch {
        return deny('the decision record cannot be read.');
      }
      if (record.hash !== hash) return deny('the decision on record is for another command.');
      return record.decision === 'allow' ? { code: 0 } : deny('the user did not allow it.');
    }
    if (!alive(serverPid)) return deny('briefstack is not running, so nobody can allow it.');
    if (now() >= options.deadline) return deny('no decision arrived in time.');
    await sleep(POLL_MS);
  }
}

/** Decides one hook call from its stdin and the rules file. Never throws. */
export async function decideTaskToolUse(stdin: string, rulesFile: string, wait: Partial<WaitOptions> = {}): Promise<CommandVerdict> {
  try {
    let rules: TaskRulesFile;
    try {
      const parsed = rulesSchema.safeParse(JSON.parse(readFileSync(rulesFile, 'utf8')));
      if (!parsed.success) return deny('the rules are not valid, so nothing is allowed.');
      rules = parsed.data;
    } catch {
      return deny('the rules cannot be read, so nothing is allowed.');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(stdin);
    } catch {
      return deny('the hook input is not JSON.');
    }
    const input = inputSchema.safeParse(raw);
    if (!input.success) return deny('the hook input is not in the expected shape.');
    if (input.data.hook_event_name !== 'PreToolUse') return { code: 0 };
    if (rules.cancelled) return deny('the task was cancelled.');
    if (rules.sessionIds !== undefined && (input.data.session_id === undefined || !rules.sessionIds.includes(input.data.session_id))) {
      return deny('the call is not from the task\'s session.');
    }
    const tool = input.data.tool_name;
    if (tool === undefined) return deny('the hook input names no tool.');
    const verdict = await evaluateTaskToolUse(rules, { tool_name: tool, tool_input: input.data.tool_input, agent_id: input.data.agent_id }, systemPathEnv());
    if (verdict.verdict === 'deny') return deny(verdict.reason);
    if (verdict.verdict === 'allow') return { code: 0 };
    const file = input.data.tool_use_id === undefined ? undefined : approvalFile(rules.approvalsDir, input.data.tool_use_id);
    if (file === undefined) return deny('the call has no id to match a decision to.');
    const now = wait.now ?? Date.now;
    return await waitForDecision(file, approvalHash(tool, verdict.key), rules.serverPid, { deadline: now() + TASK_GUARD_TIMEOUT_S * 1000 - DECISION_MARGIN_MS, ...wait });
  } catch {
    return deny('the check failed, so nothing is allowed.');
  }
}

const SELF = fileURLToPath(import.meta.url);

/** How Claude Code starts this hook: the running Node, no shell; through tsx when run from the sources. */
export function taskGuardCommandLine(rulesFile: string): { command: string; args: string[] } {
  if (SELF.endsWith('.ts')) {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    return { command: process.execPath, args: ['--import', loader, SELF, rulesFile] };
  }
  return { command: process.execPath, args: [SELF, rulesFile] };
}

/** The `hooks` part of the task's flag settings: this hook on every tool, failing closed. */
export function taskGuardHooks(rulesFile: string): { PreToolUse: unknown[] } {
  const { command, args } = taskGuardCommandLine(rulesFile);
  return { PreToolUse: [{ hooks: [{ type: 'command', command, args, onFailure: 'block', timeout: TASK_GUARD_TIMEOUT_S }] }] };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const rulesFile = process.argv[2];
  const verdict =
    rulesFile === undefined || !path.isAbsolute(rulesFile) ? deny('started without its rules file.') : await decideTaskToolUse(await readStdin(), rulesFile);
  if (verdict.message !== undefined) process.stderr.write(`${verdict.message}\n`);
  process.exitCode = verdict.code;
}

const samePath = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

if (process.argv[1] !== undefined && samePath(path.resolve(process.argv[1]), SELF)) {
  main().catch(() => {
    process.stderr.write('briefstack task guard: the check failed, so nothing is allowed.\n');
    process.exitCode = 2;
  });
}
