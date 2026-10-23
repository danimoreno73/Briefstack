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
 * The marks under the timeline: round values (1, 2 or 5 times a power of
 * ten) from 0 up to the span, five at most, never two alike; each with its
 * place as a percentage of the span. Minutes from two minutes up, seconds
 * below, in the language's decimal mark. The unit goes with the axis's name,
 * so the marks stay short.
 */
export function timelineTicks(spanMs: number, lang = 'en'): { unit: 'min' | 's'; ticks: { label: string; at: number }[] } {
  const span = Number.isFinite(spanMs) && spanMs > 0 ? spanMs : 0;
  const minutes = span >= 120_000;
  const unit = minutes ? 'min' : 's';
  if (span === 0) return { unit, ticks: [{ label: '0', at: 0 }] };
  const inUnit = span / (minutes ? 60_000 : 1000);
  // The smallest round step that leaves five marks at most (four steps from 0).
  const power = 10 ** Math.floor(Math.log10(inUnit / 5));
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((candidate) => Math.floor(inUnit / candidate + 1e-9) <= 4) ?? 10 * power;
  const digits = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const number = new Intl.NumberFormat(lang, { maximumFractionDigits: digits });
  const ticks: { label: string; at: number }[] = [];
  for (let index = 0; index * step <= inUnit + 1e-9 && index <= 4; index += 1) {
    const value = Number((index * step).toFixed(digits));
    ticks.push({ label: number.format(value), at: Math.min(100, (value / inUnit) * 100) });
  }
  return { unit, ticks };
}

/**
 * A duration as a clock reads it, for the timeline's narrow column: `4:00`,
 * `8:09`, `1:02:03`. Under a minute it stays in seconds (`45 s`, `2.4 s`).
 */
export function formatClockDuration(ms: number | undefined, lang = 'en'): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 60_000) return formatDuration(ms, lang);
  const seconds = Math.floor(ms / 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
}

/** What a segment of the progress bar shows. */
export type StepLook = 'done' | 'now' | 'todo' | 'fail' | 'halt';

/** The word a segment says for screen readers: a step state, or what the bar infers. */
export type StepWord = 'waiting' | 'running' | 'ok' | 'skipped' | 'failed' | 'passed' | 'stopped' | 'interrupted';

/**
 * How each step reads once the states are known. A step before the furthest
 * one reached was passed, even with no event of its own (sessions recorded
 * before step events, or cut short); it reads as done. A step still running
 * after the session ended is where it stopped: neutral after a cancel, coral
 * after an interruption or a failure, never cream, which means "waiting for
 * you". `ended` is the outcome once the session is over, `undefined` while
 * it runs.
 */
export function stepLooks(states: readonly string[], ended: string | undefined): { look: StepLook; word: StepWord }[] {
  let reached = -1;
  states.forEach((state, index) => {
    if (state !== 'waiting') reached = index;
  });
  return states.map((state, index): { look: StepLook; word: StepWord } => {
    if (state === 'ok' || state === 'skipped') return { look: 'done', word: state };
    if (state === 'failed') return { look: 'fail', word: 'failed' };
    if (state === 'running') {
      if (ended === undefined) return { look: 'now', word: 'running' };
      if (ended === 'completed') return { look: 'done', word: 'passed' };
      return ended === 'cancelled' ? { look: 'halt', word: 'stopped' } : { look: 'fail', word: 'interrupted' };
    }
    return index < reached ? { look: 'done', word: 'passed' } : { look: 'todo', word: 'waiting' };
  });
}

/**
 * The name each node is shown with: the main session's label, or the agent's
 * type; when a type ran more than once (two interviewer rounds), each run is
 * numbered in order: `interviewer · 1`, `interviewer · 2`.
 */
export function nodeLabels(nodes: readonly { id: string; kind: 'main' | 'agent'; agentType: string }[], mainLabel: string): Map<string, string> {
  const totals = new Map<string, number>();
  for (const node of nodes) if (node.kind === 'agent') totals.set(node.agentType, (totals.get(node.agentType) ?? 0) + 1);
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind === 'main') {
      labels.set(node.id, mainLabel);
      continue;
    }
    const type = node.agentType || '?';
    const run = (seen.get(node.agentType) ?? 0) + 1;
    seen.set(node.agentType, run);
    labels.set(node.id, (totals.get(node.agentType) ?? 0) > 1 ? `${type} · ${run}` : type);
  }
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
