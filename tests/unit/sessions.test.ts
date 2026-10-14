import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SERVER_STOP_REASON,
  appendEvent,
  flowEvent,
  listSessions,
  readEvents,
  sessionEndEvent,
  sessionEventsFile,
  sessionLifecycleEvent,
  sessionTimeline,
  summarizeSession,
  type SessionEvent,
} from '../../src/events/index.js';
import { tempDir } from '../helpers.js';

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 12, 10, minutes));
const hook = (session: string, minutes: number, type: 'subagent.start' | 'subagent.stop', agentId: string, agentType?: string): SessionEvent => ({
  v: 1,
  ts: at(minutes).toISOString(),
  session,
  source: 'hook',
  type,
  agentId,
  ...(agentType === undefined ? {} : { agentType }),
});

describe('sessions', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let sessionsDir: string;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('sessions'));
    sessionsDir = path.join(dir, 'home', 'sessions');
  });
  afterEach(() => cleanup());

  const record = async (events: SessionEvent[]) => {
    for (const event of events) await appendEvent(sessionsDir, event);
  };

  it('lists nothing when the sessions folder is missing', async () => {
    expect(await listSessions(sessionsDir)).toEqual([]);
  });

  it('lists sessions newest first, skipping folders without events or with unsafe names', async () => {
    await record([
      sessionLifecycleEvent('older', 'started', undefined, at(0)),
      sessionLifecycleEvent('older', 'finished', 'completed', at(5)),
      sessionLifecycleEvent('newer', 'started', undefined, at(10)),
      flowEvent('newer', 'idea', 'started', undefined, at(11)),
      // No session.started: sorted by its last event.
      flowEvent('headless', 'idea', 'started', undefined, at(3)),
    ]);
    await mkdir(path.join(sessionsDir, 'empty'), { recursive: true });
    await mkdir(path.join(sessionsDir, '.hidden'), { recursive: true });
    await writeFile(path.join(sessionsDir, '.hidden', 'events.jsonl'), '', 'utf8');
    await writeFile(path.join(sessionsDir, 'stray.txt'), 'x', 'utf8');

    const list = await listSessions(sessionsDir, { now: at(20) });
    expect(list.map((item) => [item.id, item.status])).toEqual([
      ['newer', 'in-progress'],
      ['headless', 'in-progress'],
      ['older', 'finished'],
    ]);
    expect(list[2]).toEqual({
      id: 'older',
      status: 'finished',
      outcome: 'completed',
      startedAt: at(0).toISOString(),
      lastEventAt: at(5).toISOString(),
    });
  });

  it('builds a timeline: steps in first-start order, a restarted step keeps its last pair, agents with their stops', async () => {
    const id = 'run-1';
    await record([
      sessionLifecycleEvent(id, 'started', undefined, at(0)),
      flowEvent(id, 'idea', 'started', undefined, at(0)),
      flowEvent(id, 'idea', 'finished', 'ok', at(1)),
      flowEvent(id, 'spec', 'started', undefined, at(2)),
      hook(id, 2, 'subagent.start', 'a1', 'architect'),
      hook(id, 3, 'subagent.stop', 'a1'),
      flowEvent(id, 'spec', 'finished', 'failed', at(4)),
      flowEvent(id, 'research', 'finished', 'skipped', at(5)),
      flowEvent(id, 'spec', 'started', undefined, at(6)),
      hook(id, 6, 'subagent.start', 'a2', 'architect'),
      flowEvent(id, 'generate', 'started', undefined, at(7)),
    ]);

    const timeline = await sessionTimeline(sessionsDir, id, { now: at(8) });
    expect(timeline.summary).toMatchObject({ status: 'in-progress', lastStep: { step: 'generate', phase: 'started' } });
    expect(timeline.steps).toEqual([
      { step: 'idea', startedAt: at(0).toISOString(), finishedAt: at(1).toISOString(), outcome: 'ok' },
      { step: 'spec', startedAt: at(6).toISOString() },
      { step: 'research', startedAt: at(5).toISOString(), finishedAt: at(5).toISOString(), outcome: 'skipped' },
      { step: 'generate', startedAt: at(7).toISOString() },
    ]);
    expect(timeline.agents).toEqual([
      { agentId: 'a1', agentType: 'architect', startedAt: at(2).toISOString(), stoppedAt: at(3).toISOString() },
      { agentId: 'a2', agentType: 'architect', startedAt: at(6).toISOString() },
    ]);
  });

  it('refuses unsafe ids and reports a missing session', async () => {
    await expect(sessionTimeline(sessionsDir, '../x')).rejects.toMatchObject({ code: 'events.invalidSession' });
    await expect(sessionTimeline(sessionsDir, 'nope')).rejects.toMatchObject({ code: 'events.sessionNotFound' });
  });

  it('reads a trailing server_stop end as interrupted', async () => {
    const id = 'stopped';
    await record([
      sessionLifecycleEvent(id, 'started', undefined, at(0)),
      flowEvent(id, 'interview', 'started', undefined, at(1)),
      sessionEndEvent(id, SERVER_STOP_REASON, at(2)),
    ]);
    const { events, badLines } = await readEvents(sessionEventsFile(sessionsDir, id));
    expect(badLines).toEqual([]);
    expect(summarizeSession(events, { now: at(3) })).toMatchObject({ status: 'interrupted', endReason: 'server_stop' });
    expect((await listSessions(sessionsDir, { now: at(3) }))[0]).toMatchObject({ id, status: 'interrupted', endReason: 'server_stop' });
  });
});
