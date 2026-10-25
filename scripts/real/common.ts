// Shared helpers for the real-session checks of phase 2 (PLAN-phase-2.md,
// "Real runs"). These scripts START REAL CLAUDE CODE SESSIONS with the user's
// own login and spend a little of their plan. They are never run by the test
// suite or by CI; the user runs them on purpose, from PowerShell:
//
//   npx tsx scripts/real/<script>.ts --yes
//
// Each one works in a folder it creates (`sandbox()`: including a temp
// BRIEFSTACK_HOME), outside every protected folder and the user's real data,
// and deletes it at the end. None touches the real library or projects.

import type { HookCallback, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  configFilePath,
  isFullyAbsolute,
  isPathInside,
  readConfig,
  resolvePaths,
  systemPathEnv,
  updateConfig,
  type PathEnv,
} from '../../src/config/index.js';
import type { Pending } from '../../src/creation/manager.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { protectedDirs, realpathNearest } from '../../src/scaffold/outputDir.js';
import { findClaudeExecutable } from '../../src/creation/claudeBinary.js';
import { addNote, initLibrary } from '../../src/library/index.js';
import { readPlanUsage as readPlanUsageIn, type PlanUsage } from '../../src/creation/planUsage.js';
import { cleanEnvironment } from '../../src/creation/sdkRunner.js';

/** The scripts do nothing without `--yes`, so a stray run spends no tokens. */
export function requireConfirmation(description: string): void {
  if (process.argv.includes('--yes')) return;
  console.error(`${description}\n\nThis starts a real Claude Code session with your login and uses part of your plan.`);
  console.error('Run it again with --yes to go ahead.');
  process.exit(2);
}

export interface Sandbox {
  dir: string;
  /** A temp BRIEFSTACK_HOME. */
  home: string;
  /** The working folder of the session: not the repo, not a real project. */
  project: string;
  projects: string;
  sessions: string;
  cleanup(): Promise<void>;
}

/** A folder the sandbox must stay out of, either way round. */
export interface KeepOut {
  name: string;
  path: string;
}

/**
 * Where the user's real data lives, and the folders a project may never be
 * created in (`protectedDirs`: the repo, the home, the library, `~/.claude`,
 * `%APPDATA%`, `%LOCALAPPDATA%`), as the environment the script started with sees them.
 */
export async function realKeepOut(pathEnv: PathEnv): Promise<KeepOut[]> {
  let paths;
  try {
    paths = resolvePaths(await readConfig(configFilePath(pathEnv)), pathEnv);
  } catch {
    paths = resolvePaths({}, pathEnv);
  }
  return [
    ...protectedDirs(paths.libraryDir, PACKAGE_ROOT, pathEnv).map((dir) => ({ name: dir.root, path: dir.path })),
    { name: 'projects', path: paths.projectsDir },
  ];
}

/** The first entry of `keepOut` that `dir` overlaps (inside it, or containing it), after `realpath`. */
export async function overlapping(dir: string, keepOut: readonly KeepOut[], style: Pick<PathEnv, 'pathApi' | 'caseInsensitive'>): Promise<KeepOut | undefined> {
  const real = await realpathNearest(dir);
  for (const entry of keepOut) {
    const root = await realpathNearest(entry.path);
    if (isPathInside(real, root, style) || isPathInside(root, real, style)) return entry;
  }
  return undefined;
}

/**
 * Where the sandboxes go: `BRIEFSTACK_REAL_WORKDIR` if set, else the system
 * temp folder, else `~/.briefstack-real`. On Windows the temp folder is inside
 * `%LOCALAPPDATA%`, which `paths check` refuses as a projects folder.
 */
export function workRootCandidates(pathEnv: PathEnv, tmpdir: string = os.tmpdir()): string[] {
  const chosen = pathEnv.env.BRIEFSTACK_REAL_WORKDIR;
  if (chosen !== undefined && chosen !== '') return [chosen];
  return [tmpdir, pathEnv.pathApi.join(pathEnv.homedir, '.briefstack-real')];
}

export interface SandboxOptions {
  /** The environment the script started with; `process.env` by default. Its `BRIEFSTACK_HOME` is set to the sandbox's. */
  pathEnv?: PathEnv;
  /** Tests pass their own; `workRootCandidates` otherwise. */
  candidates?: string[];
}

/**
 * A fresh folder for one real check, outside every protected folder and the
 * user's real data on every system, checked before anything runs in it. From
 * here on `BRIEFSTACK_HOME` (in `process.env` by default) is the sandbox's, so
 * every child process and every default path uses the temp home.
 */
export async function sandbox(prefix: string, options: SandboxOptions = {}): Promise<Sandbox> {
  const pathEnv = options.pathEnv ?? systemPathEnv();
  const keepOut = await realKeepOut(pathEnv);
  const candidates = options.candidates ?? workRootCandidates(pathEnv);
  let root: string | undefined;
  const refused: string[] = [];
  for (const candidate of candidates) {
    if (!isFullyAbsolute(candidate, pathEnv.pathApi)) {
      refused.push(`${candidate} (not an absolute path)`);
      continue;
    }
    const overlap = await overlapping(candidate, keepOut, pathEnv);
    if (overlap === undefined) {
      root = pathEnv.pathApi.resolve(candidate);
      break;
    }
    refused.push(`${candidate} (overlaps ${overlap.name}: ${overlap.path})`);
  }
  if (root === undefined) {
    throw new Error(`No work folder outside the protected folders: ${refused.join('; ')}. Set BRIEFSTACK_REAL_WORKDIR to one.`);
  }
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, `briefstack-real-${prefix}-`));
  const made = {
    dir,
    home: path.join(dir, 'home'),
    project: path.join(dir, 'project'),
    projects: path.join(dir, 'projects'),
    sessions: path.join(dir, 'home', 'sessions'),
  };
  // Windows keeps a folder locked for a while after a session closes: retry.
  const cleanup = () => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  // The projects folder must also pass the check the flow runs with the temp home (`paths check`).
  const sandboxEnv: PathEnv = { ...pathEnv, env: { ...pathEnv.env, BRIEFSTACK_HOME: made.home } };
  const flowKeepOut = protectedDirs(path.join(made.home, 'library'), PACKAGE_ROOT, sandboxEnv).map((d) => ({ name: d.root, path: d.path }));
  const projectsOverlap = await overlapping(made.projects, [...keepOut, ...flowKeepOut], pathEnv);
  if (projectsOverlap !== undefined) {
    await cleanup();
    throw new Error(`The sandbox projects folder ${made.projects} overlaps ${projectsOverlap.name}: ${projectsOverlap.path}.`);
  }
  for (const folder of [made.home, made.project, made.projects, made.sessions]) await mkdir(folder, { recursive: true });
  (pathEnv.env as Record<string, string | undefined>).BRIEFSTACK_HOME = made.home;
  console.log(`Work folder: ${dir}`);
  return { ...made, cleanup };
}

/** Throws, so a check that has started something still closes it (see `startCheck`). */
export function claudeExecutable(): string {
  const executable = findClaudeExecutable({ env: process.env, platform: process.platform, homedir: os.homedir() });
  if (executable === undefined) throw new Error('Claude Code was not found on PATH or in ~/.local/bin.');
  return executable;
}

/** Ends a check early with an exit code and a message, without counting as a crash. */
export class CheckStop extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** What `startCheck` needs from the process; tests pass their own. */
export interface CheckProcess {
  on(event: 'unhandledRejection' | 'uncaughtException', listener: (error: unknown) => void): unknown;
  off(event: 'unhandledRejection' | 'uncaughtException', listener: (error: unknown) => void): unknown;
  exit(code: number): void;
}

/**
 * A running real check and everything it must close. Each script does
 *
 *   const check = startCheck();
 *   try { ... } catch (error) { check.fail(error); } finally { await check.close(); }
 *   process.exit(check.exitCode(ok));
 *
 * and registers each session, manager and sandbox with `add` or `query` as
 * soon as it exists. `close()` runs them once, last added first, each one
 * even if another throws, so no Claude Code process outlives the script.
 * An error nothing awaited (an unhandled rejection or an uncaught exception)
 * would end Node before any `finally`: it is reported, everything is closed
 * and the process exits with 1.
 */
export class Check {
  private readonly closes: (() => unknown)[] = [];
  private failed = false;
  private stopCode: number | undefined;
  private closing: Promise<void> | undefined;
  private readonly onCrash = (error: unknown): void => {
    this.fail(error);
    void this.close().then(() => this.proc.exit(1));
  };

  constructor(
    private readonly proc: CheckProcess,
    private readonly log: (line: string) => void,
  ) {
    proc.on('unhandledRejection', this.onCrash);
    proc.on('uncaughtException', this.onCrash);
  }

  /** Runs `close` when the check ends, whatever happens. */
  add(close: () => unknown): void {
    this.closes.push(close);
  }

  /** A query (and the process tree it was spawned in): closed and killed when the check ends. Returns `q`. */
  query<Q extends { close(): void }>(q: Q, tracked?: { killTree(): Promise<void> }): Q {
    this.add(async () => {
      q.close();
      await tracked?.killTree();
    });
    return q;
  }

  /** Records an error: the check fails, and the error is printed. A `CheckStop` sets its code instead. */
  fail(error: unknown): void {
    if (error instanceof CheckStop) {
      this.stopCode ??= error.code;
      this.log(error.message);
      return;
    }
    this.failed = true;
    this.log(`ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }

  /** Closes everything registered, once. Never throws. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      for (const close of [...this.closes].reverse()) {
        try {
          await close();
        } catch (error) {
          this.failed = true;
          this.log(`ERROR while closing: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      this.proc.off('unhandledRejection', this.onCrash);
      this.proc.off('uncaughtException', this.onCrash);
    })();
    return this.closing;
  }

  /** 0 when every check passed, the `CheckStop` code if one stopped it, 1 otherwise. */
  exitCode(ok: boolean): number {
    if (this.failed) return 1;
    if (this.stopCode !== undefined) return this.stopCode;
    return ok ? 0 : 1;
  }
}

export function startCheck(proc: CheckProcess = process, log: (line: string) => void = (line) => console.error(line)): Check {
  return new Check(proc, log);
}

/**
 * The environment of a session, as `briefstack web` builds it: the user's own
 * credentials as they are, no other CLAUDE_CODE_*, the sandbox as BRIEFSTACK_HOME.
 */
export function sessionEnv(box: Sandbox): Record<string, string | undefined> {
  const { env, removed } = cleanEnvironment(process.env, box.home);
  if (removed.length > 0) console.log(`Not passed to Claude Code: ${removed.join(', ')}`);
  return env;
}

export type { PlanUsage } from '../../src/creation/planUsage.js';

/**
 * Reads the plan usage the way `/usage` does, from a session that sends no
 * message (so it costs nothing). The same reading the web server records
 * during a creation (`src/creation/planUsage.ts`).
 */
export function readPlanUsage(box: Sandbox, executable: string): Promise<PlanUsage | string> {
  return readPlanUsageIn({ cwd: box.project, executable, env: sessionEnv(box) });
}

export function show(usage: PlanUsage | string): string {
  return typeof usage === 'string' ? usage : `5-hour window ${usage.fiveHour ?? '?'}%, 7-day window ${usage.sevenDay ?? '?'}%`;
}

/**
 * The `git status` the preflight runs. `--no-optional-locks` keeps git from
 * refreshing the index, so even in the real repo and library nothing is written.
 */
export const GIT_STATUS_ARGS: readonly string[] = ['--no-optional-locks', 'status', '--porcelain'];

/**
 * A `canUseTool` that allows one shell command, character for character, and
 * denies everything else: another command, a chained one, another tool.
 */
export function onlyThisCommand(expected: string): (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult> {
  return async (toolName, input) => {
    const command = typeof input.command === 'string' ? input.command.trim() : undefined;
    if ((toolName === 'Bash' || toolName === 'PowerShell') && command === expected) {
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: 'This check allows only the one command it asked for.' };
  };
}

/**
 * A `Stop` hook that keeps the effort Claude Code applied to the turn. The
 * init message of an SDK session does not carry it (the field is only on
 * Remote Control frames), but hook inputs in a tool-use context, `Stop`
 * among them, carry `effort.level` after any downgrade for the model.
 */
export function effortRecorder(): { hook: HookCallback; level: () => string | undefined } {
  let level: string | undefined;
  return {
    hook: async (input) => {
      const reported = (input as { effort?: { level?: unknown } }).effort?.level;
      if (input.hook_event_name === 'Stop' && typeof reported === 'string' && reported !== '') level = reported;
      return {};
    },
    level: () => level,
  };
}

export function report(name: string, passed: boolean, detail: string): boolean {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  return passed;
}

/** A prompt that stays open until `close()`, so the session can be driven by hand. */
export function oneShot(text: string): AsyncIterable<{
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
}> {
  let sent = false;
  return {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        sent
          ? new Promise(() => undefined)
          : ((sent = true), Promise.resolve({ value: { type: 'user' as const, message: { role: 'user' as const, content: text }, parent_tool_use_id: null }, done: false })),
    }),
  };
}

/**
 * A temp library in the sandbox's BRIEFSTACK_HOME with one project note, and
 * the path environment that points at it. `init` writes its folder settings
 * into the sandbox's own `project` folder, never into the briefstack repo.
 */
export async function sandboxLibrary(box: Sandbox): Promise<PathEnv> {
  const libraryDir = path.join(box.home, 'library');
  await initLibrary({ libraryDir, projectsDir: box.projects, sessionsDir: box.sessions, repoDir: box.project });
  await updateConfig(path.join(box.home, 'config.json'), { projectsDir: box.projects, lang: 'en' });
  await addNote({
    libraryDir,
    section: 'projects',
    name: 'seed-tracker',
    text: [
      '---',
      'target: claude-app',
      `path: ${path.join(box.projects, 'seed-tracker').replaceAll('\\', '/')}`,
      'status: created',
      'profile: saver',
      'summary: Tracks which seeds to sow each month.',
      '---',
      '# Seed tracker',
      '',
      'Tracks which seeds to sow each month.',
      '',
    ].join('\n'),
  });
  return {
    env: { ...process.env, BRIEFSTACK_HOME: box.home },
    homedir: os.homedir(),
    pathApi: path,
    caseInsensitive: process.platform !== 'linux',
  };
}

// Absolute paths in free text: a drive (`C:\`, `C:/`), a UNC share, `~/`, or a
// POSIX root that does not continue a word, a number or a URL scheme.
const PATH_PATTERN = /(?:(?<!\w)[A-Za-z]:[\\/]|\\\\|~[\\/]|(?<![\w.:~/\\])\/(?=[^\s/]))[^\s"'`<>|*?,;()[\]{}]*/g;

/** The absolute paths `text` mentions, without trailing punctuation. */
export function mentionedPaths(text: string): string[] {
  return [...text.matchAll(PATH_PATTERN)].map((match) => match[0].replace(/[.:!]+$/, '')).filter((found) => found !== '');
}

/** Whether every path `text` mentions is inside `dir` (true when it mentions none). `~` paths never are. */
export function pathsInside(text: string, dir: string, style: Pick<PathEnv, 'pathApi' | 'caseInsensitive'>): boolean {
  return mentionedPaths(text).every((found) => !found.startsWith('~') && isPathInside(style.pathApi.resolve(found), dir, style));
}

export type AutoAnswer = { kind: 'answer'; answer: unknown } | { kind: 'cancel'; reason: string };

/**
 * What the scripts answer for the browser. Never a path outside `root` (the
 * sandbox's projects folder): a question that names a path gets the first
 * option whose paths are all inside it, and when there is none (or the
 * question itself names a path outside) the creation is cancelled. A spec is
 * approved only when its summary names no path outside `root`; a folder
 * grant only inside it. Permissions are always denied.
 */
export function autoAnswer(
  pending: Pending,
  root: string,
  extra: { summary?: string | null | undefined; style?: Pick<PathEnv, 'pathApi' | 'caseInsensitive'> } = {},
): AutoAnswer {
  const style = extra.style ?? systemPathEnv();
  switch (pending.kind) {
    case 'question': {
      const answers: Record<string, string> = {};
      for (const q of pending.payload.questions) {
        if (!pathsInside(`${q.question} ${q.header}`, root, style)) return { kind: 'cancel', reason: `the question names a folder outside the sandbox: ${q.question}` };
        const text = (option: { label: string; description: string }) => `${option.label} ${option.description}`;
        const namesPath = q.options.some((option) => mentionedPaths(text(option)).length > 0);
        const pick = namesPath
          ? q.options.find((option) => mentionedPaths(text(option)).length > 0 && pathsInside(text(option), root, style))
          : q.options[0];
        if (pick === undefined) return { kind: 'cancel', reason: `no option of "${q.question}" is a folder inside the sandbox` };
        answers[q.question] = pick.label;
      }
      return { kind: 'answer', answer: answers };
    }
    case 'spec':
      if (extra.summary === undefined || extra.summary === null) return { kind: 'cancel', reason: 'the spec summary could not be read' };
      if (!pathsInside(extra.summary, root, style)) return { kind: 'cancel', reason: 'the spec summary names a folder outside the sandbox' };
      return { kind: 'answer', answer: { decision: 'approve' } };
    case 'grant':
      return { kind: 'answer', answer: isPathInside(style.pathApi.resolve(pending.payload.dir), root, style) };
    case 'permission':
      return { kind: 'answer', answer: 'deny' };
  }
}

/** The line the interviewer check asks for at the end of the report. */
export interface InterviewerTarget {
  target: 'claude-code' | 'claude-app';
  rule: string;
}

/**
 * Reads the last `TARGET: <target> | RULE: <cited rule>` line of an
 * interviewer report. Undefined when there is none or the target is not one
 * of the two.
 */
export function parseInterviewerTarget(report: string): InterviewerTarget | undefined {
  const lines = [...report.matchAll(/^\s*`?TARGET:\s*(claude-code|claude-app)\s*\|\s*RULE:\s*(.+?)`?\s*$/gm)];
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  return { target: last[1] as InterviewerTarget['target'], rule: (last[2] ?? '').trim() };
}

/**
 * The files under `root` that are inside none of `allowed`, as paths
 * relative to `root` with forward slashes, sorted. For a before/after
 * comparison of where a session wrote.
 */
export async function filesOutside(root: string, allowed: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  const inside = (target: string) => allowed.some((dir) => target === dir || isPathInside(target, dir, systemPathEnv()));
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (inside(full)) continue;
      if (entry.isDirectory()) await walk(full);
      else found.push(path.relative(root, full).replaceAll('\\', '/'));
    }
  };
  await walk(root);
  return found.sort();
}

const run = (file: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env) =>
  new Promise<string>((resolve) => {
    execFile(file, [...args], { windowsHide: true, timeout: 30_000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env }, (_error, stdout) =>
      resolve(stdout ?? ''),
    );
  });

/**
 * The processes whose command line mentions `text` (with either slash, and
 * ignoring case on Windows), apart from this one. Windows: `Win32_Process`
 * through PowerShell (the text is matched here, not in PowerShell);
 * Linux: `/proc/<pid>/cmdline`; macOS: `ps`.
 */
export async function processesMentioning(text: string): Promise<{ pid: number; command: string }[]> {
  const forms = [...new Set([text, text.replaceAll('\\', '/'), text.replaceAll('/', '\\')])];
  const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const mentions = (command: string) => forms.some((form) => fold(command).includes(fold(form)));
  const listed: { pid: number; command: string }[] = [];
  if (process.platform === 'win32') {
    const out = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
      ],
    );
    for (const line of out.split(/\r?\n/)) {
      const tab = line.indexOf('\t');
      if (tab > 0) listed.push({ pid: Number(line.slice(0, tab)), command: line.slice(tab + 1) });
    }
  } else if (process.platform === 'linux') {
    for (const name of await readdir('/proc').catch(() => [] as string[])) {
      if (!/^\d+$/.test(name)) continue;
      const command = await readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '');
      if (command !== '') listed.push({ pid: Number(name), command: command.replaceAll('\0', ' ') });
    }
  } else {
    for (const line of (await run('ps', ['-axo', 'pid=,command='])).split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match !== null) listed.push({ pid: Number(match[1]), command: match[2] ?? '' });
    }
  }
  return listed.filter((entry) => entry.pid !== process.pid && mentions(entry.command));
}

/** Ends one process at once, without its children: what a crash or Task Manager does to a server. */
export async function hardKill(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(pid), '/F']);
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}
