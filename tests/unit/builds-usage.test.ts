import { describe, expect, it } from 'vitest';
import { decideUsage, readBuildUsage, USAGE_RETRY_MS, type UsageReading } from '../../src/builds/usage.js';

// The plan-usage reading before each task of a build (BRIEF-phase-9 §3.3;
// decisions.md, "Phase 9: H0", 2; PLAN-phase-9 §1.9).

const NOW = new Date('2026-11-18T10:00:00.000Z');
const T = { fiveHour: 80, week: 90 };
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

describe('decideUsage', () => {
  it('goes on below the thresholds, and always for a login without plan limits', () => {
    expect(decideUsage({ kind: 'ok', fiveHour: 79, sevenDay: 89 }, T, NOW)).toEqual({ go: true });
    expect(decideUsage({ kind: 'ok', fiveHour: null, sevenDay: null }, T, NOW)).toEqual({ go: true });
    expect(decideUsage({ kind: 'unavailable' }, T, NOW)).toEqual({ go: true });
  });

  it('pauses at a threshold until the window\'s reset time, the later one when both are over', () => {
    expect(decideUsage({ kind: 'ok', fiveHour: 80, sevenDay: 10, fiveHourResetsAt: at(30) }, T, NOW)).toEqual({ go: false, reason: 'usage', until: new Date(at(30)), fiveHour: 80, sevenDay: 10 });
    const both = decideUsage({ kind: 'ok', fiveHour: 95, sevenDay: 95, fiveHourResetsAt: at(30), sevenDayResetsAt: at(600) }, T, NOW);
    expect(both).toMatchObject({ go: false, reason: 'usage', until: new Date(at(600)) });
    // The weekly window under its threshold does not count, whatever its reset time.
    expect(decideUsage({ kind: 'ok', fiveHour: 95, sevenDay: 10, fiveHourResetsAt: at(30), sevenDayResetsAt: at(600) }, T, NOW)).toMatchObject({ until: new Date(at(30)) });
  });

  it('reads again after the interval when a window over its threshold has no valid future reset time', () => {
    const retry = new Date(NOW.getTime() + USAGE_RETRY_MS);
    expect(decideUsage({ kind: 'ok', fiveHour: 95, sevenDay: 10 }, T, NOW)).toMatchObject({ go: false, reason: 'usage', until: retry });
    expect(decideUsage({ kind: 'ok', fiveHour: 95, sevenDay: 10, fiveHourResetsAt: 'not a time' }, T, NOW)).toMatchObject({ until: retry });
    expect(decideUsage({ kind: 'ok', fiveHour: 95, sevenDay: 10, fiveHourResetsAt: at(-5) }, T, NOW)).toMatchObject({ until: retry });
    // One window known and the other not: the interval, not the known time.
    expect(decideUsage({ kind: 'ok', fiveHour: 95, sevenDay: 95, fiveHourResetsAt: at(30) }, T, NOW, 1000)).toMatchObject({ until: new Date(NOW.getTime() + 1000) });
  });

  it('pauses on a failed reading and reads again after the interval', () => {
    expect(decideUsage({ kind: 'failed', message: 'x' }, T, NOW, 5000)).toEqual({ go: false, reason: 'usageUnread', until: new Date(NOW.getTime() + 5000) });
  });
});

/** A query whose usage call answers `usage` (or throws it), recording that it was closed. */
function fakeQuery(usage: unknown): { query: never; closed: () => boolean } {
  let closed = false;
  const query = (() => ({
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
      if (usage instanceof Error) throw usage;
      return usage;
    },
    close: () => {
      closed = true;
    },
  })) as never;
  return { query, closed: () => closed };
}

describe('readBuildUsage', () => {
  const read = (usage: unknown) => {
    const fake = fakeQuery(usage);
    return { reading: readBuildUsage({ cwd: '.', executable: 'claude', env: {}, query: fake.query }), closed: fake.closed };
  };

  it('keeps each window\'s utilization and reset time, and closes the session', async () => {
    const { reading, closed } = read({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 42, resets_at: at(60) }, seven_day: { utilization: 7, resets_at: null } } });
    expect(await reading).toEqual<UsageReading>({ kind: 'ok', fiveHour: 42, sevenDay: 7, fiveHourResetsAt: at(60) });
    expect(closed()).toBe(true);
  });

  it('tells a login without plan limits apart from a failed reading', async () => {
    expect(await read({ rate_limits_available: false, rate_limits: null }).reading).toEqual({ kind: 'unavailable' });
    expect(await read(new Error('no session')).reading).toEqual({ kind: 'failed', message: 'no session' });
  });
});
