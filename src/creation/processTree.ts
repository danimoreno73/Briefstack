import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

/**
 * Starting Claude Code ourselves, so the server can end the whole process
 * tree. H0 showed that on Windows closing the SDK's query leaves a running
 * command (the shell and its `node` child) orphaned, and `SessionEnd` does
 * not fire. The SDK accepts our own spawn through `spawnClaudeCodeProcess`.
 */

export type RunKill = (file: string, args: string[]) => Promise<void>;

const defaultRun: RunKill = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000 }, () => resolve());
  });

/**
 * Ends `pid` and everything it started. Windows: `taskkill /T /F`. Elsewhere
 * the process leads its own group (see `spawnTracked`), so the group gets the
 * signal. Never throws: a process that is already gone is not an error.
 */
export async function killProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: RunKill = defaultRun,
  signal: (pid: number, signal: NodeJS.Signals) => void = (target, sig) => process.kill(target, sig),
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === 'win32') {
    await run('taskkill', ['/PID', String(pid), '/T', '/F']);
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      signal(target, 'SIGKILL');
    } catch {
      // Already gone, or not a group leader.
    }
  }
}

export type RunKillSync = (file: string, args: string[]) => void;

const defaultRunSync: RunKillSync = (file, args) => {
  try {
    execFileSync(file, args, { windowsHide: true, timeout: 10_000, stdio: 'ignore' });
  } catch {
    // Already gone, or taskkill timed out: nothing more can be done while exiting.
  }
};

/**
 * `killProcessTree`, but synchronous, for Node's `exit` event, where nothing
 * asynchronous runs any more. Never throws.
 */
export function killProcessTreeSync(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: RunKillSync = defaultRunSync,
  signal: (pid: number, signal: NodeJS.Signals) => void = (target, sig) => process.kill(target, sig),
): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === 'win32') {
    run('taskkill', ['/PID', String(pid), '/T', '/F']);
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      signal(target, 'SIGKILL');
    } catch {
      // Already gone, or not a group leader.
    }
  }
}

/** Every process `spawnTracked` started that has not exited yet. */
const liveTrees = new Set<ChildProcess>();
let exitHookInstalled = false;

/**
 * Ends the tree of every tracked process still running, synchronously.
 * Installed on Node's `exit` event by the first `spawnTracked` spawn: the
 * SDK itself only closes `claude`'s stdin there on Windows (docs/decisions.md,
 * "If `briefstack web` crashes"), so without this an uncaught exception or a
 * `process.exit()` would leave the trees running. A hard kill of the server
 * runs no handler at all; the run files cover that (`runFiles.ts`).
 */
export function killLiveTreesSync(kill: (pid: number) => void = (pid) => killProcessTreeSync(pid)): void {
  for (const child of [...liveTrees]) {
    liveTrees.delete(child);
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) kill(child.pid);
  }
}

/** The pids of the tracked processes still running. */
export function liveTreePids(): number[] {
  return [...liveTrees].flatMap((child) => (child.pid === undefined ? [] : [child.pid]));
}

function track(child: ChildProcess): void {
  liveTrees.add(child);
  child.once('exit', () => liveTrees.delete(child));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => killLiveTreesSync());
  }
}

export interface TrackedSpawn {
  /** For `spawnClaudeCodeProcess`. */
  spawn(options: SpawnOptions): SpawnedProcess;
  /** Ends the process tree of the process last spawned; resolves at once when there is none. */
  killTree(): Promise<void>;
}

/** A spawn function that remembers the process it started. */
export function spawnTracked(kill: (pid: number) => Promise<void> = (pid) => killProcessTree(pid)): TrackedSpawn {
  let child: ChildProcess | undefined;
  return {
    spawn(options) {
      const started = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Its own process group on POSIX, so the group can be signalled.
        detached: process.platform !== 'win32',
      });
      child = started;
      track(started);
      const onAbort = () => {
        if (started.pid !== undefined) void kill(started.pid);
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
      return started as unknown as SpawnedProcess;
    },
    async killTree() {
      const pid = child?.pid;
      if (pid === undefined || child?.exitCode !== null) return;
      await kill(pid);
    },
  };
}
