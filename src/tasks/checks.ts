import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { killProcessTree } from '../creation/processTree.js';
import { BriefstackError } from '../errors.js';
import { gitCommit } from '../library/git.js';
import { noteRelativePath, toNative } from '../library/layout.js';
import { withLibraryLock } from '../library/lock.js';
import { assertLibrary, readTextIfExists } from '../library/notes.js';
import { hideAbsolutePaths } from '../panel/project.js';
import { SLUG_RE } from '../spec/schema.js';
import { redactSecretLines } from '../validate/secrets.js';
import { offlineEnv } from '../improve/verify.js';
import type { CheckResult } from './types.js';

/**
 * Declared checks (BRIEF-phase-7 §3.4): the commands a project's note lists
 * in a fenced block, one per line, which the server runs in a task's
 * worktree after each round:
 *
 *     ## Checks
 *
 *     ```briefstack-checks
 *     npm ci --offline
 *     npm test
 *     ```
 *
 * The note shows them in the library; the server runs a command only when
 * the user confirmed that exact command on the project page, recorded in
 * `<home>/checks/<slug>.json`. A command that reached the note another way
 * (a hand edit, a model writing the note) is listed as not confirmed and
 * never runs until the user confirms it.
 */

export const CHECKS_FENCE = 'briefstack-checks';
export const CHECKS_HEADING = '## Checks';
export const MAX_CHECKS = 10;
export const MAX_CHECK_LENGTH = 500;
/** Each check gets this long before its process tree is ended. */
export const CHECK_TIMEOUT_MS = 10 * 60_000;
/** The output kept of each check: its end, redacted. */
const MAX_OUTPUT_CHARS = 16 * 1024;

const BLOCK_RE = new RegExp(String.raw`^(\`{3,})${CHECKS_FENCE}[ \t]*\r?\n([\s\S]*?)^\1[ \t]*$`, 'm');

/** The commands of a note's checks block, in order; none without a block. */
export function readChecks(note: string): string[] {
  const block = BLOCK_RE.exec(note);
  if (block === null) return [];
  return (block[2] ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Why a command cannot be a check, or `undefined`. */
export function checkCommandProblem(command: string): string | undefined {
  if (command.trim() === '') return 'empty';
  if (command !== command.trim()) return 'spaces at the start or end';
  if (/[\r\n\0]/.test(command)) return 'more than one line';
  if (command.length > MAX_CHECK_LENGTH) return `longer than ${MAX_CHECK_LENGTH} characters`;
  if (command.includes('```')) return 'a code fence';
  return undefined;
}

/** The note with its checks block replaced by `commands` (a new section at the end when there was none; removed when empty). */
export function writeChecks(note: string, commands: readonly string[]): string {
  const block = commands.length === 0 ? '' : `\`\`\`${CHECKS_FENCE}\n${commands.join('\n')}\n\`\`\``;
  const found = BLOCK_RE.exec(note);
  if (found !== null) {
    const before = note.slice(0, found.index);
    const after = note.slice(found.index + found[0].length);
    if (block !== '') return `${before}${block}${after}`;
    // No commands: the block goes, and its heading too when nothing else is under it.
    const trimmed = before.replace(new RegExp(`${CHECKS_HEADING}\\s*$`), '');
    return `${trimmed.trimEnd()}\n${after.replace(/^\r?\n/, '')}`.replace(/\n{3,}/g, '\n\n');
  }
  if (block === '') return note;
  return `${note.trimEnd()}\n\n${CHECKS_HEADING}\n\n${block}\n`;
}

const hashOf = (command: string): string => createHash('sha256').update(command, 'utf8').digest('hex');

interface Confirmations {
  v: 1;
  confirmed: { hash: string; at: string }[];
}

export const checksFile = (home: string, slug: string): string => path.join(home, 'checks', `${slug}.json`);

async function readConfirmations(home: string, slug: string): Promise<Confirmations> {
  try {
    const data = JSON.parse(await readFile(checksFile(home, slug), 'utf8')) as Partial<Confirmations>;
    if (data.v === 1 && Array.isArray(data.confirmed)) return { v: 1, confirmed: data.confirmed.filter((item) => typeof item?.hash === 'string' && typeof item.at === 'string') };
  } catch {
    // None yet, or unreadable: nothing is confirmed.
  }
  return { v: 1, confirmed: [] };
}

async function writeConfirmations(home: string, slug: string, data: Confirmations): Promise<void> {
  const file = checksFile(home, slug);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

export interface ProjectCheck {
  command: string;
  /** The user confirmed this exact command on the project page: only these run. */
  confirmed: boolean;
}

/** A project's checks as its note lists them, each with whether the user confirmed it. */
export async function projectChecks(options: { libraryDir: string; home: string; slug: string }): Promise<ProjectCheck[]> {
  if (!SLUG_RE.test(options.slug)) throw new BriefstackError('task.projectNotFound', { project: options.slug });
  const note = await readTextIfExists(toNative(options.libraryDir, noteRelativePath('projects', options.slug)));
  if (note === undefined) throw new BriefstackError('task.projectNotFound', { project: options.slug });
  const confirmed = new Set((await readConfirmations(options.home, options.slug)).confirmed.map((item) => item.hash));
  return readChecks(note).map((command) => ({ command, confirmed: confirmed.has(hashOf(command)) }));
}

/**
 * Sets a project's checks after the user confirmed the list on the project
 * page: the note's block is rewritten and committed through the library's
 * queue, and each command is recorded as confirmed.
 */
export async function setProjectChecks(options: { libraryDir: string; home: string; slug: string; commands: readonly string[]; now?: Date }): Promise<ProjectCheck[]> {
  const { libraryDir, home, slug } = options;
  if (!SLUG_RE.test(slug)) throw new BriefstackError('task.projectNotFound', { project: slug });
  const commands = [...options.commands];
  if (commands.length > MAX_CHECKS) throw new BriefstackError('task.invalidCheck', { command: '', problem: `more than ${MAX_CHECKS} checks` });
  for (const command of commands) {
    const problem = checkCommandProblem(command);
    if (problem !== undefined) throw new BriefstackError('task.invalidCheck', { command: redactSecretLines(command).slice(0, 100), problem });
  }
  if (new Set(commands).size !== commands.length) throw new BriefstackError('task.invalidCheck', { command: '', problem: 'the same command twice' });
  await assertLibrary(libraryDir);
  const relative = noteRelativePath('projects', slug);
  await withLibraryLock(libraryDir, async () => {
    const file = toNative(libraryDir, relative);
    const text = await readTextIfExists(file);
    if (text === undefined) throw new BriefstackError('task.projectNotFound', { project: slug });
    const next = writeChecks(text, commands);
    if (next !== text) {
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, next, 'utf8');
      await rename(temp, file);
      await gitCommit(libraryDir, [relative], `library: checks of projects/${slug}`);
    }
  });
  const at = (options.now ?? new Date()).toISOString();
  await writeConfirmations(home, slug, { v: 1, confirmed: commands.map((command) => ({ hash: hashOf(command), at })) });
  return commands.map((command) => ({ command, confirmed: true }));
}

/** Text the page may show of a check's output: the end, secrets hidden, the worktree as `.`, other absolute paths hidden. */
export function cleanOutput(output: string, worktree: string): string {
  const relative = output.split(worktree).join('.').split(worktree.split(path.sep).join('/')).join('.');
  return hideAbsolutePaths(redactSecretLines(relative.slice(-MAX_OUTPUT_CHARS)));
}

/** The environment of a check: no network, no credentials of the user's Claude Code, no briefstack variables. */
export function checkEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = offlineEnv(source);
  for (const name of Object.keys(env)) {
    if (/^(BRIEFSTACK_|GIT_DIR$|GIT_WORK_TREE$|GIT_INDEX_FILE$)/.test(name)) delete env[name];
  }
  return env;
}

export interface RunChecksOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

function runOne(cwd: string, command: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ exitCode: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve) => {
    // A fixed shell: cmd on Windows (npm is a .cmd there), sh elsewhere, in its own group so the whole tree can be ended.
    const child =
      process.platform === 'win32'
        ? // As Node's own `shell: true`: the whole line quoted once, `/s` takes the quotes off, the rest is cmd's.
          spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true })
        : spawn('sh', ['-c', command], { cwd, env, detached: true });
    let output = '';
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-4 * MAX_OUTPUT_CHARS);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.stdin?.end();
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) void killProcessTree(child.pid).catch(() => child.kill());
      else child.kill();
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut, output: `${output}\n${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : code, timedOut, output });
    });
  });
}

/** Runs the commands one after the other in the worktree, each with its timeout, and keeps every result. */
export async function runChecks(worktree: string, commands: readonly string[], options: RunChecksOptions = {}): Promise<CheckResult[]> {
  const env = options.env ?? checkEnv(process.env);
  const now = options.now ?? Date.now;
  const results: CheckResult[] = [];
  for (const command of commands) {
    const started = now();
    const run = await runOne(worktree, command, env, options.timeoutMs ?? CHECK_TIMEOUT_MS);
    results.push({ command, exitCode: run.exitCode, timedOut: run.timedOut, output: cleanOutput(run.output, worktree), durationMs: Math.max(0, Math.round(now() - started)) });
  }
  return results;
}
