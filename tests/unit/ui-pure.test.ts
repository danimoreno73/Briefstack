import { describe, expect, it } from 'vitest';
import { LANGS } from '../../src/i18n/index.js';
import { uiMessages } from '../../src/i18n/ui.js';
import { ApiError } from '../../src/ui/apiError.js';
import { describeError } from '../../src/ui/errors.js';
import {
  formatWhen,
  hasHiddenLines,
  hideSecrets,
  isUnfinished,
  levelIndex,
  openCommandLines,
  pathPieces,
  quotePath,
  stripFrontmatter,
  withoutLeadingHeading,
} from '../../src/ui/format.js';
import { DEFAULT_ROUTE, parseRoute, routeHash, type Route } from '../../src/ui/route.js';

// Built at run time so the test file holds no secret-looking string.
const BS = String.fromCharCode(92);
const FAKE_KEY =['sk', 'ant', 'a'.repeat(30)].join('-');

describe('UI strings', () => {
  it('have the same keys in every language, and functions line up', () => {
    const [first, ...others] = LANGS.map((lang) => uiMessages[lang]);
    for (const other of others) {
      expect(Object.keys(other).sort()).toEqual(Object.keys(first as object).sort());
      for (const key of Object.keys(other) as (keyof typeof other)[]) {
        expect(typeof other[key], key).toBe(typeof (first as typeof other)[key]);
      }
    }
  });
});

describe('routes', () => {
  const routes: Route[] = [
    { page: 'projects' },
    { page: 'project', slug: 'garden-planner' },
    { page: 'new', id: undefined },
    { page: 'new', id: '3f2b9c1e-0000-4a5b' },
    { page: 'library', section: undefined, name: undefined },
    { page: 'library', section: 'history', name: undefined },
    { page: 'library', section: 'profile', name: 'style' },
    { page: 'library', section: 'log', name: 'a b/c' },
    { page: 'usage' },
    { page: 'settings' },
    { page: 'improve', id: undefined },
    { page: 'improve', id: 'imp-abcdef-1234' },
  ];
  it('round-trip through the hash', () => {
    for (const route of routes) expect(parseRoute(routeHash(route))).toEqual(route);
  });
  it('fall back to the projects page', () => {
    for (const hash of ['', '#', '#/', '#/nope', '#/projects/%E0%A4%A']) expect(parseRoute(hash)).toEqual(DEFAULT_ROUTE);
  });
});

describe('quotePath and the open command', () => {
  it('quotes Windows and POSIX paths with spaces', () => {
    const drive = ['C:', 'Users', 'Ana Perez', 'garden'].join(BS);
    expect(quotePath(drive)).toBe(`"${drive}"`);
    const unc = [BS, '', 'server', 'share', 'my project'].join(BS);
    expect(quotePath(unc)).toBe(`"${unc}"`);
    expect(quotePath('/home/ana/my projects/garden')).toBe('"/home/ana/my projects/garden"');
  });
  it('escapes what a POSIX shell reads inside double quotes', () => {
    expect(quotePath('/tmp/a"b$c`d')).toBe(['"/tmp/a', `${BS}"`, 'b', `${BS}$`, 'c', `${BS}${'`'}`, 'd"'].join(''));
  });
  it('puts the quoted path in the cd line', () => {
    expect(openCommandLines('/home/ana/my projects/x', 'claude')).toEqual(['cd "/home/ana/my projects/x"', 'claude']);
  });
});

describe('format helpers', () => {
  it('keeps a plain date and formats a timestamp', () => {
    expect(formatWhen('2026-10-12', 'es')).toBe('2026-10-12');
    expect(formatWhen(undefined, 'en')).toBe('—');
    expect(formatWhen('not a date', 'en')).toBe('not a date');
    expect(formatWhen('2026-10-12T09:30:00Z', 'en')).toMatch(/2026/);
  });
  it('lists interrupted and cancelled sessions apart', () => {
    expect(isUnfinished({ id: 'a', status: 'interrupted' })).toBe(true);
    expect(isUnfinished({ id: 'b', status: 'finished', outcome: 'cancelled' })).toBe(true);
    expect(isUnfinished({ id: 'c', status: 'finished', outcome: 'completed' })).toBe(false);
    expect(isUnfinished({ id: 'd', status: 'in-progress' })).toBe(false);
  });
  it('maps profiles to slider positions', () => {
    expect([levelIndex('saver'), levelIndex('balanced'), levelIndex('max'), levelIndex('mine')]).toEqual([0, 1, 2, undefined]);
  });
  it('hides secret lines and spots hidden ones', () => {
    expect(hideSecrets(`a\nkey ${FAKE_KEY}\nb`)).toBe('a\n[redacted]\nb');
    expect(hasHiddenLines('a\n[redacted]\nb')).toBe(true);
    expect(hasHiddenLines('a [redacted] b')).toBe(false);
  });
  it('strips a leading status block for the preview', () => {
    expect(stripFrontmatter('---\nslug: x\n---\n# Title\n')).toBe('# Title\n');
    expect(stripFrontmatter('# Title\n---\nnot front matter\n')).toBe('# Title\n---\nnot front matter\n');
  });
  it('drops a leading heading only when it repeats the section title', () => {
    expect(withoutLeadingHeading('# Next steps\n\n1. Open it.\n', 'Next steps')).toBe('\n1. Open it.\n');
    expect(withoutLeadingHeading('## next STEPS ##\r\n- a\n', 'Next steps')).toBe('- a\n');
    expect(withoutLeadingHeading('# Siguientes pasos\n- a\n', 'Next steps')).toBe('# Siguientes pasos\n- a\n');
    expect(withoutLeadingHeading('Intro\n# Next steps\n', 'Next steps')).toBe('Intro\n# Next steps\n');
    expect(withoutLeadingHeading('# Next steps', 'Next steps')).toBe('');
  });
  it('cuts a path after each separator, so it wraps between folders', () => {
    expect(pathPieces('/home/me/garden planner')).toEqual(['/', 'home/', 'me/', 'garden planner']);
    const windows = ['C:', 'Users', 'me', 'projects'].join(BS);
    expect(pathPieces(windows)).toEqual([`C:${BS}`, `Users${BS}`, `me${BS}`, 'projects']);
    expect(pathPieces(`${BS}${BS}server${BS}share/x`)).toEqual([BS, BS, `server${BS}`, 'share/', 'x']);
    expect(pathPieces('name').join('')).toBe('name');
    expect(pathPieces('')).toEqual([]);
  });
});

describe('describeError', () => {
  const t = uiMessages.en;
  it('uses the UI text and never the server message or a secret', () => {
    const secret = new ApiError(400, 'library.secretContent', { file: 'f', lines: [3, 5], leaked: FAKE_KEY });
    const text = describeError(secret, t);
    expect(text).toContain('line 3, 5');
    expect(text).not.toContain(FAKE_KEY);
    expect(describeError(new ApiError(400, 'scaffold.forbiddenOutput', { root: 'library' }), t)).toMatch(/library/);
    expect(describeError(new ApiError(400, 'scaffold.notADirectory', {}), t)).toMatch(/file/);
    expect(describeError(new ApiError(500, 'weird.code'), t)).toContain('weird.code');
    expect(describeError(new Error('boom'), t)).not.toContain('boom');
  });
});
