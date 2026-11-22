import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BriefstackError } from '../errors.js';
import { isSessionId, type SessionSummary } from './index.js';
import { listSessions } from './sessions.js';

/**
 * Archived creations (IDEAS §3, "Projects: Archive an interrupted or
 * cancelled creation"; phase 9, step 33). The user hides an unfinished
 * creation from the Projects page without deleting anything: the choice is
 * kept in `<home>/archived-sessions.json` (`{ v: 1, sessions: { <id>:
 * <when> } }`), never in the session's own folder, which only the session
 * writes. Only an interrupted or cancelled creation can be archived.
 */

export const ARCHIVED_SESSIONS_FILE = 'archived-sessions.json';
/** How many archived sessions the file keeps; the oldest choices go first past it. */
const MAX_ARCHIVED = 2000;

const archivedSchema = z.object({ v: z.literal(1), sessions: z.record(z.string(), z.string()) });

/** Whether a creation is unfinished as the Projects page counts it: interrupted, or cancelled. */
export function isUnfinishedSession(session: Pick<SessionSummary, 'status' | 'outcome'>): boolean {
  return session.status === 'interrupted' || session.outcome === 'cancelled';
}

const fileOf = (home: string): string => path.join(home, ARCHIVED_SESSIONS_FILE);

/**
 * The archived sessions, id to when. A missing file is none; a file that
 * does not read back is none too here, and refused for writing
 * (`sessions.archiveUnreadable`), so a hand-edited file is never overwritten.
 */
export async function readArchivedSessions(home: string): Promise<Record<string, string>> {
  return (await readFileState(home)).sessions;
}

async function readFileState(home: string): Promise<{ sessions: Record<string, string>; readable: boolean }> {
  let text: string;
  try {
    text = await readFile(fileOf(home), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: {}, readable: true };
    return { sessions: {}, readable: false };
  }
  try {
    const parsed = archivedSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { sessions: {}, readable: false };
    return { sessions: Object.fromEntries(Object.entries(parsed.data.sessions).filter(([id]) => isSessionId(id))), readable: true };
  } catch {
    return { sessions: {}, readable: false };
  }
}

/**
 * Archives or restores one creation. Archiving needs an interrupted or
 * cancelled creation on disk (`sessions.notUnfinished` otherwise);
 * restoring needs nothing but a valid id. Returns when it was archived, or
 * `undefined` once restored.
 */
export function setSessionArchived(params: { home: string; sessionsDir: string; id: string; archived: boolean; now?: Date }): Promise<{ id: string; archived?: string }> {
  // One change at a time in this process, so two clicks never lose one another's choice.
  const run = writing.then(() => setNow(params));
  writing = run.catch(() => undefined);
  return run;
}

let writing: Promise<unknown> = Promise.resolve();

async function setNow(params: { home: string; sessionsDir: string; id: string; archived: boolean; now?: Date }): Promise<{ id: string; archived?: string }> {
  const { home, sessionsDir, id, archived } = params;
  if (!isSessionId(id)) throw new BriefstackError('events.sessionNotFound', { session: id });
  const state = await readFileState(home);
  if (!state.readable) throw new BriefstackError('sessions.archiveUnreadable', { file: ARCHIVED_SESSIONS_FILE });
  const sessions = { ...state.sessions };
  if (archived) {
    const session = (await listSessions(sessionsDir)).find((item) => item.id === id);
    if (session === undefined) throw new BriefstackError('events.sessionNotFound', { session: id });
    if (!isUnfinishedSession(session)) throw new BriefstackError('sessions.notUnfinished', { session: id });
    sessions[id] ??= (params.now ?? new Date()).toISOString();
  } else {
    delete sessions[id];
  }
  // The newest choices are kept when the file is full.
  const kept = Object.entries(sessions)
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .slice(0, MAX_ARCHIVED);
  await mkdir(home, { recursive: true });
  const target = fileOf(home);
  const temp = `${target}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify({ v: 1, sessions: Object.fromEntries(kept) }, null, 2)}\n`, 'utf8');
  await rename(temp, target);
  const at = sessions[id];
  return at === undefined ? { id } : { id, archived: at };
}
