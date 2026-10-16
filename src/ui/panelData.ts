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
  const pending = state.pending;
  if (pending !== undefined && state.status !== 'finished') {
    const agentType = pending.kind === 'permission' ? pending.payload.agentType : undefined;
    live.pending = { id: pending.id, kind: pending.kind as PendingKind, ...(agentType === undefined ? {} : { agentType }) };
  }
  return live;
}

/** `45 s`, `3 min 5 s`, `1 h 2 min`. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
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
