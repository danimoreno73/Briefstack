import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { resolveHome, type PathEnv } from '../config/index.js';
import { findClaudeExecutable } from '../creation/claudeBinary.js';
import { saveLastPlanUsage } from '../creation/planUsage.js';
import { cleanEnvironment } from '../creation/sdkRunner.js';

/**
 * The plan-usage reading a build makes before each task (BRIEF-phase-9 §2,
 * 8 and §3.3; decisions.md, "Phase 9: H0", 2). The same free reading as
 * `src/creation/planUsage.ts` (a session that sends no message), keeping
 * each window's `resets_at`, and telling a failed reading apart from a
 * login without plan limits.
 */

export type UsageReading =
  | { kind: 'ok'; fiveHour: number | null; sevenDay: number | null; fiveHourResetsAt?: string; sevenDayResetsAt?: string }
  /** Plan limits do not apply to this login (an API key, a cloud provider): a build never pauses for them. */
  | { kind: 'unavailable' }
  | { kind: 'failed'; message: string };

/** How long a build waits before it reads again, when no reset time is known or the reading failed. */
export const USAGE_RETRY_MS = 15 * 60_000;

export type UsageDecision = { go: true } | { go: false; reason: 'usage' | 'usageUnread'; until: Date; fiveHour?: number | null; sevenDay?: number | null };

/** The furthest reset time a build waits for: the weekly window plus a day. A later one is not believed (review of M4, I3). */
export const MAX_RESET_WAIT_MS = 8 * 24 * 60 * 60_000;

/** How long a reading may take before it counts as failed (review of M4, I2). */
export const USAGE_READ_TIMEOUT_MS = 30_000;

const resetTime = (value: string | undefined, now: Date): number | undefined => {
  if (value === undefined) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > now.getTime() && at - now.getTime() <= MAX_RESET_WAIT_MS ? at : undefined;
};

/**
 * Whether the next task may start. At or above a threshold the build waits
 * until the later reset time of the windows that are over, when every one
 * of them gives a valid time in the future; otherwise it reads again after
 * `retryMs`. A failed reading waits too; a login without plan limits never.
 */
export function decideUsage(reading: UsageReading, thresholds: { fiveHour: number; week: number }, now: Date, retryMs = USAGE_RETRY_MS): UsageDecision {
  if (reading.kind === 'unavailable') return { go: true };
  if (reading.kind === 'failed') return { go: false, reason: 'usageUnread', until: new Date(now.getTime() + retryMs) };
  const over: (string | undefined)[] = [];
  if (reading.fiveHour !== null && reading.fiveHour >= thresholds.fiveHour) over.push(reading.fiveHourResetsAt);
  if (reading.sevenDay !== null && reading.sevenDay >= thresholds.week) over.push(reading.sevenDayResetsAt);
  if (over.length === 0) return { go: true };
  const times = over.map((value) => resetTime(value, now));
  const known = times.every((time) => time !== undefined);
  const until = known ? new Date(Math.max(...(times as number[]))) : new Date(now.getTime() + retryMs);
  return { go: false, reason: 'usage', until, fiveHour: reading.fiveHour, sevenDay: reading.sevenDay };
}

/** One reading from the user's own `claude`, never failing with an exception. */
export async function readBuildUsage(options: { cwd: string; executable: string; env: Record<string, string | undefined>; query?: typeof sdkQuery; timeoutMs?: number }): Promise<UsageReading> {
  const neverSends: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(() => undefined) }) };
  const run = options.query ?? sdkQuery;
  let q: ReturnType<typeof sdkQuery> | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    q = run({ prompt: neverSends, options: { cwd: options.cwd, pathToClaudeCodeExecutable: options.executable, env: options.env, settingSources: [] } });
    // A `claude` that never answers counts as a failed reading; the session is closed in `finally`.
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The plan usage reading took too long.')), options.timeoutMs ?? USAGE_READ_TIMEOUT_MS);
      timer.unref();
    });
    const usage = await Promise.race([q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), late]);
    if (!usage.rate_limits_available || usage.rate_limits === null) return { kind: 'unavailable' };
    const five = usage.rate_limits.five_hour;
    const seven = usage.rate_limits.seven_day;
    return {
      kind: 'ok',
      fiveHour: five?.utilization ?? null,
      sevenDay: seven?.utilization ?? null,
      ...(typeof five?.resets_at === 'string' ? { fiveHourResetsAt: five.resets_at } : {}),
      ...(typeof seven?.resets_at === 'string' ? { sevenDayResetsAt: seven.resets_at } : {}),
    };
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    q?.close();
  }
}

/** The reader `briefstack web` gives builds: the user's `claude`, a creation's clean environment, the repo as working folder; each reading saved as the last one. */
export function buildUsageReader(options: { pathEnv: PathEnv; repoDir: string }): () => Promise<UsageReading> {
  const { pathEnv, repoDir } = options;
  const home = resolveHome(pathEnv);
  return async () => {
    const executable = findClaudeExecutable({ env: pathEnv.env, platform: process.platform, homedir: pathEnv.homedir });
    if (executable === undefined) return { kind: 'failed', message: 'Claude Code was not found.' };
    const { env } = cleanEnvironment(pathEnv.env, home);
    const reading = await readBuildUsage({ cwd: repoDir, executable, env });
    if (reading.kind === 'ok') {
      const resets = { ...(reading.fiveHourResetsAt === undefined ? {} : { fiveHourResetsAt: reading.fiveHourResetsAt }), ...(reading.sevenDayResetsAt === undefined ? {} : { sevenDayResetsAt: reading.sevenDayResetsAt }) };
      await saveLastPlanUsage(home, { fiveHour: reading.fiveHour, sevenDay: reading.sevenDay, ...resets }, new Date());
    }
    return reading;
  };
}
