import { mkdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, flowEvent, sessionLifecycleEvent } from '../../src/events/index.js';
import { SESSION_FOLDER_FILE, readSessionFolder, recordSessionFolder, sessionFoldersInProgress } from '../../src/events/sessionFolder.js';
import { sessionEndEvent } from '../../src/events/sessions.js';
import { tempDir } from '../helpers.js';

const NOW = new Date('2026-10-26T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe('session folder records', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let sessionsDir: string;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('session-folder'));
    sessionsDir = path.join(dir, 'sessions');
  });
  afterEach(() => cleanup());

  const folder = (name: string) => path.join(dir, 'projects', name);

  /** A session that started `minutes` ago and was last active then, with its folder recorded. */
  async function session(id: string, minutes: number, extra: 'finished' | 'ended' | 'none' = 'none'): Promise<void> {
    await appendEvent(sessionsDir, sessionLifecycleEvent(id, 'started', undefined, minutesAgo(minutes)));
    await appendEvent(sessionsDir, flowEvent(id, 'interview', 'started', undefined, minutesAgo(minutes)));
    if (extra === 'finished') await appendEvent(sessionsDir, sessionLifecycleEvent(id, 'finished', 'completed', minutesAgo(minutes)));
    if (extra === 'ended') await appendEvent(sessionsDir, sessionEndEvent(id, 'other', minutesAgo(minutes)));
    await recordSessionFolder(sessionsDir, id, folder(id), minutesAgo(minutes));
    // The file's time is what a skipped stale session is judged by.
    const time = minutesAgo(minutes);
    await utimes(path.join(sessionsDir, id, 'events.jsonl'), time, time);
  }

  it('records the folder aside and renamed, and reads it back; a new record replaces it', async () => {
    await recordSessionFolder(sessionsDir, 's1', folder('garden'), NOW);
    expect(await readSessionFolder(sessionsDir, 's1')).toEqual({ dir: folder('garden'), at: NOW.toISOString() });
    await recordSessionFolder(sessionsDir, 's1', folder('orchard'), NOW);
    expect(await readSessionFolder(sessionsDir, 's1')).toMatchObject({ dir: folder('orchard') });
  });

  it('writes nothing for an invalid session id or a relative folder', async () => {
    await recordSessionFolder(sessionsDir, '../escape', folder('x'));
    await recordSessionFolder(sessionsDir, 's2', 'relative/x');
    expect(await readSessionFolder(sessionsDir, '../escape')).toBeUndefined();
    expect(await readSessionFolder(sessionsDir, 's2')).toBeUndefined();
  });

  it('ignores a damaged, foreign or relative record', async () => {
    await mkdir(path.join(sessionsDir, 's3'), { recursive: true });
    const file = path.join(sessionsDir, 's3', SESSION_FOLDER_FILE);
    for (const text of ['{not json', '[]', JSON.stringify({ v: 2, dir: folder('x'), at: 'now' }), JSON.stringify({ v: 1, dir: 'relative', at: 'now' }), JSON.stringify({ v: 1, dir: folder('x') })]) {
      await writeFile(file, text, 'utf8');
      expect(await readSessionFolder(sessionsDir, 's3'), text).toBeUndefined();
    }
    await writeFile(file, 'x'.repeat(20_000), 'utf8');
    expect(await readSessionFolder(sessionsDir, 's3')).toBeUndefined();
  });

  it('lists the folders of sessions in progress only: not stale, finished, ended or skipped ones', async () => {
    await session('live', 5);
    await session('stale', 180);
    await session('done', 5, 'finished');
    await session('ended', 5, 'ended');
    await session('mine', 5);
    // A session in progress with no record names no folder.
    await appendEvent(sessionsDir, sessionLifecycleEvent('quiet', 'started', undefined, minutesAgo(5)));
    const found = await sessionFoldersInProgress(sessionsDir, { skip: new Set(['mine']), now: NOW });
    expect(found).toEqual([{ session: 'live', dir: folder('live') }]);
  });

  it('finds nothing when there is no sessions folder', async () => {
    expect(await sessionFoldersInProgress(path.join(dir, 'missing'), { now: NOW })).toEqual([]);
  });
});
