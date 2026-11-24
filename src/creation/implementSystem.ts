import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { noRepoCodeArgs } from '../scaffold/commit.js';
import { protectedProjectName } from './guard.js';
import { isDroppedForCodex } from '../codex/env.js';
import { isPathInside, systemPathEnv } from '../config/paths.js';
import { offlineEnv } from '../improve/verify.js';
import { git } from '../library/git.js';
import { hideAbsolutePaths } from '../panel/project.js';
import { commitProject } from '../scaffold/commit.js';
import { realpathNearest } from '../scaffold/outputDir.js';
import { declaresHooks, isDefinitionFile } from '../tasks/guard.js';
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
  /** The brief's "Current status" section (M5: what is done and what is left), cut and redacted; `undefined` when none. */
  currentStatus(dir: string): Promise<string | undefined>;
  /**
   * Puts back, as the workspace commit has them, the protected files
   * changed since it (`protectedProjectFile`: briefstack's files, Claude
   * Code's settings and hooks, `.mcp.json`, hook folders), whoever changed
   * them (Codex's file tool does not pass through the guard: review of M4,
   * I1). Returns the paths put back, relative to the project.
   */
  revertProtected(dir: string, snapshot: ProtectedSnapshot): Promise<string[]>;
  /**
   * Puts back, as the workspace had them, the skills, commands and agents
   * changed since the workspace commit whose frontmatter declares hooks
   * (`declaresHooks`, as a task refuses them: the user's decision of
   * 2026-11-24), whoever wrote them. Returns their paths.
   */
  revertHookDefinitions(dir: string, snapshot: ProtectedSnapshot): Promise<string[]>;
  /**
   * The protected files and the definitions git ignores, as they are when
   * the step starts (review of M5, B1: `.claude/settings.local.json` is
   * ignored in every generated project, and a commit never shows them).
   */
  snapshotProtected(dir: string): Promise<ProtectedSnapshot>;
}

/** Ignored protected files and their bytes, by path relative to the project. */
export type ProtectedSnapshot = ReadonlyMap<string, Buffer>;

/** The pathspecs of the protected names, at any depth (`protectedProjectName`). */
const PROTECTED_PATHSPECS = [
  ':(glob,icase)**/.briefstack/**',
  ':(glob,icase)**/.claude/settings*.json',
  ':(glob,icase)**/.claude/hooks/**',
  ':(glob,icase)**/.mcp.json',
  ':(glob,icase)**/.husky/**',
  ':(glob,icase)**/.githooks/**',
];

/** Where Claude Code reads skills, commands and agents, at any depth (`isDefinitionFile`). */
const DEFINITION_PATHSPECS = [':(glob,icase)**/.claude/skills/**', ':(glob,icase)**/.claude/commands/**', ':(glob,icase)**/.claude/agents/**'];

/** A definition on every system as on Windows, where `.Claude/Agents/x.MD` is one. */
const isDefinition = (file: string): boolean => isDefinitionFile(file, { ...systemPathEnv(), caseInsensitive: true });

interface StatusEntry {
  code: string;
  file: string;
}

/** One porcelain `-z` listing (no renames: each path on its own). */
async function statusEntries(dir: string, args: readonly string[]): Promise<StatusEntry[]> {
  return (await git(dir, [...args]))
    .split('\0')
    .filter((entry) => entry.length > 3)
    .map((entry) => ({ code: entry.slice(0, 2), file: entry.slice(3) }));
}

/** Ignored folders that may hold protected names or definitions: git lists them whole, so they are opened. */
const OPENED_FOLDER = /(^|\/)(\.claude|\.husky|\.githooks|\.briefstack)(\/|$)/i;

/**
 * The changed paths under `pathspecs`, ignored ones included, kept by
 * `keep`. In `matching` mode git lists a wholly ignored folder as one entry
 * (`.claude/agents/`); one that may hold what `keep` looks for is listed
 * again file by file. Other ignored folders (`node_modules/`) are not opened.
 */
async function changedEntries(dir: string, config: readonly string[], pathspecs: readonly string[], keep: (file: string) => boolean): Promise<StatusEntry[]> {
  const found: StatusEntry[] = [];
  for (const entry of await statusEntries(dir, [...config, 'status', '--porcelain', '-z', '--no-renames', '--untracked-files=all', '--ignored=matching', '--', ...pathspecs])) {
    if (entry.code === '!!' && entry.file.endsWith('/')) {
      if (!OPENED_FOLDER.test(entry.file)) continue;
      const inside = await statusEntries(dir, ['--literal-pathspecs', ...config, 'status', '--porcelain', '-z', '--no-renames', '--untracked-files=all', '--ignored=traditional', '--', entry.file]);
      found.push(...inside.filter((file) => file.code === '!!' && !file.file.endsWith('/')));
    } else found.push(entry);
  }
  return found.filter((entry) => keep(entry.file));
}

/** One porcelain `-z` listing of the protected paths (no renames: each path on its own), ignored ones included. */
async function protectedStatus(dir: string, config: readonly string[]): Promise<{ code: string; file: string }[]> {
  const status = await git(dir, [...config, 'status', '--porcelain', '-z', '--no-renames', '--untracked-files=all', '--ignored=matching', '--', ...PROTECTED_PATHSPECS]);
  return status
    .split('\0')
    .filter((entry) => entry.length > 3)
    .map((entry) => ({ code: entry.slice(0, 2), file: entry.slice(3) }))
    .filter((entry) => protectedProjectName(entry.file));
}

async function withNoHooks<T>(work: (config: readonly string[]) => Promise<T>): Promise<T> {
  const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'briefstack-no-hooks-'));
  try {
    return await work(noRepoCodeArgs(emptyDir));
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }
}

/**
 * Writes a snapshot's bytes back only inside the project (review of M6,
 * m1): its folder must really be inside it, and whatever stands at the path
 * (a link included) is removed first, so the write never follows a link.
 */
async function writeInside(dir: string, file: string, bytes: Buffer): Promise<void> {
  const target = path.join(dir, file);
  const pathEnv = systemPathEnv();
  await mkdir(path.dirname(target), { recursive: true });
  const [parent, root] = await Promise.all([realpathNearest(path.dirname(target)), realpathNearest(dir)]);
  if (!isPathInside(parent, root, pathEnv)) throw new Error(`not inside the project: ${file}`);
  await rm(target, { force: true, recursive: true });
  await writeFile(target, bytes, { flag: 'wx' });
}

/** Removes a file only when it really is inside the project (review of M5, m4: no link leads it out). */
async function removeInside(dir: string, file: string): Promise<void> {
  const target = path.join(dir, file);
  const pathEnv = systemPathEnv();
  const [real, root] = await Promise.all([realpathNearest(target), realpathNearest(dir)]);
  if (!isPathInside(real, root, pathEnv) || real === root) throw new Error(`not inside the project: ${file}`);
  await rm(target, { force: true, recursive: true });
}

/** The most of the brief's "Current status" the record keeps. */
const MAX_STATUS_CHARS = 3000;

/**
 * The "## Current status" section of a brief: from its heading to the next
 * heading of the same or a higher level, cut, secrets hidden, absolute
 * paths hidden. It is the implementer's text, shown as data.
 */
export function currentStatusOf(brief: string, dir: string): string | undefined {
  const lines = brief.replaceAll('\r\n', '\n').split('\n');
  const start = lines.findIndex((line) => /^##\s+Current status\s*$/i.test(line.trim()));
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  if (body === '') return undefined;
  // Cut at a line's end before redacting (review of M5, m6): no line, and no secret in it, is split in half.
  const head = body.slice(0, MAX_STATUS_CHARS);
  // One long first line (review of M6, m6): cut at a blank instead, never inside a word.
  const cutAt = head.lastIndexOf('\n') > 0 ? head.lastIndexOf('\n') : Math.max(0, head.search(/\s\S*$/));
  const cut = body.length > MAX_STATUS_CHARS ? `${head.slice(0, cutAt)}\n[cut]` : body;
  return cleanCommandOutput(cut, dir);
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
    // No credential either (review of M3, I2): a check runs code nobody read yet, and a later listed command has the network.
    if (/^BRIEFSTACK_/.test(name) || GIT_POINTERS.test(name) || isDroppedForCodex(name)) delete env[name];
  }
  return { ...env, ...NO_CURRENT_DIR_EXE };
}

/** The end of `text`, at most `max` characters, starting at a line's start: no line (and no secret in it) is cut in half. */
function lastLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = text.slice(-max);
  const firstBreak = tail.indexOf('\n');
  if (firstBreak !== -1) return tail.slice(firstBreak + 1);
  // One long line (npm's progress with `\r` only): cut at a blank instead, never inside a word (review of M3, m6).
  const firstBlank = tail.search(/[\s\r]/);
  return firstBlank === -1 ? '' : tail.slice(firstBlank + 1);
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
        // A grandchild still holds the pipes (a server the command left behind): its tree ends too (review of M3, m7).
        end();
        child.stdout?.destroy();
        child.stderr?.destroy();
        done(code);
      }, DRAIN_MS);
      drain.unref();
    });
  });
}

/**
 * The protected paths changed since HEAD (the workspace commit, before the
 * code commit), put back: a tracked one restored from HEAD, a new one
 * removed. git runs with hooks and `fsmonitor` off, as `commitProject`.
 */
export async function snapshotProtectedFiles(dir: string): Promise<ProtectedSnapshot> {
  return withNoHooks(async (config) => {
    const snapshot = new Map<string, Buffer>();
    const ignoredDefinitions = await changedEntries(dir, config, DEFINITION_PATHSPECS, isDefinition);
    for (const entry of [...(await protectedStatus(dir, config)), ...ignoredDefinitions]) {
      if (entry.code !== '!!') continue;
      try {
        snapshot.set(entry.file, await readFile(path.join(dir, entry.file)));
      } catch {
        // A folder or a file gone meanwhile: nothing to keep.
      }
    }
    return snapshot;
  });
}

/**
 * Puts back the protected files changed since the workspace commit: a
 * tracked one from HEAD (its whole state at the commit), an untracked one
 * removed, an ignored one as the snapshot had it (written back, or removed
 * when it did not exist then), and one of the snapshot that went, written
 * back. Throws when any of it fails, so the step does not commit unseen.
 */
export async function revertProtectedChanges(dir: string, snapshot: ProtectedSnapshot = new Map()): Promise<string[]> {
  return withNoHooks(async (config) => {
    const reverted = new Set<string>();
    const seen = new Set<string>();
    for (const { code, file } of await protectedStatus(dir, config)) {
      seen.add(file);
      if (code === '!!') {
        const before = snapshot.get(file);
        if (before === undefined) await removeInside(dir, file);
        else {
          const now = await readFile(path.join(dir, file)).catch(() => undefined);
          if (now !== undefined && now.equals(before)) continue;
          await writeInside(dir, file, before);
        }
      } else if (code === '??') await removeInside(dir, file);
      // A name git reported, read as it is, never as a pattern (review of M5, m4).
      else await git(dir, ['--literal-pathspecs', ...config, 'checkout', 'HEAD', '--', file]).catch(async () => removeInside(dir, file));
      reverted.add(file);
    }
    for (const [file, bytes] of snapshot) {
      // The snapshot keeps ignored definitions too: those are `revertHookDefinitions`' own.
      if (seen.has(file) || !protectedProjectName(file)) continue;
      await writeInside(dir, file, bytes);
      reverted.add(file);
    }
    return [...reverted];
  });
}

/**
 * Puts back the skills, commands and agents changed since the workspace
 * commit whose frontmatter declares hooks, or that cannot be read well
 * enough to tell (`declaresHooks`, the tasks' own test; a link is not read
 * through): a tracked one from HEAD, an untracked one removed, an ignored
 * one as the snapshot had it (removed when it did not exist then). A
 * definition without hooks, or one deleted, stays as it is. Throws when any
 * of it fails, so the step does not commit unseen.
 */
export async function revertHookDefinitions(dir: string, snapshot: ProtectedSnapshot = new Map()): Promise<string[]> {
  return withNoHooks(async (config) => {
    const reverted: string[] = [];
    for (const { code, file } of await changedEntries(dir, config, DEFINITION_PATHSPECS, isDefinition)) {
      const target = path.join(dir, file);
      const info = await lstat(target).catch(() => undefined);
      // Deleted (nothing loads it) or a folder (its files are listed on their own).
      if (info === undefined || info.isDirectory()) continue;
      if (!info.isSymbolicLink() && !declaresHooks(await readFile(target, 'utf8'))) continue;
      const before = code === '??' || code === '!!' ? snapshot.get(file) : undefined;
      if (before !== undefined) {
        // There before the step: as it was then, and left alone when unchanged.
        if (!info.isSymbolicLink() && (await readFile(target)).equals(before)) continue;
        await writeInside(dir, file, before);
      } else if (code === '??' || code === '!!') await removeInside(dir, file);
      // A name git reported, read as it is, never as a pattern (review of M5, m4).
      else await git(dir, ['--literal-pathspecs', ...config, 'checkout', 'HEAD', '--', file]).catch(async () => removeInside(dir, file));
      reverted.push(file);
    }
    return reverted;
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
    revertProtected: (dir, snapshot) => revertProtectedChanges(dir, snapshot),
    revertHookDefinitions: (dir, snapshot) => revertHookDefinitions(dir, snapshot),
    snapshotProtected: (dir) => snapshotProtectedFiles(dir),
    currentStatus: async (dir) => {
      try {
        const file = path.join(dir, 'docs', 'BRIEF.md');
        const info = await stat(file);
        if (!info.isFile() || info.size > 512 * 1024) return undefined;
        return currentStatusOf(await readFile(file, 'utf8'), dir);
      } catch {
        return undefined;
      }
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
