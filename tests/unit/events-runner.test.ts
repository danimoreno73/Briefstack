import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRunner, parseRecording } from '../../src/creation/fakeRunner.js';
import { guardHook, type GuardContext, type GuardDenial } from '../../src/creation/guard.js';
import { CreationManager, type CreationState, type StreamEvent } from '../../src/creation/manager.js';
import type { PermissionPolicy } from '../../src/creation/types.js';
import { readEvents, runnerEvent, sessionEventsFile, summarizeSession, type SessionEvent } from '../../src/events/index.js';
import { OUTSIDE_TEXT } from '../../src/panel/project.js';
import { tempDir } from '../helpers.js';

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const KEY = ['sk', 'ant', 'a'.repeat(30)].join('-');

describe('runner lines in events.jsonl', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await tempDir('events-runner')));
  afterEach(() => cleanup());

  it('are read next to phase 2 lines, and malformed ones are bad lines', async () => {
    const file = path.join(dir, 'events.jsonl');
    const lines = [
      { v: 1, ts: '2026-10-16T10:00:00Z', session: 's', source: 'flow', type: 'session.started' },
      { v: 1, ts: '2026-10-16T10:00:01Z', session: 's', source: 'runner', type: 'session.profile', profile: 'balanced', model: 'opus' },
      { v: 1, ts: '2026-10-16T10:00:02Z', session: 's', source: 'runner', type: 'usage', fiveHour: 12.5, sevenDay: null },
      { v: 1, ts: '2026-10-16T10:00:03Z', session: 's', source: 'runner', type: 'tool.denied', tool: 'Write', by: 'guard', reason: 'No.' },
      // Malformed: unknown type, bad `by`, missing tool, a string percent.
      { v: 1, ts: '2026-10-16T10:00:04Z', session: 's', source: 'runner', type: 'something' },
      { v: 1, ts: '2026-10-16T10:00:05Z', session: 's', source: 'runner', type: 'tool.denied', tool: 'Write', by: 'someone' },
      { v: 1, ts: '2026-10-16T10:00:06Z', session: 's', source: 'runner', type: 'tool.denied', by: 'guard' },
      { v: 1, ts: '2026-10-16T10:00:07Z', session: 's', source: 'runner', type: 'usage', fiveHour: '12', sevenDay: 1 },
    ];
    await writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8');
    const { events, badLines } = await readEvents(file);
    expect(events.map((event) => event.type)).toEqual(['session.started', 'session.profile', 'usage', 'tool.denied']);
    expect(badLines).toEqual([5, 6, 7, 8]);
  });

  it('are not activity: a reading after the end keeps the session interrupted', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 16, 10, 0, s));
    const events: SessionEvent[] = [
      { v: 1, ts: at(0).toISOString(), session: 's', source: 'flow', type: 'session.started' },
      { v: 1, ts: at(1).toISOString(), session: 's', source: 'hook', type: 'session.end', reason: 'other' },
      runnerEvent('s', { type: 'usage', fiveHour: 1, sevenDay: 2 }, at(2)),
    ];
    expect(summarizeSession(events, { now: at(3) })).toMatchObject({ status: 'interrupted', endReason: 'other', lastEventAt: at(1).toISOString() });
  });
});

describe('the guard reports who made a denied call', () => {
  it('adds the agent id and the tool use id to its denial', async () => {
    const denials: GuardDenial[] = [];
    const context: GuardContext = {
      isOwnSession: () => true,
      sessionDir: () => '/tmp/s',
      projectsDir: '/tmp/projects',
      libraryDir: '/tmp/library',
      cwd: '/tmp/repo',
      grantedDirs: () => [],
      cancelled: () => false,
    };
    const hook = guardHook(context, (denial) => denials.push(denial));
    const signal = { signal: new AbortController().signal };
    await hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '',
        cwd: '',
        tool_name: 'WebFetch',
        tool_input: { url: 'https://example.com' },
        tool_use_id: 'toolu_9',
        agent_id: 'a7',
        agent_type: 'architect',
      },
      'toolu_9',
      signal,
    );
    expect(denials).toEqual([expect.objectContaining({ toolName: 'WebFetch', agentId: 'a7', agentType: 'architect', toolUseId: 'toolu_9' })]);
  });
});

describe('the manager writes runner lines', () => {
  let sessionsDir: string;
  let cleanup: () => Promise<void>;
  let manager: CreationManager | undefined;
  beforeEach(async () => {
    const temp = await tempDir('runner-lines');
    sessionsDir = path.join(temp.dir, 'sessions');
    cleanup = temp.cleanup;
  });
  afterEach(async () => {
    await manager?.shutdown();
    manager = undefined;
    await cleanup();
  });

  const start = async (recording: string[], policy: PermissionPolicy = 'ask') => {
    manager = new CreationManager({
      runner: new FakeRunner({ steps: parseRecording(recording.join('\n')) }),
      sessionsDir,
      policy: () => policy,
      profile: () => ({ name: 'balanced', sessionModel: 'opus', effort: 'medium' }),
      pollMs: 10,
      tailMs: 20,
    });
    const { id } = await manager.create('idea');
    const seen: StreamEvent[] = [];
    manager.subscribe(id, 0, (event) => seen.push(event));
    return { m: manager, id, seen };
  };
  const lines = async (state: CreationState) => (await readEvents(sessionEventsFile(sessionsDir, state.sessionId ?? ''))).events;

  it('records the profile, a guard denial with its reason redacted, and a user and a policy denial', async () => {
    const { m, id, seen } = await start([
      '{"do":"session","phase":"started"}',
      '{"do":"hook","type":"subagent.start","agentId":"g1","agentType":"generator","model":"sonnet"}',
      '{"do":"hook","type":"tool.pre","agentId":"g1","agentType":"generator","tool":"Write","toolUseId":"t1"}',
      JSON.stringify({
        do: 'emit',
        event: { kind: 'denial', toolName: 'Write', summary: 'x', agentType: 'generator', agentId: 'g1', toolUseId: 't1', reason: `Writes only inside.\nkey=${KEY}` },
      }),
      '{"do":"permission","toolName":"Bash","summary":"git push","agentType":"generator"}',
      '{"do":"wait","ms":50}',
      '{"do":"session","phase":"finished","outcome":"completed"}',
    ]);
    const asked = await waitFor(() => m.get(id).pending);
    m.answer(id, asked.id, 'deny');
    const final = await waitFor(() => (m.get(id).status === 'finished' ? m.get(id) : undefined));

    const written = await lines(final);
    const runner = written.filter((event) => event.source === 'runner');
    expect(runner).toEqual([
      expect.objectContaining({ type: 'session.profile', profile: 'balanced', model: 'opus', effort: 'medium' }),
      expect.objectContaining({ type: 'tool.denied', tool: 'Write', by: 'guard', agentId: 'g1', agentType: 'generator', toolUseId: 't1' }),
      expect.objectContaining({ type: 'tool.denied', tool: 'Bash', by: 'user', agentType: 'generator' }),
    ]);
    const guard = runner[1] as { reason?: string };
    expect(guard.reason).toContain('Writes only inside.');
    expect(guard.reason).not.toContain(KEY);
    // Hook lines are streamed projected: with their position as id, nothing unknown.
    const pre = seen.find((event) => event.kind === 'hook' && event.data.type === 'tool.pre');
    expect(pre?.data).toMatchObject({ id: 4, tool: 'Write', toolUseId: 't1' });
    // They reach the stream as their own kind.
    expect(seen.filter((event) => event.kind === 'runner').map((event) => event.data.type)).toEqual(['session.profile', 'tool.denied', 'tool.denied']);
    expect(JSON.stringify(seen)).not.toContain(KEY);
  });

  it('writes a guard denial without the absolute paths its reason quotes', async () => {
    const reason = 'The briefstack command `C:/Users/someone/private/app scaffold` is not allowed; see /home/someone/private/notes.md.';
    const { m, id } = await start([
      '{"do":"session","phase":"started"}',
      JSON.stringify({ do: 'emit', event: { kind: 'denial', toolName: 'Bash', summary: 'x', agentType: 'generator', reason } }),
      '{"do":"wait","ms":50}',
      '{"do":"session","phase":"finished","outcome":"completed"}',
    ]);
    const final = await waitFor(() => (m.get(id).status === 'finished' ? m.get(id) : undefined));
    const denial = (await lines(final)).find((event) => event.type === 'tool.denied') as { reason?: string } | undefined;
    expect(denial?.reason).toContain('The briefstack command');
    expect(denial?.reason).toContain(OUTSIDE_TEXT);
    expect(denial?.reason).not.toContain('someone');
  });

  it('streams the lines written right after session.finished, as the file keeps them', async () => {
    const { m, id, seen } = await start([
      '{"do":"session","phase":"started"}',
      '{"do":"wait","ms":60000}',
    ]);
    const session = await waitFor(() => m.get(id).sessionId);
    await waitFor(() => seen.some((event) => event.kind === 'flow'));
    // The flow closes and a subagent stop lands right after it, in the same read.
    const ts = new Date().toISOString();
    await appendFile(
      sessionEventsFile(sessionsDir, session),
      [
        { v: 1, ts, session, source: 'flow', type: 'session.finished', outcome: 'completed' },
        { v: 1, ts, session, source: 'hook', type: 'subagent.stop', agentId: 'r1', agentType: 'reviewer' },
      ]
        .map((event) => `${JSON.stringify(event)}\n`)
        .join(''),
      'utf8',
    );
    const final = await waitFor(() => (m.get(id).status === 'finished' ? m.get(id) : undefined));
    const written = (await lines(final)).filter((event) => event.source !== 'flow');
    const streamed = seen.flatMap((event) => (event.kind === 'hook' || event.kind === 'runner' ? [event.data.type] : []));
    expect(streamed).toEqual(written.map((event) => event.type));
    expect(streamed).toContain('subagent.stop');
  });

  it('records a denial under the unattended policy', async () => {
    const { m, id } = await start([
      '{"do":"session","phase":"started"}',
      '{"do":"permission","toolName":"Bash","summary":"git push","agentType":"reviewer"}',
      '{"do":"wait","ms":50}',
      '{"do":"session","phase":"finished","outcome":"completed"}',
    ], 'unattended');
    const final = await waitFor(() => (m.get(id).status === 'finished' ? m.get(id) : undefined));
    expect((await lines(final)).filter((event) => event.type === 'tool.denied')).toEqual([
      expect.objectContaining({ tool: 'Bash', by: 'policy', agentType: 'reviewer' }),
    ]);
  });

  it('writes a burst of hook lines the fake runner asks for in one go', async () => {
    const { m, id, seen } = await start([
      '{"do":"session","phase":"started"}',
      '{"do":"burst","count":300,"agentId":"r1","agentType":"reviewer","tool":"Read"}',
      '{"do":"wait","ms":50}',
      '{"do":"session","phase":"finished","outcome":"completed"}',
    ]);
    const final = await waitFor(() => (m.get(id).status === 'finished' ? m.get(id) : undefined));
    const hooks = (await lines(final)).filter((event) => event.source === 'hook');
    expect(hooks).toHaveLength(600);
    expect(seen.filter((event) => event.kind === 'hook')).toHaveLength(600);
  });
});
