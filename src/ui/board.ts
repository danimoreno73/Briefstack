/**
 * The board's pure rules (phase 11): a card's column, whether two cards may
 * swap on the start page, and the paths of an area as typed. No DOM, so the
 * unit tests read them directly.
 */

export const COLUMNS = ['pending', 'blocked', 'running', 'waiting', 'done', 'skipped'] as const;
export type Column = (typeof COLUMNS)[number];

/** What `columnOf` reads of a started card. */
export interface ColumnCard {
  state: string;
  dependsOn: readonly number[];
}

/** A card's column, from its state and its dependencies' (BRIEF-phase-11 §2, 8; cancelled cards show as skipped). */
export function columnOf(task: ColumnCard, all: readonly ColumnCard[]): Column {
  if (task.state === 'queued') return task.dependsOn.every((n) => all[n - 1]?.state === 'applied') ? 'pending' : 'blocked';
  if (task.state === 'running') return 'running';
  if (task.state === 'waiting') return 'waiting';
  if (task.state === 'applied') return 'done';
  return 'skipped';
}

/** What `canSwap` reads of a card being edited: its key and the keys it depends on. */
export interface SwapCard {
  key: number;
  deps: readonly number[];
}

/**
 * Whether the cards at `upper` and `upper + 1` may swap: a card never goes
 * above one it depends on, as the server takes dependencies on earlier cards
 * only (PLAN-phase-11 §1, 9).
 */
export function canSwap(items: readonly SwapCard[], upper: number): boolean {
  const above = items[upper];
  const below = items[upper + 1];
  return above !== undefined && below !== undefined && !below.deps.includes(above.key);
}

/**
 * The paths of an area as typed: one per line. A comma is part of a path
 * (file names may hold one), so it never splits (review of M4).
 */
export const areaPaths = (text: string): string[] =>
  text
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part !== '');

/**
 * Whether an area as typed has a line that reads like a list ("a, b"): it is
 * taken as one path, so the page says paths go one per line (review of step
 * 39, M3). Only a hint: a path may hold ", ".
 */
export const looksCommaSeparated = (text: string): boolean => areaPaths(text).some((path) => path.includes(', '));
