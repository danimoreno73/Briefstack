import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { isDroppedForCodex } from '../codex/env.js';
import { isPathInside, systemPathEnv } from '../config/paths.js';
import { hideAbsolutePaths } from '../panel/project.js';
import { commitProject } from '../scaffold/commit.js';
import { realpathNearest } from '../scaffold/outputDir.js';
import { redactSecretLines } from '../validate/secrets.js';
import type { CommandRun, CommitOutcome } from './implement.js';
import { killProcessTree } from './processTree.js';

/**
 * What the implement step does on the machine (phase 10, PLAN-phase-10 §1,
 * 3 and 5): the two commits, a listed command in the project folder, and
 * the folder checks. The step (`implement.ts`) decides; this only does.
 */
export interface ImplementSystem {
  commit(dir: string, message: string): Promise<CommitOutcome>;
  run(dir: string, command: string, signal: AbortSignal): Promise<Omit<CommandRun, 'at'>>;
  isProject(dir: string): Promise<boolean>;
  sameFolder(dir: string, folder: string): Promise<boolean>;
}

/** Each listed command gets this long before its process tree is ended (as a declared check). */
export const COMMAND_TIMEOUT_MS = 10 * 60_000;
/** The output kept of each command: its end. */
const MAX_OUTPUT_CHARS = 16 * 1024;

/**
 * The environment of a listed command: the server's, with the network (an
 * install needs it) but without any credential or variable of ours, Claude
 * Code's or GitHub's (the names Codex's environment drops), nor git's
 * pointers to another repository.
 */
export function commandEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || isDroppedForCodex(name) || /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE)$/i.test(name)) continue;
    env[name] = value;
  }
  return env;
}

/** What the page and the session may see of a command's output: its end, secrets hidden, the project as `.`, other paths hidden. */
export function cleanCommandOutput(output: string, dir: string): string {
  const relative = output.split(dir).join('.').split(dir.split(path.sep).join('/')).join('.');
  return hideAbsolutePaths(redactSecretLines(relative.slice(-MAX_OUTPUT_CHARS)));
}

/** Runs one command line in `dir` with a fixed shell (cmd on Windows, sh elsewhere), in its own group, to its end or its deadline. */
export function runCommandLine(dir: string, command: string, options: { signal: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<Omit<CommandRun, 'at'>> {
  const started = Date.now();
  const env = options.env ?? commandEnv(process.env);
  return new Promise((resolve) => {
    // As the declared checks run (src/tasks/checks.ts): the whole line quoted once for cmd, `/s` takes the quotes off.
    const child =
      process.platform === 'win32'
        ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd: dir, env, windowsHide: true, windowsVerbatimArguments: true })
        : spawn('sh', ['-c', command], { cwd: dir, env, detached: true });
    let output = '';
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-4 * MAX_OUTPUT_CHARS);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.stdin?.end();
    const end = () => {
      if (child.pid !== undefined) void killProcessTree(child.pid).catch(() => child.kill());
      else child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      end();
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    options.signal.addEventListener('abort', end, { once: true });
    if (options.signal.aborted) end();
    const done = (exitCode: number | null, extra = '') => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', end);
      resolve({
        command,
        exitCode: timedOut || options.signal.aborted ? null : exitCode,
        timedOut,
        output: cleanCommandOutput(`${output}${extra}`, dir),
        durationMs: Math.max(0, Date.now() - started),
      });
    };
    child.on('error', (error) => done(null, `\n${error.message}`));
    child.on('close', (code) => done(code));
  });
}

/** The real system: `commitProject`, a fixed shell, the disk. */
export function realImplementSystem(): ImplementSystem {
  const pathEnv = systemPathEnv();
  return {
    commit: async (dir, message) => {
      const result = await commitProject(dir, { message });
      return {
        committed: result.committed,
        nothingToCommit: result.nothingToCommit,
        ...(result.commit === undefined ? {} : { commit: result.commit }),
        ...(result.warning === undefined ? {} : { warning: result.warning.code }),
      };
    },
    run: (dir, command, signal) => runCommandLine(dir, command, { signal }),
    isProject: async (dir) => {
      try {
        return (await stat(path.join(dir, '.briefstack', 'profile.json'))).isFile();
      } catch {
        return false;
      }
    },
    sameFolder: async (dir, folder) => {
      if (!path.isAbsolute(dir)) return false;
      try {
        const [a, b] = await Promise.all([realpathNearest(path.resolve(dir)), realpathNearest(path.resolve(folder))]);
        return isPathInside(a, b, pathEnv) && isPathInside(b, a, pathEnv);
      } catch {
        return false;
      }
    },
  };
}
