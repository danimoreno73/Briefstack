import type { ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { killProcessTree, spawnTracked, type TrackedSpawn } from '../creation/processTree.js';
import type { CodexCommand } from './command.js';
import { CodexEventReader, type CodexCommandRun, type CodexUsage } from './events.js';
import type { CodexSandboxMode } from './limits.js';

/**
 * Running the user's Codex CLI (decisions.md, "Phase 8: step 25"): no shell,
 * the environment the caller cleaned, a deadline, and the whole process tree
 * ended when the deadline passes or the caller aborts (a cancelled task, a
 * stopped round, a server stop). A process still running when the server
 * exits is ended by `spawnTracked`'s exit hook.
 */

/** How a run ended: by itself, past its deadline, aborted by the caller, or it never started. */
export type CodexEnded = 'exited' | 'timedOut' | 'cancelled' | 'notStarted';

export interface CodexProcessResult {
  exitCode: number | null;
  ended: CodexEnded;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface CodexProcessOptions {
  command: CodexCommand;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  /** Written to stdin, which is then closed. */
  stdin?: string;
  signal?: AbortSignal;
  /** Each stdout chunk as it arrives. When set, `stdout` in the result stays empty. */
  onStdout?: (chunk: string) => void;
  /** Injected in tests. */
  tracked?: () => TrackedSpawn;
  /** The clock of the duration. */
  now?: () => number;
  /** Arms the deadline; returns what disarms it. Tests fire it themselves. Default `setTimeout`. */
  timer?: Timer;
}

export type Timer = (ms: number, fire: () => void) => () => void;

const realTimer: Timer = (ms, fire) => {
  const handle = setTimeout(fire, ms);
  handle.unref();
  return () => clearTimeout(handle);
};

const MAX_KEPT_OUTPUT = 64 * 1024;
/** After the process exits, how long its pipes may stay open before they are dropped. */
const DRAIN_MS = 2000;

const keep = (current: string, chunk: string): string => (current.length >= MAX_KEPT_OUTPUT ? current : (current + chunk).slice(0, MAX_KEPT_OUTPUT));

/** Runs one Codex command to its end. Never throws. */
export function runCodexProcess(options: CodexProcessOptions): Promise<CodexProcessResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const abort = new AbortController();
  let ended: CodexEnded = 'exited';
  const stopWith = (why: 'timedOut' | 'cancelled') => {
    if (abort.signal.aborted) return;
    ended = why;
    abort.abort();
  };
  if (options.signal?.aborted === true) {
    return Promise.resolve({ exitCode: null, ended: 'cancelled', durationMs: 0, stdout: '', stderr: '' });
  }
  const onCallerAbort = () => stopWith('cancelled');
  options.signal?.addEventListener('abort', onCallerAbort, { once: true });

  return new Promise<CodexProcessResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const deadline: { disarm?: () => void } = {};
    let drain: NodeJS.Timeout | undefined;
    let child: ChildProcess;
    const finish = (exitCode: number | null, how?: CodexEnded) => {
      if (settled) return;
      settled = true;
      deadline.disarm?.();
      if (drain !== undefined) clearTimeout(drain);
      options.signal?.removeEventListener('abort', onCallerAbort);
      resolve({ exitCode: how === 'notStarted' ? null : exitCode, ended: how ?? ended, durationMs: Math.max(0, now() - started), stdout, stderr });
    };
    try {
      const tracked = (options.tracked ?? (() => spawnTracked((pid) => killProcessTree(pid))))();
      child = tracked.spawn({ command: options.command.file, args: [...options.command.prefix, ...options.args], cwd: options.cwd, env: { ...options.env }, signal: abort.signal }) as unknown as ChildProcess;
    } catch {
      finish(null, 'notStarted');
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (options.onStdout !== undefined) options.onStdout(chunk);
      else stdout = keep(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = keep(stderr, chunk);
    });
    child.once('error', () => finish(null, child.pid === undefined ? 'notStarted' : undefined));
    // Every byte of stdout is read before the result: `close` comes after the pipes end.
    child.once('close', (code) => finish(code));
    child.once('exit', (code) => {
      drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code);
      }, DRAIN_MS);
      drain.unref();
    });
    deadline.disarm = (options.timer ?? realTimer)(options.timeoutMs, () => stopWith('timedOut'));
    // A child that fails to start closes its stdin: the exit code reports that, not a crash.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.stdin ?? '');
  });
}

export interface CodexExecOptions {
  command: CodexCommand;
  worktree: string;
  /** The instruction from Claude: the only thing of the session that reaches Codex, on stdin. */
  instruction: string;
  /** The Windows sandbox mode; only passed on Windows. */
  mode?: CodexSandboxMode | undefined;
  /** Where Codex writes its final message (`-o`), outside the worktree. Removed after it is read. */
  outFile: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  platform?: NodeJS.Platform;
  tracked?: () => TrackedSpawn;
  now?: () => number;
  timer?: Timer;
}

export interface CodexExecResult {
  exitCode: number | null;
  ended: CodexEnded;
  durationMs: number;
  threadId?: string;
  /** From `turn.completed`: a call ended before it reports none. */
  usage?: CodexUsage;
  /** The `-o` file, or the last agent message when there is none. Cut, never acted on. */
  finalMessage: string;
  commands: CodexCommandRun[];
  commandCount: number;
  /** Why the turn failed, from `turn.failed` or `error`. */
  failure?: string;
  /** The first part of stderr. */
  stderr: string;
}

const MAX_FINAL = 16_000;

/**
 * The arguments of one call, exactly as measured (decisions.md, "Phase 8:
 * Codex spike"): workspace-write sandbox, no approvals, nothing kept after
 * the call, the worktree as the folder, the final message to a file, the
 * instruction on stdin. The mode only on Windows (not measured elsewhere).
 */
export function codexExecArgs(options: { worktree: string; outFile: string; mode?: CodexSandboxMode | undefined; platform?: NodeJS.Platform }): string[] {
  const windows = (options.platform ?? process.platform) === 'win32';
  return [
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '--ephemeral',
    '-c',
    'approval_policy="never"',
    ...(windows && options.mode !== undefined ? ['-c', `windows.sandbox="${options.mode}"`] : []),
    '-C',
    options.worktree,
    '-o',
    options.outFile,
    '-',
  ];
}

/** One `codex exec` call in the worktree. Never throws. */
export async function runCodexExec(options: CodexExecOptions): Promise<CodexExecResult> {
  const reader = new CodexEventReader();
  try {
    await mkdir(path.dirname(options.outFile), { recursive: true });
    await rm(options.outFile, { force: true });
  } catch {
    // Codex reports the file it could not write; the agent message stands in.
  }
  const ran = await runCodexProcess({
    command: options.command,
    args: codexExecArgs(options),
    cwd: options.worktree,
    env: options.env,
    timeoutMs: options.timeoutMs,
    stdin: options.instruction,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onStdout: (chunk) => reader.push(chunk),
    ...(options.tracked === undefined ? {} : { tracked: options.tracked }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.timer === undefined ? {} : { timer: options.timer }),
  });
  const events = reader.end();
  let final: string | undefined;
  try {
    final = await readFile(options.outFile, 'utf8');
  } catch {
    final = undefined;
  }
  await rm(options.outFile, { force: true }).catch(() => undefined);
  const message = (final !== undefined && final.trim() !== '' ? final : (events.lastMessage ?? '')).trim().slice(0, MAX_FINAL);
  return {
    exitCode: ran.exitCode,
    ended: ran.ended,
    durationMs: ran.durationMs,
    ...(events.threadId === undefined ? {} : { threadId: events.threadId }),
    ...(events.usage === undefined ? {} : { usage: events.usage }),
    finalMessage: message,
    commands: events.commands,
    commandCount: events.commandCount,
    ...(events.failure === undefined ? {} : { failure: events.failure }),
    stderr: ran.stderr.slice(0, 4000),
  };
}
