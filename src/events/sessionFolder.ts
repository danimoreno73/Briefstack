import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EVENTS_FILE, STALE_AFTER_MINUTES, isSessionId, readEvents, summarizeSession } from './index.js';

/**
 * The output folder a creation session chose, as `paths check --session`
 * last checked it (backlog 2, B9): `<sessionsDir>/<session>/folder.json`.
 * Only the briefstack home holds it: never `events.jsonl`, whose lines reach
 * the panel and the chat, and never the repo.
 *
 * The web server reads it for the sessions it does not run (a creation
 * started from the terminal, or by another server) and treats the folder of
 * each one in progress as taken. The terminal flow is refused nothing.
 */

export const SESSION_FOLDER_FILE = 'folder.json';
const FOLDER_FORMAT = 1;
/** A bigger file is not one this module wrote. */
const MAX_FILE_BYTES = 16 * 1024;

export interface SessionFolder {
  dir: string;
  at: string;
}

/** Records `dir` (absolute) as the session's output folder; a new record replaces the last one. Written aside and renamed. */
export async function recordSessionFolder(sessionsDir: string, session: string, dir: string, now: Date = new Date()): Promise<void> {
  if (!isSessionId(session) || !path.isAbsolute(dir)) return;
  const folder = path.join(sessionsDir, session);
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, SESSION_FOLDER_FILE);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ v: FOLDER_FORMAT, dir: path.resolve(dir), at: now.toISOString() }, null, 2)}\n`, 'utf8');
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The session's recorded folder; `undefined` when there is none or the file is damaged. */
export async function readSessionFolder(sessionsDir: string, session: string): Promise<SessionFolder | undefined> {
  if (!isSessionId(session)) return undefined;
  const file = path.join(sessionsDir, session, SESSION_FOLDER_FILE);
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<SessionFolder> & { v?: unknown };
    if (parsed.v !== FOLDER_FORMAT || typeof parsed.dir !== 'string' || !path.isAbsolute(parsed.dir) || typeof parsed.at !== 'string') return undefined;
    return { dir: parsed.dir, at: parsed.at };
  } catch {
    return undefined;
  }
}

export interface FoldersInProgressOptions {
  /** Sessions the caller runs itself: its own claims cover them. */
  skip?: ReadonlySet<string>;
  now?: Date;
  staleAfterMinutes?: number;
}

/**
 * The recorded folder of every session in progress (the rule of
 * `summarizeSession`: started, not finished, no `session.end` after its last
 * activity, and an event within `staleAfterMinutes`). A session whose
 * `events.jsonl` was not written for that long is skipped without reading it.
 */
export async function sessionFoldersInProgress(sessionsDir: string, options: FoldersInProgressOptions = {}): Promise<{ session: string; dir: string }[]> {
  const now = options.now ?? new Date();
  const staleAfterMinutes = options.staleAfterMinutes ?? STALE_AFTER_MINUTES;
  let entries;
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: { session: string; dir: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSessionId(entry.name) || options.skip?.has(entry.name) === true) continue;
    const folder = await readSessionFolder(sessionsDir, entry.name);
    if (folder === undefined) continue;
    const eventsFile = path.join(sessionsDir, entry.name, EVENTS_FILE);
    try {
      if (now.getTime() - (await stat(eventsFile)).mtimeMs > staleAfterMinutes * 60_000) continue;
    } catch {
      continue;
    }
    const { events } = await readEvents(eventsFile);
    if (summarizeSession(events, { now, staleAfterMinutes }).status === 'in-progress') found.push({ session: entry.name, dir: folder.dir });
  }
  return found;
}
