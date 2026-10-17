import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRunner, parseRecording } from '../../src/creation/fakeRunner.js';
import { CreationManager } from '../../src/creation/manager.js';
import { readPlanUsage } from '../../src/creation/planUsage.js';
import { readEvents, sessionEventsFile } from '../../src/events/index.js';
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

/** A stand-in for the SDK's `query()`: only the usage method and `close`. */
function fakeQuery(answer: () => Promise<unknown>) {
  const calls: { options: Record<string, unknown> }[] = [];
  let closed = 0;
  const query = ((params: { options: Record<string, unknown> }) => {
    calls.push(params);
    return { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: answer, close: () => (closed += 1) };
  }) as never;
  return { query, calls, closed: () => closed };
}

describe('readPlanUsage', () => {
  const base = { cwd: 'repo', executable: 'claude', env: { HOME: 'h' } };

  it('reads both windows from a session that sends nothing, and closes it', async () => {
    const fake = fakeQuery(async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 12 }, seven_day: { utilization: 40 } } }));
    expect(await readPlanUsage({ ...base, query: fake.query })).toEqual({ fiveHour: 12, sevenDay: 40 });
    expect(fake.calls[0]?.options).toEqual({ cwd: 'repo', pathToClaudeCodeExecutable: 'claude', env: { HOME: 'h' }, settingSources: [] });
    expect(fake.closed()).toBe(1);
  });

  it('says why when the plan has no limits or the reading fails, and never throws', async () => {
    const none = fakeQuery(async () => ({ rate_limits_available: false, rate_limits: null }));
    expect(await readPlanUsage({ ...base, query: none.query })).toMatch(/not available/);
    const partial = fakeQuery(async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 3 } } }));
    expect(await readPlanUsage({ ...base, query: partial.query })).toEqual({ fiveHour: 3, sevenDay: null });
    const failing = fakeQuery(async () => {
      throw new Error('boom');
    });
    expect(await readPlanUsage({ ...base, query: failing.query })).toMatch(/could not read the usage: boom/);
    expect(failing.closed()).toBe(1);
  });
});

describe('the manager records plan usage', () => {
  let sessionsDir: string;
  let cleanup: () => Promise<void>;
  let manager: CreationManager | undefined;
  beforeEach(async () => {
    const temp = await tempDir('plan-usage');
    sessionsDir = path.join(temp.dir, 'sessions');
    cleanup = temp.cleanup;
  });
  afterEach(async () => {
    await manager?.shutdown();
    manager = undefined;
    await cleanup();
  });

  const run = async (planUsage: () => Promise<{ fiveHour: number | null; sevenDay: number | null } | undefined>) => {
    manager = new CreationManager({
      runner: new FakeRunner({
        steps: parseRecording(['{"do":"session","phase":"started"}', '{"do":"wait","ms":200}', '{"do":"session","phase":"finished","outcome":"completed"}'].join('\n')),
      }),
      sessionsDir,
      policy: () => 'ask',
      profile: () => ({ name: 'balanced', sessionModel: 'sonnet' }),
      pollMs: 10,
      planUsage,
      usageEveryMs: 60,
    });
    const { id } = await manager.create('idea');
    const m = manager;
    const final = await waitFor(() => (m.get(id).status === 'finished' ? m.get(id) : undefined));
    // Nothing more is read once it finished.
    await new Promise((resolve) => setTimeout(resolve, 150));
    return (await readEvents(sessionEventsFile(sessionsDir, final.sessionId ?? ''))).events.filter((event) => event.type === 'usage');
  };

  it('at the start and periodically while it runs, then stops', async () => {
    let reading = 0;
    const usage = await run(async () => {
      reading += 1;
      return { fiveHour: reading, sevenDay: 50 };
    });
    expect(usage.length).toBeGreaterThanOrEqual(2);
    expect(usage[0]).toMatchObject({ source: 'runner', fiveHour: 1, sevenDay: 50 });
    const after = reading;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(reading).toBe(after);
  });

  it('writes nothing for a reading that failed or had nothing', async () => {
    let calls = 0;
    const usage = await run(async () => {
      calls += 1;
      if (calls === 1) throw new Error('no');
      return undefined;
    });
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(usage).toEqual([]);
  });
});
