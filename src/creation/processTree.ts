import { execFile, spawn, type ChildProcess } from 'node:child_process';
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
