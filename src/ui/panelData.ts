import type { PanelEventInput, PanelLive, PanelTarget, PendingKind } from '../panel/state.js';
import type { CreationState, StreamEvent } from './types.js';

/**
 * Glue between the page and the pure panel state (`src/panel/state.ts`):
 * the lines a creation stream carries, what the creation state adds live,
 * and short texts. Pure, so it is tested without a browser.
 */

/** The `events.jsonl` lines a creation stream has carried, in order, each once (by sequence number). */
export function panelEventsFromStream(events: readonly StreamEvent[]): PanelEventInput[] {
  const seen = new Set<number>();
  const lines: PanelEventInput[] = [];
  for (const event of events) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    if (event.kind === 'flow') lines.push({ ...event.data, ts: (event.data as { ts?: string }).ts ?? event.ts, source: 'flow' });
    else if (event.kind === 'hook') lines.push({ ...event.data, ts: (event.data as { ts?: string }).ts ?? event.ts, source: 'hook' } as PanelEventInput);
    else if (event.kind === 'runner') lines.push({ ...event.data, ts: (event.data as { ts?: string }).ts ?? event.ts, source: 'runner' } as PanelEventInput);
  }
  return lines;
}

/** What the creation's state says that the lines do not: finished or not, and who is asked what. */
export function liveFromState(state: CreationState): PanelLive {
  const live: PanelLive = { finished: state.status === 'finished' };
  if (state.outcome !== undefined) live.outcome = state.outcome;
  if (state.cancelling === true) live.cancelling = true;
  if (state.usageReading === true) live.usageReading = true;
  const pending = state.pending;
  if (pending !== undefined && state.status !== 'finished') {
    const agentType = pending.kind === 'permission' ? pending.payload.agentType : undefined;
    live.pending = { id: pending.id, kind: pending.kind as PendingKind, ...(agentType === undefined ? {} : { agentType }) };
  }
  return live;
}

/**
 * `< 0.1 s`, `2.4 s`, `45 s`, `3 min 5 s`, `1 h 2 min`. Under ten seconds with
 * a tenth, in the language's decimal mark, so short runs do not all read
 * `0 s` beside bars of very different lengths (audit L10).
 */
export function formatDuration(ms: number | undefined, lang = 'en'): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 10_000) {
    const tenths = new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return ms < 100 ? `< ${tenths.format(0.1)} s` : `${tenths.format(Math.floor(ms / 100) / 10)} s`;
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** A clock time in the viewer's zone, for a timestamp. */
export function formatClock(value: string | undefined, lang: string): string {
  if (value === undefined) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

/**
 * A target as text. `outside` never has a path; every other root names where
 * the path is relative to.
 */
export function targetText(target: PanelTarget | undefined, labels: { outside: string; root: (root: string) => string }): string | undefined {
  if (target === undefined) return undefined;
  if (target.root === 'outside') return labels.outside;
  if (target.root === 'cli') return `briefstack ${target.path ?? ''}`.trim();
  return target.path === undefined ? labels.root(target.root) : `${labels.root(target.root)}: ${target.path}`;
}

/** Percent with no decimals, or `?`. */
export function percent(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '?' : `${Math.round(value)}%`;
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/**
 * One plan-usage meter: where the window was at the start and where it is
 * now, each 0–100, and the change in whole points. `undefined` when either
 * reading lacks the window.
 */
export function usageMeter(start: number | null | undefined, now: number | null | undefined): { start: number; now: number; delta: number } | undefined {
  if (start === null || start === undefined || !Number.isFinite(start)) return undefined;
  const latest = now === null || now === undefined || !Number.isFinite(now) ? start : now;
  return { start: clampPercent(start), now: clampPercent(latest), delta: Math.round(latest) - Math.round(start) };
}

/**
 * Five labels under the timeline, from 0 to its span: whole minutes from two
 * minutes up, whole seconds from ten seconds, tenths of a second below (in
 * the language's decimal mark); the unit only on the last label.
 */
export function timelineTicks(spanMs: number, lang = 'en'): string[] {
  const span = Number.isFinite(spanMs) && spanMs > 0 ? spanMs : 0;
  const minutes = span >= 120_000;
  const unit = minutes ? 60_000 : 1000;
  const digits = span >= 10_000 ? 0 : 1;
  const number = new Intl.NumberFormat(lang, { maximumFractionDigits: digits });
  const labels = [0, 1, 2, 3, 4].map((quarter) => number.format((span * quarter) / 4 / unit));
  labels[4] = `${labels[4]} ${minutes ? 'min' : 's'}`;
  return labels;
}

/** A timeline row's position as percentages of the span: never past the end, never thinner than a sliver. */
export function barGeometry(startMs: number, endMs: number, spanMs: number): { left: number; width: number } {
  if (!(spanMs > 0)) return { left: 0, width: 100 };
  const left = clampPercent((startMs / spanMs) * 100);
  const width = Math.min(100 - left, Math.max(0.5, ((endMs - startMs) / spanMs) * 100));
  return { left, width };
}

/** The 1-based position of a step in the flow, for "step 3 / 9"; `undefined` for an unknown step. */
export function stepNumber(steps: readonly string[], step: string | undefined): number | undefined {
  if (step === undefined) return undefined;
  const index = steps.indexOf(step);
  return index === -1 ? undefined : index + 1;
}
