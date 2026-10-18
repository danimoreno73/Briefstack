import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { killLiveTreesSync, killProcessTree, killProcessTreeSync, liveTreePids, spawnTracked } from '../../src/creation/processTree.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { tempDir } from '../helpers.js';

describe('killProcessTree', () => {
  it('uses taskkill with /T /F on Windows', async () => {
    const calls: [string, string[]][] = [];
    await killProcessTree(4242, 'win32', async (file, args) => void calls.push([file, args]));
    expect(calls).toEqual([['taskkill', ['/PID', '4242', '/T', '/F']]]);
  });

  it('signals the process group and then the process elsewhere, and survives a process that is gone', async () => {
    const signalled: [number, string][] = [];
    await killProcessTree(
      4242,
      'linux',
      async () => undefined,
      (pid, signal) => {
        signalled.push([pid, signal]);
        throw new Error('ESRCH');
      },
    );
    expect(signalled).toEqual([
      [-4242, 'SIGKILL'],
      [4242, 'SIGKILL'],
    ]);
  });

  it('ignores a pid that is not a real one', async () => {
    const calls: unknown[] = [];
    for (const pid of [0, -1, 1.5, Number.NaN]) await killProcessTree(pid, 'win32', async (...args) => void calls.push(args));
    expect(calls).toEqual([]);
  });
});

describe('killProcessTreeSync', () => {
  it('runs taskkill with /T /F on Windows and signals group and process elsewhere', () => {
    const calls: [string, string[]][] = [];
    killProcessTreeSync(4242, 'win32', (file, args) => void calls.push([file, args]));
    expect(calls).toEqual([['taskkill', ['/PID', '4242', '/T', '/F']]]);
    const signalled: [number, string][] = [];
    killProcessTreeSync(4242, 'darwin', () => undefined, (pid, signal) => {
      signalled.push([pid, signal]);
      throw new Error('ESRCH');
    });
    expect(signalled).toEqual([
      [-4242, 'SIGKILL'],
      [4242, 'SIGKILL'],
    ]);
    killProcessTreeSync(0, 'win32', (file, args) => void calls.push([file, args]));
    expect(calls).toHaveLength(1);
  });
});

describe('spawnTracked', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('process-tree'));
  });
  afterEach(() => cleanup());

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitFor = async (probe: () => Promise<boolean> | boolean, ms = 20_000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await probe()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };

  it('ends a process and the child it started, which the SDK alone leaves running', async () => {
    const script = path.join(dir, 'parent.cjs');
    const pidFile = path.join(dir, 'child.pid');
    await writeFile(
      script,
      [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        'fs.writeFileSync(process.argv[2], String(child.pid));',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      'utf8',
    );
    const tracked = spawnTracked();
    const parent = tracked.spawn({
      command: process.execPath,
      args: [script, pidFile],
      cwd: process.cwd(),
      env: { ...process.env },
      signal: new AbortController().signal,
    });
    const parentPid = (parent as unknown as { pid: number }).pid;
    expect(await waitFor(async () => (await readFile(pidFile, 'utf8').catch(() => '')) !== '')).toBe(true);
    const childPid = Number(await readFile(pidFile, 'utf8'));
    expect(alive(parentPid)).toBe(true);
    expect(alive(childPid)).toBe(true);

    await tracked.killTree();
    expect(await waitFor(() => !alive(parentPid) && !alive(childPid))).toBe(true);
    // A second call, with everything gone, does nothing.
    await tracked.killTree();
  }, 40_000);

  it('ends the tree when the SDK aborts the signal it forwards', async () => {
    const abort = new AbortController();
    const tracked = spawnTracked();
    const child = tracked.spawn({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      env: { ...process.env },
      signal: abort.signal,
    });
    const pid = (child as unknown as { pid: number }).pid;
    expect(alive(pid)).toBe(true);
    abort.abort();
    expect(await waitFor(() => !alive(pid))).toBe(true);
  }, 40_000);

  const parentScript = async (): Promise<{ script: string; pidFile: string }> => {
    const script = path.join(dir, 'parent.cjs');
    const pidFile = path.join(dir, 'child.pid');
    await writeFile(
      script,
      [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        'fs.writeFileSync(process.argv[2], String(child.pid));',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      'utf8',
    );
    return { script, pidFile };
  };

  it('lists the processes still running and ends their trees synchronously', async () => {
    const { script, pidFile } = await parentScript();
    const parent = spawnTracked().spawn({
      command: process.execPath,
      args: [script, pidFile],
      cwd: process.cwd(),
      env: { ...process.env },
      signal: new AbortController().signal,
    });
    const parentPid = (parent as unknown as { pid: number }).pid;
    expect(await waitFor(async () => (await readFile(pidFile, 'utf8').catch(() => '')) !== '')).toBe(true);
    const childPid = Number(await readFile(pidFile, 'utf8'));
    expect(liveTreePids()).toContain(parentPid);
    killLiveTreesSync();
    expect(liveTreePids()).not.toContain(parentPid);
    expect(await waitFor(() => !alive(parentPid) && !alive(childPid))).toBe(true);
  }, 40_000);

  // On Windows libuv's job object (kill on close) ends a non-detached child with its host anyway;
  // on macOS and Linux, where the child leads its own group, only the exit hook does (CI runs there).
  it('ends every tracked tree when the process dies of an uncaught exception', async () => {
    const { script, pidFile } = await parentScript();
    const fixture = path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'crash-with-tree.ts');
    const { code, stdout } = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      execFile(process.execPath, ['--import', 'tsx', fixture, script, pidFile], { cwd: PACKAGE_ROOT, timeout: 30_000 }, (error, out) =>
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout: out }),
      );
    });
    expect(code).not.toBe(0);
    const parentPid = Number(/parent (\d+)/.exec(stdout)?.[1]);
    const childPid = Number(await readFile(pidFile, 'utf8'));
    expect(parentPid).toBeGreaterThan(0);
    expect(await waitFor(() => !alive(parentPid) && !alive(childPid))).toBe(true);
  }, 40_000);
});
