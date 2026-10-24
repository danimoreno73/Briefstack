import { configFilePath, readConfig, usageWarningOf, type PathEnv } from '../config/index.js';

/**
 * The plan-usage warning before an expensive start (BRIEF-phase-6 §3.6):
 * starting a creation or preparing an improvement first reads the plan
 * usage; above a threshold (Settings), the page shows the values and a
 * "start anyway" choice, and the chat card shows them. It never blocks: a
 * reading that fails or is unknown warns about nothing. A reading younger
 * than `ttlMs` is reused, so two starts in a row cost one reading.
 */

export interface PlanReading {
  fiveHour: number | null;
  sevenDay: number | null;
}

export interface UsageWarning extends PlanReading {
  warnFiveHour: number;
  warnWeek: number;
}

export interface UsageCheckOptions {
  read: () => Promise<PlanReading | undefined>;
  thresholds: () => Promise<{ fiveHour: number; week: number }>;
  ttlMs?: number;
  now?: () => number;
}

export class UsageCheck {
  private cached: { at: number; reading: PlanReading | undefined } | undefined;
  private reading: Promise<PlanReading | undefined> | undefined;

  constructor(private readonly options: UsageCheckOptions) {}

  private async current(): Promise<PlanReading | undefined> {
    const now = (this.options.now ?? Date.now)();
    const ttl = this.options.ttlMs ?? 60_000;
    if (this.cached !== undefined && now - this.cached.at < ttl) return this.cached.reading;
    this.reading ??= this.options
      .read()
      .catch(() => undefined)
      .then((reading) => {
        this.cached = { at: (this.options.now ?? Date.now)(), reading };
        this.reading = undefined;
        return reading;
      });
    return this.reading;
  }

  /** The values and thresholds when either window is above its threshold; `undefined` otherwise. */
  async check(): Promise<UsageWarning | undefined> {
    const reading = await this.current();
    if (reading === undefined) return undefined;
    const thresholds = await this.options.thresholds();
    const high = (reading.fiveHour ?? 0) >= thresholds.fiveHour || (reading.sevenDay ?? 0) >= thresholds.week;
    return high ? { ...reading, warnFiveHour: thresholds.fiveHour, warnWeek: thresholds.week } : undefined;
  }
}

/** The thresholds from the user's config, read at each check. */
export function configThresholds(pathEnv: PathEnv): () => Promise<{ fiveHour: number; week: number }> {
  return async () => usageWarningOf(await readConfig(configFilePath(pathEnv)).catch(() => ({})));
}
