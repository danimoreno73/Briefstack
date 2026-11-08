import { describe, expect, it } from 'vitest';
import { uiMessages } from '../../src/i18n/ui.js';
import { callTokens, callTokensWithCache, codexTotals, formatCount, messageHead, roundsWithCodex } from '../../src/ui/codexData.js';
import type { TaskCodexCallUi, TaskViewUi } from '../../src/ui/types.js';

// Codex calls on a task's page (decisions.md, "Phase 8: step 27").

const call = (n: number, outcome: string, usage?: TaskCodexCallUi['usage']): TaskCodexCallUi => ({
  n,
  at: '2026-11-08T10:00:00.000Z',
  durationMs: 11_300,
  exitCode: outcome === 'completed' ? 0 : null,
  outcome,
  ...(usage === undefined ? {} : { usage }),
  commands: 1,
  message: 'Done.',
});

const round = (n: number, codex?: TaskCodexCallUi[]): TaskViewUi['rounds'][number] => ({ n, text: 'x', startedAt: '2026-11-08T10:00:00.000Z', ...(codex === undefined ? {} : { codex }) });

/** The real check's call (paso 26): 32,405 input of which 28,288 cached, 212 output, 0 reasoning. */
const REAL = { input: 32_405, cached: 28_288, output: 212, reasoning: 0 };

describe('Codex calls: the data the page shows', () => {
  it('a call\'s tokens are counted as Codex counts them: input not cached plus output; reasoning is not added', () => {
    expect(callTokens(REAL)).toBe(4329);
    expect(callTokens({ input: 1200, cached: 1000, output: 50, reasoning: 7 })).toBe(250);
    expect(callTokens({ input: 100, cached: 0, output: 10, reasoning: 2 })).toBe(110);
    // Codex subtracts with a floor at 0 (`saturating_sub`): a cached count above the input never gives less than the output.
    expect(callTokens({ input: 10, cached: 30, output: 5, reasoning: 0 })).toBe(5);
  });

  it('with cache, a call\'s tokens are every input token plus output; cached is part of input, reasoning is not added', () => {
    expect(callTokensWithCache(REAL)).toBe(32_617);
    expect(callTokensWithCache({ input: 1200, cached: 1000, output: 50, reasoning: 7 })).toBe(1250);
  });

  it('the totals count every call of every round, and the calls without usage apart, never as 0', () => {
    const rounds = [round(1, [call(1, 'completed', REAL), call(2, 'cancelled')]), round(2), round(3, [call(1, 'completed', { input: 100, cached: 0, output: 10, reasoning: 2 })])];
    expect(codexTotals(rounds)).toEqual({ calls: 3, tokens: 4439, tokensWithCache: 32_727, withoutUsage: 1 });
    expect(codexTotals([round(1), round(2, [])])).toEqual({ calls: 0, tokens: 0, tokensWithCache: 0, withoutUsage: 0 });
    // Older records have no `codex` at all.
    expect(roundsWithCodex([round(1)])).toEqual([]);
  });

  it('only rounds with calls get a section, in order', () => {
    const rounds = [round(1, [call(1, 'failed')]), round(2), round(3, []), round(4, [call(1, 'completed', REAL)])];
    expect(roundsWithCodex(rounds).map((item) => [item.n, item.calls.length])).toEqual([
      [1, 1],
      [4, 1],
    ]);
  });

  it('counts follow the page\'s language', () => {
    expect(formatCount(32_617, 'en')).toBe('32,617');
    expect(formatCount(32_617, 'es')).toBe('32.617');
    // Four digits are grouped too, in every engine (Chromium and Node differ when left to the locale).
    expect(formatCount(1250, 'es')).toBe('1.250');
    expect(formatCount(1250, 'en')).toBe('1,250');
    expect(formatCount(0, 'es')).toBe('0');
  });

  it('the row shows the message\'s first line, cut', () => {
    expect(messageHead('  I wrote codex-note.txt.\nMore.')).toBe('I wrote codex-note.txt.');
    expect(messageHead('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(messageHead('')).toBe('');
  });
});

describe('Codex calls: the texts', () => {
  const en = uiMessages.en;
  const es = uiMessages.es;

  it('the summary says calls and the per-round limit in Settings; without the limit, only the calls', () => {
    expect(en.taskCodexSummary(2, 5)).toBe('2 calls to Codex in this task (limit in Settings: 5 per round)');
    expect(en.taskCodexSummary(1, undefined)).toBe('1 call to Codex in this task');
    expect(es.taskCodexSummary(2, 5)).toBe('2 llamadas a Codex en esta tarea (tope en Ajustes: 5 por ronda)');
    expect(es.taskCodexSummary(1, undefined)).toBe('1 llamada a Codex en esta tarea');
  });

  it('the total gives Codex\'s count first, the count with cache in brackets, and how many calls have no usage data', () => {
    expect(en.taskCodexTokens('4,329', '32,617', 0)).toBe('4,329 tokens in total, as Codex counts them (32,617 with cache)');
    expect(en.taskCodexTokens('250', '1,250', 1)).toBe('250 tokens in total, as Codex counts them (1,250 with cache); 1 call without usage data');
    expect(es.taskCodexTokens('4.329', '32.617', 0)).toBe('4.329 tokens en total, como los cuenta Codex (32.617 con caché)');
    expect(es.taskCodexTokens('0', '0', 2)).toBe('0 tokens en total, como los cuenta Codex (0 con caché); 2 llamadas sin datos de uso');
  });

  it('a row gives Codex\'s count first and the count with cache in brackets; the parts follow apart', () => {
    expect(en.taskCodexCallTokens('4,329', '32,617')).toBe('4,329 tokens (32,617 with cache)');
    expect(es.taskCodexCallTokens('4.329', '32.617')).toBe('4.329 tokens (32.617 con caché)');
  });

  it('each round says calls used out of the limit', () => {
    expect(en.taskCodexRound(1, 2, 5)).toBe('Round 1: 2 / 5 calls');
    expect(en.taskCodexRound(2, 1, undefined)).toBe('Round 2: 1 call');
    expect(es.taskCodexRound(1, 2, 5)).toBe('Ronda 1: 2 / 5 llamadas');
  });

  it('every outcome has a text in both languages, and a row\'s tokens name each part', () => {
    for (const outcome of ['completed', 'failed', 'timedOut', 'cancelled', 'notStarted', 'headChanged']) {
      // A known outcome is translated (Spanish never falls back to the code); English keeps the plain words.
      expect(es.taskCodexOutcome(outcome)).not.toBe(outcome);
      expect(en.taskCodexOutcome(outcome)).not.toBe('');
    }
    expect(es.taskCodexOutcome('cancelled')).toBe('cancelada');
    expect(en.taskCodexUsage('32,405', '28,288', '212', '0')).toBe('32,405 input (28,288 cached) · 212 output · 0 reasoning');
    expect(es.taskCodexNoUsage).toBe('sin datos de uso');
  });

  it('the cost notice and the cancel button\'s help', () => {
    expect(es.taskCodexCost).toBe('Cada llamada gasta de tu plan de ChatGPT; briefstack no puede leer lo que te queda.');
    expect(en.taskCodexCost).toBe('Each call uses your ChatGPT plan; briefstack cannot read how much you have left.');
    expect(en.taskCancelHint).toContain('stops Codex');
    expect(es.taskCancelHint).toContain('detiene a Codex');
  });
});
