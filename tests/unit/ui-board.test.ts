import { describe, expect, it } from 'vitest';
import { areaPaths, canSwap, columnOf, looksCommaSeparated, type ColumnCard } from '../../src/ui/board.js';

// The board's pure rules (phase 11; review of M4: unit tests of columnOf and canSwap).

describe('columnOf', () => {
  const card = (state: string, dependsOn: number[] = []): ColumnCard => ({ state, dependsOn });

  it('puts a queued card with no dependency in Pending', () => {
    const all = [card('queued')];
    expect(columnOf(all[0] as ColumnCard, all)).toBe('pending');
  });

  it('puts a queued card in Pending only when every dependency is applied, else in Blocked', () => {
    const all = [card('applied'), card('running'), card('queued', [1]), card('queued', [1, 2]), card('queued', [2])];
    expect(all.map((task) => columnOf(task, all))).toEqual(['done', 'running', 'pending', 'blocked', 'blocked']);
  });

  it('counts a dependency that does not exist as not applied (Blocked)', () => {
    const all = [card('queued', [5])];
    expect(columnOf(all[0] as ColumnCard, all)).toBe('blocked');
  });

  it('maps running, waiting and applied to their columns', () => {
    const all = [card('running'), card('waiting'), card('applied')];
    expect(all.map((task) => columnOf(task, all))).toEqual(['running', 'waiting', 'done']);
  });

  it('shows skipped and cancelled cards, and any unknown state, under Skipped', () => {
    const all = [card('skipped', [2]), card('cancelled'), card('something new')];
    expect(all.map((task) => columnOf(task, all))).toEqual(['skipped', 'skipped', 'skipped']);
  });
});

describe('canSwap', () => {
  const items = [
    { key: 10, deps: [] },
    { key: 11, deps: [10] },
    { key: 12, deps: [] },
    { key: 13, deps: [10, 12] },
  ];

  it('refuses to move a card above one it depends on', () => {
    expect(canSwap(items, 0)).toBe(false);
    expect(canSwap(items, 2)).toBe(false);
  });

  it('lets two cards swap when the lower one does not depend on the upper one', () => {
    expect(canSwap(items, 1)).toBe(true);
  });

  it('reads dependencies by key, not by position', () => {
    // 13 depends on 10 and 12: next to 11 it may go above it.
    expect(canSwap([items[1], items[3]] as typeof items, 0)).toBe(true);
  });

  it('is false past either end of the list', () => {
    expect(canSwap(items, -1)).toBe(false);
    expect(canSwap(items, 3)).toBe(false);
    expect(canSwap([], 0)).toBe(false);
  });
});

describe('areaPaths', () => {
  it('reads one path per line, trimmed, without empty lines', () => {
    expect(areaPaths('  src/a.ts \n\n docs/  \r\n')).toEqual(['src/a.ts', 'docs/']);
  });

  it('keeps a comma inside a path: only a new line separates paths (review of M4)', () => {
    expect(areaPaths('docs/a, b.md\nsrc/')).toEqual(['docs/a, b.md', 'src/']);
    expect(areaPaths('notes/one,two.txt')).toEqual(['notes/one,two.txt']);
  });

  it('notices a line that reads like a list, for the page to say paths go one per line', () => {
    expect(looksCommaSeparated('src, tests')).toBe(true);
    expect(looksCommaSeparated('src/\ntests/')).toBe(false);
    expect(looksCommaSeparated('notes/one,two.txt')).toBe(false);
    expect(looksCommaSeparated('')).toBe(false);
  });

  it('is empty for an empty or blank area', () => {
    expect(areaPaths('')).toEqual([]);
    expect(areaPaths(' \n ')).toEqual([]);
  });
});
