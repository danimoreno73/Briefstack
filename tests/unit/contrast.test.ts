import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';

// WCAG 2 contrast over the design tokens (BRIEF-ui §7), in both themes. Every
// colour token in tokens.css is `light-dark(light, dark)`; this reads them
// and checks each pair the screens put together: text at least 4.5:1, the
// parts of a control or a status mark at least 3:1.

const TOKENS = readFileSync(path.join(PACKAGE_ROOT, 'src', 'ui', 'static', 'tokens.css'), 'utf8');

type Scheme = 'light' | 'dark';

function readTokens(css: string): Map<string, Record<Scheme, string>> {
  const tokens = new Map<string, Record<Scheme, string>>();
  for (const match of css.matchAll(/--([\w-]+):\s*light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)/gi)) {
    tokens.set(match[1] as string, { light: match[2] as string, dark: match[3] as string });
  }
  return tokens;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** [foreground, background] pairs of text: 4.5:1. */
const TEXT: [string, string][] = [
  ...['ground', 'surface', 'raised', 'attention-bg', 'ok-bg', 'danger-bg'].map((bg): [string, string] => ['text', bg]),
  ...['ground', 'surface', 'raised', 'attention-bg'].map((bg): [string, string] => ['muted', bg]),
  ...['ground', 'surface', 'attention-bg'].map((bg): [string, string] => ['accent', bg]),
  ['danger', 'surface'],
  ['danger', 'ground'],
  ['primary-ink', 'primary'],
  ['on-accent', 'accent'],
  ['danger-ink', 'danger'],
  ['warn-ink', 'warn-bg'],
  ['ok', 'surface'],
];

/** [mark, background] pairs of control edges, focus rings and status marks: 3:1. */
const MARKS: [string, string][] = [
  ['control', 'surface'],
  ['control', 'ground'],
  ...['ground', 'surface', 'attention-bg'].map((bg): [string, string] => ['focus', bg]),
  ['attention-line', 'ground'],
  ...['running', 'waiting', 'ok', 'danger'].map((mark): [string, string] => [mark, 'surface']),
  ['primary', 'surface'],
];

const tokens = readTokens(TOKENS);

describe('design tokens', () => {
  it('reads every colour token as a light-dark pair', () => {
    for (const name of ['ground', 'surface', 'text', 'muted', 'accent', 'control', 'danger', 'primary']) expect(tokens.has(name), name).toBe(true);
  });

  it('computes WCAG contrast', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  for (const scheme of ['light', 'dark'] as const) {
    it(`gives text at least 4.5:1 in ${scheme}`, () => {
      const failures = TEXT.map(([fg, bg]) => ({ fg, bg, ratio: contrast((tokens.get(fg) as Record<Scheme, string>)[scheme], (tokens.get(bg) as Record<Scheme, string>)[scheme]) })).filter(
        (pair) => pair.ratio < 4.5,
      );
      expect(failures).toEqual([]);
    });

    it(`gives control edges, focus and status marks at least 3:1 in ${scheme}`, () => {
      const failures = MARKS.map(([fg, bg]) => ({ fg, bg, ratio: contrast((tokens.get(fg) as Record<Scheme, string>)[scheme], (tokens.get(bg) as Record<Scheme, string>)[scheme]) })).filter(
        (pair) => pair.ratio < 3,
      );
      expect(failures).toEqual([]);
    });
  }
});
