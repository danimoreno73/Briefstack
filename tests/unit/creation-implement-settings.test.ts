import { describe, expect, it } from 'vitest';
import { implementBoundsOf, parseConfig } from '../../src/config/index.js';
import { implementUsageGate } from '../../src/creation/wiring.js';

// The implement step's bounds and usage gate (PLAN-phase-10 §1, 7): two settings with conservative defaults, and the
// builds' reading and decision against the user's thresholds; a login without plan limits starts, a failed reading
// does not (a creation has no pause).

describe('the implement step settings', () => {
  it('default to 30 minutes and 150 tool calls, and take values in range only', () => {
    expect(implementBoundsOf({})).toEqual({ maxMinutes: 30, maxToolCalls: 150 });
    expect(implementBoundsOf(parseConfig(JSON.stringify({ implementMaxMinutes: 5, implementMaxToolCalls: 1000 }), 'c.json'))).toEqual({ maxMinutes: 5, maxToolCalls: 1000 });
    for (const bad of [{ implementMaxMinutes: 4 }, { implementMaxMinutes: 121 }, { implementMaxMinutes: 10.5 }, { implementMaxToolCalls: 19 }, { implementMaxToolCalls: 1001 }, { implementMaxToolCalls: '50' }]) {
      expect(() => parseConfig(JSON.stringify(bad), 'c.json'), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'config.invalidField' }));
    }
  });
});

describe('implementUsageGate', () => {
  const now = () => new Date('2026-11-22T12:00:00Z');
  const thresholds = async () => ({ fiveHour: 80, week: 85 });

  it('starts below the thresholds and with a login without plan limits', async () => {
    expect(await implementUsageGate({ read: async () => ({ kind: 'ok', fiveHour: 40, sevenDay: 50 }), thresholds, now })()).toEqual({ go: true });
    expect(await implementUsageGate({ read: async () => ({ kind: 'unavailable' }), thresholds, now })()).toEqual({ go: true });
  });

  it('does not start at or above a threshold, nor when the reading failed', async () => {
    expect(await implementUsageGate({ read: async () => ({ kind: 'ok', fiveHour: 80, sevenDay: 10 }), thresholds, now })()).toEqual({ go: false, reason: 'usage', fiveHour: 80, sevenDay: 10 });
    expect(await implementUsageGate({ read: async () => ({ kind: 'ok', fiveHour: 10, sevenDay: 90 }), thresholds, now })()).toMatchObject({ go: false, reason: 'usage' });
    expect(await implementUsageGate({ read: async () => ({ kind: 'failed', message: 'x' }), thresholds, now })()).toEqual({ go: false, reason: 'usageUnread' });
  });
});
