import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SERVER_CRASH_REASON,
  processStartTime,
  removeRun,
  runDirOf,
  sweepRuns,
  writeRunRecord,
  type RunRecord,
} from '../../src/creation/runFiles.js';
import { appendEvent, readEvents, sessionEndEvent, sessionEventsFile, sessionLifecycleEvent } from '../../src/events/index.js';
import { tempDir } from '../helpers.js';

const CREATION = '0b0e4c1a-1111-4a5b-9c8d-123456789abc';
const SESSION = '3f2b9c1e-0000-4a5b-9c8d-123456789abc';

describe('processStartTime', () => {
  it('asks PowerShell on Windows, reads /proc on Linux and ps on macOS', async () => {
    const calls: [string, readonly string[]][] = [];
    const exec = async (file: string, args: readonly string[]) => {
      calls.push([file, args]);
      return ' 2026-10-18T10:00:00.1234567Z\r\n';
    };
    expect(await processStartTime(42, 'win32', { exec })).toBe('2026-10-18T10:00:00.1234567Z');
    expect(calls[0]?.[0]).toBe('powershell.exe');
    expect(calls[0]?.[1].at(-1)).toContain('Get-Process -Id 42');
    // The command name may hold spaces and parentheses; the start time is field 22.
    const stat = `42 (my (odd) name) S 1 42 42 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10 18446744073709551615`;
    expect(await processStartTime(42, 'linux', { read: async () => stat })).toBe('ticks:987654');
    expect(await processStartTime(42, 'darwin', { exec })).toBe('2026-10-18T10:00:00.1234567Z');
    expect(calls[1]).toEqual(['ps', ['-o', 'lstart=', '-p', '42']]);
  });

  it('gives undefined for a process that is gone, a failed reading or a pid that is not one', async () => {
    const fail = async () => {
      throw new Error('no such process');
    };
    expect(await processStartTime(42, 'win32', { exec: fail })).toBeUndefined();
    expect(await processStartTime(42, 'linux', { read: fail })).toBeUndefined();
    expect(await processStartTime(42, 'win32', { exec: async () => '  ' })).toBeUndefined();
    expect(await processStartTime(0, 'win32', { exec: async () => 'x' })).toBeUndefined();
  });

  it('reads the same value twice for this process', async () => {
    const first = await processStartTime(process.pid);
    expect(first).toBeDefined();
    expect(await processStartTime(process.pid)).toBe(first);
  }, 30_000);
});

describe('run files and the sweep', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let runsDir: string;
  let sessionsDir: string;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('run-files'));
    runsDir = path.join(dir, 'home', 'runs');
    sessionsDir = path.join(dir, 'home', 'sessions');
  });
  afterEach(() => cleanup());

  const record = (extra: Partial<RunRecord> = {}): RunRecord => ({
    v: 1,
    creationId: CREATION,
    claude: { pid: 100, start: 'claude-start' },
    server: { pid: 200, start: 'server-start' },
    sessionId: SESSION,
    startedAt: '2026-10-18T10:00:00.000Z',
    ...extra,
  });
  const openSession = () => appendEvent(sessionsDir, sessionLifecycleEvent(SESSION, 'started'));
  const kills: number[] = [];
  const sweep = (running: Record<number, string | undefined>) =>
    sweepRuns({
      runsDir,
      sessionsDir,
      alive: (pid) => pid in running,
      startTime: async (pid) => running[pid],
      kill: async (pid) => void kills.push(pid),
    });
  const runs = () => readdir(runsDir).catch(() => [] as string[]);
  const endReasons = async () =>
    (await readEvents(sessionEventsFile(sessionsDir, SESSION))).events.flatMap((event) =>
      event.source === 'hook' && event.type === 'session.end' ? [event.reason] : [],
    );

  beforeEach(() => {
    kills.length = 0;
  });

  it('writes the record whole and removes the folder', async () => {
    await writeRunRecord(runsDir, record());
    expect(JSON.parse(await readFile(path.join(runDirOf(runsDir, CREATION), 'run.json'), 'utf8'))).toEqual(record());
    await removeRun(runsDir, CREATION);
    expect(await runs()).toEqual([]);
    expect(() => runDirOf(runsDir, '../x')).toThrow();
  });

  it('ends a claude its dead server left running, closes the open session as interrupted and removes the folder', async () => {
    await openSession();
    await writeRunRecord(runsDir, record());
    expect(await sweep({ 100: 'claude-start' })).toEqual([{ creationId: CREATION, action: 'killed', pid: 100, closedSession: SESSION }]);
    expect(kills).toEqual([100]);
    expect(await endReasons()).toEqual([SERVER_CRASH_REASON]);
    expect(await runs()).toEqual([]);
  });

  it('never ends a process that only has the same pid', async () => {
    await openSession();
    await writeRunRecord(runsDir, record());
    expect((await sweep({ 100: 'another-start' }))[0]?.action).toBe('gone');
    expect(kills).toEqual([]);
    expect(await endReasons()).toEqual([SERVER_CRASH_REASON]);
  });

  it('leaves alone a process whose start time cannot be read, or whose record has none', async () => {
    await writeRunRecord(runsDir, record());
    expect((await sweep({ 100: undefined }))[0]?.action).toBe('unverified');
    await writeRunRecord(runsDir, record({ claude: { pid: 100, start: '' } }));
    expect((await sweep({ 100: 'claude-start' }))[0]?.action).toBe('unverified');
    expect(kills).toEqual([]);
  });

  it('does not touch the creations of a server that still runs', async () => {
    await openSession();
    await writeRunRecord(runsDir, record());
    expect(await sweep({ 100: 'claude-start', 200: 'server-start' })).toEqual([{ creationId: CREATION, action: 'live', pid: 100 }]);
    expect(kills).toEqual([]);
    expect(await endReasons()).toEqual([]);
    expect(await runs()).toEqual([CREATION]);
    // A server whose start time cannot be read may still be that one: also left alone.
    expect((await sweep({ 200: undefined }))[0]?.action).toBe('live');
  });

  it('keeps the outcome of a finished session and the reason of an ended one', async () => {
    await openSession();
    await appendEvent(sessionsDir, sessionLifecycleEvent(SESSION, 'finished', 'completed'));
    await writeRunRecord(runsDir, record());
    expect((await sweep({}))[0]).toEqual({ creationId: CREATION, action: 'gone', pid: 100 });
    expect(await endReasons()).toEqual([]);

    const other = '4a2b9c1e-0000-4a5b-9c8d-123456789abc';
    await appendEvent(sessionsDir, sessionLifecycleEvent(other, 'started'));
    await appendEvent(sessionsDir, sessionEndEvent(other, 'server_stop'));
    await writeRunRecord(runsDir, record({ sessionId: other }));
    expect((await sweep({}))[0]?.closedSession).toBeUndefined();
  });

  it('removes a folder with no valid record and ignores names that are not ids', async () => {
    await mkdir(path.join(runsDir, CREATION), { recursive: true });
    await writeFile(path.join(runsDir, CREATION, 'run.json'), '{"v":1}', 'utf8');
    await mkdir(path.join(runsDir, '.hidden'), { recursive: true });
    expect(await sweep({})).toEqual([{ creationId: CREATION, action: 'invalid' }]);
    expect(await runs()).toEqual(['.hidden']);
  });

  it('does nothing when there is no runs folder', async () => {
    expect(await sweep({})).toEqual([]);
  });
});
