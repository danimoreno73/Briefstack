import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ARCHIVED_SESSIONS_FILE, isUnfinishedSession, readArchivedSessions, setSessionArchived } from '../../src/events/archived.js';
import { appendEvent, sessionLifecycleEvent } from '../../src/events/index.js';
import { tempDir } from '../helpers.js';

// Archived creations (IDEAS §3; phase 9, step 33): a choice kept in the home, never in the session's folder.

let dir: string;
let cleanup: () => Promise<void>;
let home: string;
let sessionsDir: string;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('sessions-archived'));
  home = path.join(dir, 'home');
  sessionsDir = path.join(home, 'sessions');
  await appendEvent(sessionsDir, sessionLifecycleEvent('sess-a', 'started', undefined, new Date('2026-11-01T08:00:00Z')));
  await appendEvent(sessionsDir, sessionLifecycleEvent('sess-a', 'finished', 'cancelled', new Date('2026-11-01T08:05:00Z')));
  await appendEvent(sessionsDir, sessionLifecycleEvent('sess-b', 'started', undefined, new Date('2026-11-01T09:00:00Z')));
  await appendEvent(sessionsDir, sessionLifecycleEvent('sess-b', 'finished', 'completed', new Date('2026-11-01T09:05:00Z')));
});
afterEach(() => cleanup());

describe('archived creations', () => {
  it('only an interrupted or cancelled creation counts as unfinished', () => {
    expect(isUnfinishedSession({ status: 'interrupted' })).toBe(true);
    expect(isUnfinishedSession({ status: 'finished', outcome: 'cancelled' })).toBe(true);
    expect(isUnfinishedSession({ status: 'finished', outcome: 'completed' })).toBe(false);
    expect(isUnfinishedSession({ status: 'in-progress' })).toBe(false);
  });

  it('archives and restores, in the home only; a second archive keeps the first time', async () => {
    const before = await readFile(path.join(sessionsDir, 'sess-a', 'events.jsonl'), 'utf8');
    const first = await setSessionArchived({ home, sessionsDir, id: 'sess-a', archived: true, now: new Date('2026-11-02T00:00:00Z') });
    expect(first).toEqual({ id: 'sess-a', archived: '2026-11-02T00:00:00.000Z' });
    expect(await setSessionArchived({ home, sessionsDir, id: 'sess-a', archived: true, now: new Date('2026-11-03T00:00:00Z') })).toEqual(first);
    expect(await readArchivedSessions(home)).toEqual({ 'sess-a': '2026-11-02T00:00:00.000Z' });
    expect(await readFile(path.join(sessionsDir, 'sess-a', 'events.jsonl'), 'utf8')).toBe(before);
    expect(await setSessionArchived({ home, sessionsDir, id: 'sess-a', archived: false })).toEqual({ id: 'sess-a' });
    expect(await readArchivedSessions(home)).toEqual({});
  });

  it('refuses a finished creation, a missing one and an id that is not one', async () => {
    await expect(setSessionArchived({ home, sessionsDir, id: 'sess-b', archived: true })).rejects.toMatchObject({ code: 'sessions.notUnfinished' });
    await expect(setSessionArchived({ home, sessionsDir, id: 'sess-zz', archived: true })).rejects.toMatchObject({ code: 'events.sessionNotFound' });
    await expect(setSessionArchived({ home, sessionsDir, id: '../x', archived: true })).rejects.toMatchObject({ code: 'events.sessionNotFound' });
  });

  it('a file that does not read back is read as none and never overwritten', async () => {
    await writeFile(path.join(home, ARCHIVED_SESSIONS_FILE), '{ not json', 'utf8');
    expect(await readArchivedSessions(home)).toEqual({});
    await expect(setSessionArchived({ home, sessionsDir, id: 'sess-a', archived: true })).rejects.toMatchObject({ code: 'sessions.archiveUnreadable' });
    expect(await readFile(path.join(home, ARCHIVED_SESSIONS_FILE), 'utf8')).toBe('{ not json');
  });

  it('an id such as constructor is never taken for an inherited value (review of step 33, C, M6)', async () => {
    await appendEvent(sessionsDir, sessionLifecycleEvent('constructor', 'started', undefined, new Date('2026-11-01T10:00:00Z')));
    await appendEvent(sessionsDir, sessionLifecycleEvent('constructor', 'finished', 'cancelled', new Date('2026-11-01T10:05:00Z')));
    expect((await readArchivedSessions(home)).constructor).toBeUndefined();
    expect(await setSessionArchived({ home, sessionsDir, id: 'constructor', archived: true, now: new Date('2026-11-02T00:00:00Z') })).toEqual({ id: 'constructor', archived: '2026-11-02T00:00:00.000Z' });
    expect((await readArchivedSessions(home)).constructor).toBe('2026-11-02T00:00:00.000Z');
  });

  it('two changes at once both land', async () => {
    await appendEvent(sessionsDir, sessionLifecycleEvent('sess-c', 'started', undefined, new Date('2026-11-01T10:00:00Z')));
    await appendEvent(sessionsDir, sessionLifecycleEvent('sess-c', 'finished', 'cancelled', new Date('2026-11-01T10:05:00Z')));
    await Promise.all([setSessionArchived({ home, sessionsDir, id: 'sess-a', archived: true }), setSessionArchived({ home, sessionsDir, id: 'sess-c', archived: true })]);
    expect(Object.keys(await readArchivedSessions(home)).sort()).toEqual(['sess-a', 'sess-c']);
  });
});
