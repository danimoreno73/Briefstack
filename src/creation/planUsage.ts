import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
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

/**
 * The reader the web server gives the creation manager: the user's own
 * `claude`, the same clean environment as a creation, the repo as working
 * folder. Undefined when there is nothing to show.
 */
export function planUsageReader(options: { pathEnv: PathEnv; repoDir: string }): () => Promise<PlanUsage | undefined> {
  return async () => {
    const { pathEnv, repoDir } = options;
    const executable = findClaudeExecutable({ env: pathEnv.env, platform: process.platform, homedir: pathEnv.homedir });
    if (executable === undefined) return undefined;
    const { env } = cleanEnvironment(pathEnv.env, resolveHome(pathEnv));
    const usage = await readPlanUsage({ cwd: repoDir, executable, env });
    return typeof usage === 'string' ? undefined : usage;
  };
}
