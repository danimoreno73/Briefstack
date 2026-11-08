import type { TaskCodexCallUi, TaskViewUi } from './types.js';

/**
 * Codex calls on a task's page (phase 8, decisions.md "Phase 8: step 27"):
 * what the page computes from the rounds' records. Pure, so the unit tests
 * read it without a browser.
 */

export type CodexUsageUi = NonNullable<TaskCodexCallUi['usage']>;

/**
 * One call's tokens as Codex counts them (`TokenUsage::blended_total`,
 * decisions.md "Phase 8: step 28"): the input that was not cached plus the
 * output. The page's main figure. Reasoning is not added, as Codex does not.
 */
export function callTokens(usage: CodexUsageUi): number {
  // Codex subtracts with a floor at 0 (`saturating_sub`).
  return Math.max(0, usage.input - usage.cached) + usage.output;
}

/** Every token the call reported: the whole input (cached included) plus the output. Shown in brackets. */
export function callTokensWithCache(usage: CodexUsageUi): number {
  return usage.input + usage.output;
}

export interface CodexTotals {
  /** Every recorded call of the task, all rounds. */
  calls: number;
  /** The tokens of the calls that have usage, as Codex counts them (`callTokens`). */
  tokens: number;
  /** The same calls' tokens with the cached input (`callTokensWithCache`). */
  tokensWithCache: number;
  /** Calls with no usage (ended before Codex reported it): never counted as 0 tokens. */
  withoutUsage: number;
}

export function codexTotals(rounds: TaskViewUi['rounds']): CodexTotals {
  let calls = 0;
  let tokens = 0;
  let tokensWithCache = 0;
  let withoutUsage = 0;
  for (const round of rounds) {
    for (const call of round.codex ?? []) {
      calls += 1;
      if (call.usage === undefined) withoutUsage += 1;
      else {
        tokens += callTokens(call.usage);
        tokensWithCache += callTokensWithCache(call.usage);
      }
    }
  }
  return { calls, tokens, tokensWithCache, withoutUsage };
}

/** The rounds that have Codex calls, in order; the page shows a section only for these. */
export function roundsWithCodex(rounds: TaskViewUi['rounds']): { n: number; calls: TaskCodexCallUi[] }[] {
  return rounds.filter((round) => (round.codex ?? []).length > 0).map((round) => ({ n: round.n, calls: round.codex ?? [] }));
}

/**
 * A count of tokens in the page's language: `1,250` in English, `1.250` in
 * Spanish. Grouped always: left to the locale, Spanish groups four digits in
 * some engines and not in others.
 */
export function formatCount(value: number, lang: string): string {
  return new Intl.NumberFormat(lang, { useGrouping: 'always' }).format(value);
}

/** The first line of Codex's message, cut, for the row; the whole message opens below it. */
export function messageHead(message: string, max = 80): string {
  const first = message.trim().split(/\r?\n/, 1)[0] ?? '';
  return first.length <= max ? first : `${first.slice(0, max - 1)}…`;
}
