import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveHome, type PathEnv } from '../config/index.js';
import { findClaudeExecutable } from './claudeBinary.js';
import { cleanEnvironment } from './sdkRunner.js';

/** Plan usage as `/usage` shows it: percent of the 5-hour and 7-day windows, `null` when unknown. */
export interface PlanUsage {
  fiveHour: number | null;
  sevenDay: number | null;
}

export interface PlanUsageOptions {
  /** Working folder of the reading session. It sends no message, so nothing runs there. */
  cwd: string;
  executable: string;
  env: Record<string, string | undefined>;
  /** Injected in tests. */
  query?: typeof sdkQuery;
}

/**
 * Reads the plan usage the way `/usage` does, from a session that sends no
 * message (so it costs nothing). This is the reading `scripts/real/preflight.ts`
 * uses, verified in phase 2. The method is the SDK's experimental one, so a
 * failure is a message, never an exception.
 */
export async function readPlanUsage(options: PlanUsageOptions): Promise<PlanUsage | string> {
  const neverSends: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(() => undefined) }),
  };
  const run = options.query ?? sdkQuery;
  let q: ReturnType<typeof sdkQuery> | undefined;
  try {
    q = run({
      prompt: neverSends,
      options: { cwd: options.cwd, pathToClaudeCodeExecutable: options.executable, env: options.env, settingSources: [] },
    });
    const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    if (!usage.rate_limits_available || usage.rate_limits === null) return 'plan limits are not available for this login';
    return {
      fiveHour: usage.rate_limits.five_hour?.utilization ?? null,
      sevenDay: usage.rate_limits.seven_day?.utilization ?? null,
    };
  } catch (error) {
    return `could not read the usage: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    q?.close();
  }
}

/** The last plan usage read, with when it was read (`at`, ISO time). */
export interface LastPlanUsage extends PlanUsage {
  at: string;
}

/** `<home>/plan-usage.json`: the last reading, so the Usage page can show it without reading again. */
export const lastPlanUsageFile = (home: string): string => path.join(home, 'plan-usage.json');

const percentOrNull = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);

/** The last reading saved in the home, or undefined when there is none or the file does not read back. */
export async function readLastPlanUsage(home: string): Promise<LastPlanUsage | undefined> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(lastPlanUsageFile(home), 'utf8'));
  } catch {
    return undefined;
  }
  const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const { fiveHour, sevenDay, at } = record;
  if (!percentOrNull(fiveHour) || !percentOrNull(sevenDay) || typeof at !== 'string' || Number.isNaN(Date.parse(at))) return undefined;
  return { fiveHour, sevenDay, at };
}

/** Saves a reading (a whole file written aside, then renamed). A failure is ignored: it only costs the page its figures. */
export async function saveLastPlanUsage(home: string, usage: PlanUsage, at: Date): Promise<void> {
  const file = lastPlanUsageFile(home);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(home, { recursive: true });
    await writeFile(temp, `${JSON.stringify({ v: 1, fiveHour: usage.fiveHour, sevenDay: usage.sevenDay, at: at.toISOString() })}\n`, 'utf8');
    await rename(temp, file);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

/** A reader that also saves each reading it got in the home, before handing it on. */
export function savingReader(read: () => Promise<PlanUsage | undefined>, home: string, now: () => Date = () => new Date()): () => Promise<PlanUsage | undefined> {
  return async () => {
    const usage = await read();
    if (usage !== undefined) await saveLastPlanUsage(home, usage, now());
    return usage;
  };
}

/**
 * The reader the web server gives the creation manager and the chat: the
 * user's own `claude`, the same clean environment as a creation, the repo as
 * working folder. Undefined when there is nothing to show. Each reading is
 * also saved as the last known one.
 */
export function planUsageReader(options: { pathEnv: PathEnv; repoDir: string }): () => Promise<PlanUsage | undefined> {
  const { pathEnv, repoDir } = options;
  const home = resolveHome(pathEnv);
  return savingReader(async () => {
    const executable = findClaudeExecutable({ env: pathEnv.env, platform: process.platform, homedir: pathEnv.homedir });
    if (executable === undefined) return undefined;
    const { env } = cleanEnvironment(pathEnv.env, home);
    const usage = await readPlanUsage({ cwd: repoDir, executable, env });
    return typeof usage === 'string' ? undefined : usage;
  }, home);
}
