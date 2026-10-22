import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';

// WCAG 2 contrast over the design tokens (BRIEF-ui §7), in both themes: text
// at least 4.5:1, the parts of a control or a status mark at least 3:1. Two
// sets: bs.css (U5: the shell and the screens moved to it), whose dark values
// sit in `.bs { … }` and light ones in `.bs[data-theme="light"] … { … }`; and
// tokens.css (the `.legacy` screens), where every colour is
// `light-dark(light, dark)`.

const STATIC = path.join(PACKAGE_ROOT, 'src', 'ui', 'static');
const TOKENS = readFileSync(path.join(STATIC, 'tokens.css'), 'utf8');
const BS = readFileSync(path.join(STATIC, 'bs.css'), 'utf8');

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

/** The `--name: #rrggbb` declarations of the first rule whose selector starts with `selector`. */
function readBlock(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector}`);
  if (start === -1) throw new Error(`no rule ${selector}`);
  const open = css.indexOf('{', start);
  const body = css.slice(open + 1, css.indexOf('}', open));
  return new Map([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((match) => [match[1] as string, match[2] as string]));
}

const bsTokens: Record<Scheme, Map<string, string>> = {
  dark: readBlock(BS, '.bs {'),
  light: readBlock(BS, '.bs[data-theme="light"]'),
};

/** [foreground, background] pairs of text on bs.css: 4.5:1. */
const BS_TEXT: [string, string][] = [
  ...['bg', 'rail', 'surface', 'surface-2', 'sunk', 'chip'].map((bg): [string, string] => ['ink', bg]),
  ...['bg', 'rail', 'surface', 'surface-2', 'sunk'].map((bg): [string, string] => ['ink-2', bg]),
  ...['bg', 'rail', 'surface'].map((bg): [string, string] => ['ink-3', bg]),
  ...['bg', 'surface', 'accent-soft'].map((bg): [string, string] => ['accent', bg]),
  ['accent-fill-ink', 'accent-fill'],
  ...['dec', 'dec-2'].map((bg): [string, string] => ['dec-ink', bg]),
  ...['dec', 'dec-2'].map((bg): [string, string] => ['dec-ink-2', bg]),
  ['warn', 'warn-soft'],
  ...['bg', 'surface', 'danger-soft'].map((bg): [string, string] => ['danger', bg]),
  ['danger-fill-ink', 'danger'],
  ['add-ink', 'add-bg'],
  ['del-ink', 'del-bg'],
];

/** [mark, background] pairs of control edges, focus rings and status marks on bs.css: 3:1. */
const BS_MARKS: [string, string][] = [
  ...['bg', 'surface', 'sunk'].map((bg): [string, string] => ['control', bg]),
  ['dec-control', 'dec'],
  ...['bg', 'surface', 'rail'].map((bg): [string, string] => ['focus', bg]),
  ['dec-ink', 'dec'],
  ...['bg', 'surface'].map((bg): [string, string] => ['accent', bg]),
  ...['bg', 'surface'].map((bg): [string, string] => ['danger', bg]),
  ['dec', 'bg'],
];

describe('bs.css tokens', () => {
  it('reads both themes', () => {
    for (const scheme of ['light', 'dark'] as const) for (const name of ['bg', 'surface', 'ink', 'accent', 'dec', 'danger']) expect(bsTokens[scheme].has(name), `${scheme} ${name}`).toBe(true);
  });

  for (const scheme of ['light', 'dark'] as const) {
    const ratio = ([fg, bg]: [string, string]) => {
      const pair = [bsTokens[scheme].get(fg), bsTokens[scheme].get(bg)];
      if (pair[0] === undefined || pair[1] === undefined) throw new Error(`${scheme}: missing ${fg} or ${bg}`);
      return { fg, bg, ratio: Math.round(contrast(pair[0], pair[1]) * 100) / 100 };
    };

    it(`gives text at least 4.5:1 in ${scheme}`, () => {
      expect(BS_TEXT.map(ratio).filter((pair) => pair.ratio < 4.5)).toEqual([]);
    });

    it(`gives control edges, focus and status marks at least 3:1 in ${scheme}`, () => {
      expect(BS_MARKS.map(ratio).filter((pair) => pair.ratio < 3)).toEqual([]);
    });
  }
});

describe('legacy design tokens', () => {
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
