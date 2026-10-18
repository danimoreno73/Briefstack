import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { appendEvent, isSessionId, readEvents, sessionEndEvent, sessionEventsFile, summarizeSession } from '../events/index.js';

/**
 * Run files: one folder per creation whose `claude` is running,
 * `<home>/runs/<creation id>/` (docs/decisions.md, "If `briefstack web`
 * crashes", proposal 2).
 *
 * `run.json` names the `claude` process (pid and start time) and the
 * server that started it. The runner writes it once the process exists and
 * removes the folder when the run ends. When the server dies without
 * removing it, the next `briefstack web` finds it before it serves
 * anything: if the server that wrote it is gone and the process is still
 * the same one (same pid and the same start time, so a reused pid is never
 * touched), it ends that process tree, closes the session as interrupted
 * and removes the folder.
 *
 * The folder is under the briefstack home, outside every folder a creation
 * may write to, so a session cannot change it.
 */

export const RUNS_DIR = 'runs';
const RUN_FILE = 'run.json';

/** `session.end` reason the sweep writes for a session whose server died with it open. */
export const SERVER_CRASH_REASON = 'server_crash';

export function runsDirOf(home: string): string {
  return path.join(home, RUNS_DIR);
}

/** `<runsDir>/<creationId>`; the id must be usable as a folder name. */
export function runDirOf(runsDir: string, creationId: string): string {
  if (!isSessionId(creationId)) throw new Error(`not a creation id: ${creationId}`);
  return path.join(runsDir, creationId);
}

const processSchema = z.object({ pid: z.number().int().positive(), start: z.string() }).strict();

const runSchema = z
  .object({
    v: z.literal(1),
    creationId: z.string(),
    /** The `claude` process; `start` is empty when it could not be read. */
    claude: processSchema,
    /** The `briefstack web` process that started it. */
    server: processSchema,
    sessionId: z.string().optional(),
    startedAt: z.string(),
  })
  .strict();

export type RunRecord = z.infer<typeof runSchema>;

/** Writes `run.json` whole: to a temp file first, then renamed over the old one. */
export async function writeRunRecord(runsDir: string, record: RunRecord): Promise<void> {
  const dir = runDirOf(runsDir, record.creationId);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, RUN_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

export async function removeRun(runsDir: string, creationId: string): Promise<void> {
  await rm(runDirOf(runsDir, creationId), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** The start time of a process, as a string that is the same every time it is read, or `undefined`. */
export type StartTimeReader = (pid: number) => Promise<string | undefined>;

type ExecFileText = (file: string, args: readonly string[]) => Promise<string>;

const execText: ExecFileText = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { windowsHide: true, timeout: 15_000, encoding: 'utf8' }, (error, stdout) =>
      error === null ? resolve(stdout) : reject(error),
    );
  });

/**
 * Reads a process's start time. Windows: PowerShell's `Get-Process`; Linux:
 * field 22 of `/proc/<pid>/stat` (clock ticks since boot); macOS:
 * `ps -o lstart=`. Never throws: a process that is gone, or a reading that
 * fails, gives `undefined`.
 */
export async function processStartTime(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  deps: { exec?: ExecFileText; read?: (file: string) => Promise<string> } = {},
): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const exec = deps.exec ?? execText;
  try {
    if (platform === 'win32') {
      const out = await exec('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ]);
      return nonEmpty(out);
    }
    if (platform === 'linux') {
      const stat = await (deps.read ?? ((file) => readFile(file, 'utf8')))(`/proc/${pid}/stat`);
      // The command name, in parentheses, may hold spaces: count the fields after its closing one.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = fields[19];
      return ticks === undefined || !/^\d+$/.test(ticks) ? undefined : `ticks:${ticks}`;
    }
    return nonEmpty(await exec('ps', ['-o', 'lstart=', '-p', String(pid)]));
  } catch {
    return undefined;
  }
}

const nonEmpty = (text: string): string | undefined => {
  const trimmed = text.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** Whether a process with this pid exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** What the sweep did with one run folder. */
export interface SweepEntry {
  creationId: string;
  /**
   * `killed`: its `claude` was still running and was ended; `gone`: nothing
   * of it was running; `unverified`: a process with its pid runs, but its
   * start time could not be compared, so it was left alone; `live`: the
   * server that wrote it still runs, so it was not touched; `invalid`: the
   * folder held no valid `run.json`.
   */
  action: 'killed' | 'gone' | 'unverified' | 'live' | 'invalid';
  pid?: number;
  /** Set when the sweep closed the session as interrupted. */
  closedSession?: string;
}

export interface SweepOptions {
  runsDir: string;
  sessionsDir: string;
  startTime?: StartTimeReader;
  alive?: (pid: number) => boolean;
  /** Ends a process tree. */
  kill: (pid: number) => Promise<void>;
  now?: () => Date;
}

/** Whether `proc` is still the process the record names. */
async function sameProcess(proc: { pid: number; start: string }, alive: (pid: number) => boolean, startTime: StartTimeReader) {
  if (!alive(proc.pid)) return 'gone' as const;
  if (proc.start === '') return 'unknown' as const;
  const now = await startTime(proc.pid);
  if (now === undefined) return 'unknown' as const;
  return now === proc.start ? ('same' as const) : ('gone' as const);
}

/**
 * Cleans up after a server that died with creations running. Run by
 * `briefstack web` before it serves anything, so no new creation starts
 * while an old one may still be writing.
 */
export async function sweepRuns(options: SweepOptions): Promise<SweepEntry[]> {
  const alive = options.alive ?? processAlive;
  const startTime = options.startTime ?? ((pid) => processStartTime(pid));
  let names: string[];
  try {
    names = await readdir(options.runsDir);
  } catch {
    return [];
  }
  const entries: SweepEntry[] = [];
  for (const name of names) {
    if (!isSessionId(name)) continue;
    const dir = path.join(options.runsDir, name);
    let record: RunRecord | undefined;
    try {
      const parsed = runSchema.safeParse(JSON.parse(await readFile(path.join(dir, RUN_FILE), 'utf8')));
      if (parsed.success && parsed.data.creationId === name) record = parsed.data;
    } catch {
      // Missing or not JSON: invalid.
    }
    if (record === undefined) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      entries.push({ creationId: name, action: 'invalid' });
      continue;
    }
    // Another briefstack web on the same home owns it: leave it to that one.
    if ((await sameProcess(record.server, alive, startTime)) !== 'gone') {
      entries.push({ creationId: name, action: 'live', pid: record.claude.pid });
      continue;
    }
    const claude = await sameProcess(record.claude, alive, startTime);
    const entry: SweepEntry = {
      creationId: name,
      action: claude === 'same' ? 'killed' : claude === 'unknown' ? 'unverified' : 'gone',
      pid: record.claude.pid,
    };
    if (claude === 'same') await options.kill(record.claude.pid);
    if (record.sessionId !== undefined && isSessionId(record.sessionId)) {
      const file = sessionEventsFile(options.sessionsDir, record.sessionId);
      const { events } = await readEvents(file).catch(() => ({ events: [] }));
      const summary = summarizeSession(events, options.now === undefined ? {} : { now: options.now() });
      // Only a session that exists and is still open: a finished one keeps its outcome, an ended one its reason.
      if (events.length > 0 && summary.status !== 'finished' && summary.endReason === undefined) {
        await appendEvent(options.sessionsDir, sessionEndEvent(record.sessionId, SERVER_CRASH_REASON, options.now?.() ?? new Date()));
        entry.closedSession = record.sessionId;
      }
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    entries.push(entry);
  }
  return entries;
}
