import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { isDroppedForCodex } from '../codex/env.js';
import { isPathInside, systemPathEnv } from '../config/paths.js';
import { offlineEnv } from '../improve/verify.js';
import { git } from '../library/git.js';
import { hideAbsolutePaths } from '../panel/project.js';
import { commitProject } from '../scaffold/commit.js';
import { realpathNearest } from '../scaffold/outputDir.js';
import type { CheckResult } from '../tasks/types.js';
import { redactSecretLines } from '../validate/secrets.js';
import type { CommandRun, CommitOutcome } from './implement.js';
import { killProcessTree } from './processTree.js';

/**
 * What the implement step does on the machine (phase 10, PLAN-phase-10 §1,
 * 3, 5 and 8): the two commits, a listed command and the declared checks in
 * the project folder, and the folder checks. The step (`implement.ts`)
 * decides; this only does.
 */
export interface ImplementSystem {
  commit(dir: string, message: string): Promise<CommitOutcome>;
  run(dir: string, command: string, signal: AbortSignal): Promise<Omit<CommandRun, 'at'>>;
  /** The declared checks, one after the other, as declared checks run: offline, 10 minutes each. */
  checks(dir: string, commands: readonly string[], signal: AbortSignal): Promise<CheckResult[]>;
  isProject(dir: string): Promise<boolean>;
  sameFolder(dir: string, folder: string): Promise<boolean>;
}

/** Each listed command gets this long before its process tree is ended (as a declared check). */
export const COMMAND_TIMEOUT_MS = 10 * 60_000;
/** The output kept of each command: its end. */
const MAX_OUTPUT_CHARS = 16 * 1024;
/** After the process exits, how long its pipes may stay open (a grandchild holding them) before they are dropped. */
const DRAIN_MS = 2000;

/** Variables no command of the step gets: git's pointers to another repository or config (review of M2, m3). */
const GIT_POINTERS = /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CONFIG.*|GIT_EXEC_PATH)$/i;

/**
 * On Windows, cmd looks for a program in the current folder before the
 * PATH; with this set it does not, so a `npm.cmd` written in the project
 * cannot stand in for the approved `npm` (review of M2, m3).
 */
const NO_CURRENT_DIR_EXE = { NoDefaultCurrentDirectoryInExePath: '1' };

/**
 * The environment of a listed command: the server's, with the network (an
 * install needs it) but without any credential or variable of ours, Claude
 * Code's or GitHub's (the names Codex's environment drops), nor git's
 * pointers to another repository.
 */
export function commandEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || isDroppedForCodex(name) || GIT_POINTERS.test(name)) continue;
    env[name] = value;
  }
  return { ...env, ...NO_CURRENT_DIR_EXE };
}

/**
 * The environment of a check: as a task's declared check (`checkEnv` in
 * `src/tasks/checks.ts`, which only the tasks' wiring imports, S8): no
 * network (proxies pointed nowhere), no credentials of Claude Code, no
 * briefstack variables, no git pointers to another repository.
 */
export function checkEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = offlineEnv(source);
  for (const name of Object.keys(env)) {
    if (/^BRIEFSTACK_/.test(name) || GIT_POINTERS.test(name)) delete env[name];
  }
  return { ...env, ...NO_CURRENT_DIR_EXE };
}

/** The end of `text`, at most `max` characters, starting at a line's start: no line (and no secret in it) is cut in half. */
function lastLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = text.slice(-max);
  const firstBreak = tail.indexOf('\n');
  return firstBreak === -1 ? '' : tail.slice(firstBreak + 1);
}

/**
 * What the page and the session may see of a command's output: its end
 * (cut at a line's start, then redacted: review of M2, m2), secrets hidden,
 * the project as `.`, other absolute paths hidden.
 */
export function cleanCommandOutput(output: string, dir: string): string {
  const relative = output.split(dir).join('.').split(dir.split(path.sep).join('/')).join('.');
  return hideAbsolutePaths(redactSecretLines(lastLines(relative, MAX_OUTPUT_CHARS)));
}

/**
 * Runs one command line in `dir` with a fixed shell (cmd on Windows, sh
 * elsewhere), in its own group, to its end or its deadline. It ends once the
 * process exits and its pipes close, or `DRAIN_MS` after the exit when a
 * grandchild keeps them open (review of M2, m11).
 */
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
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    const keep = (chunk: Buffer) => {
      output = lastLines(output + chunk.toString('utf8'), 4 * MAX_OUTPUT_CHARS);
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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drain !== undefined) clearTimeout(drain);
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
    child.on('exit', (code) => {
      drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        done(code);
      }, DRAIN_MS);
      drain.unref();
    });
  });
}

/** The head's commit id, or `undefined`. */
async function headOf(dir: string): Promise<string | undefined> {
  try {
    const id = (await git(dir, ['rev-parse', '--verify', 'HEAD'])).trim();
    return /^[0-9a-f]{7,64}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The real system: `commitProject`, a fixed shell, the disk. */
export function realImplementSystem(): ImplementSystem {
  const pathEnv = systemPathEnv();
  return {
    commit: async (dir, message) => {
      try {
        const result = await commitProject(dir, { message });
        // Nothing to commit: the head stands for the commit (review of M2, m7).
        const commit = result.commit ?? (result.nothingToCommit ? await headOf(dir) : undefined);
        return {
          committed: result.committed,
          nothingToCommit: result.nothingToCommit,
          ...(commit === undefined ? {} : { commit }),
          ...(result.warning === undefined ? {} : { warning: result.warning.code }),
        };
      } catch (error) {
        // A project whose .briefstack/profile.json went (review of M2, m4): a warning, never a stuck step.
        return { committed: false, nothingToCommit: false, warning: (error as { code?: unknown }).code === 'usage.notABriefstackProject' ? 'notABriefstackProject' : 'commitFailed' };
      }
    },
    run: (dir, command, signal) => runCommandLine(dir, command, { signal }),
    checks: async (dir, commands, signal) => {
      const results: CheckResult[] = [];
      for (const command of commands) {
        if (signal.aborted) break;
        results.push(await runCommandLine(dir, command, { signal, env: checkEnvironment(process.env) }));
      }
      return results;
    },
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
