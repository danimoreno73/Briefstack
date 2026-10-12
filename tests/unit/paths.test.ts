import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome, isFullyAbsolute, isPathInside, toAbsolute } from '../../src/config/paths.js';

const styles = [
  { name: 'win32', pathApi: path.win32, home: 'C:\\Users\\someone', root: 'C:\\' },
  { name: 'posix', pathApi: path.posix, home: '/home/someone', root: '/' },
] as const;

describe.each(styles)('paths ($name)', ({ pathApi, home, root }) => {
  const env = { homedir: home, pathApi };
  const join = (...parts: string[]) => pathApi.join(...parts);

  it('expands a leading ~ with either separator', () => {
    expect(expandHome('~', env)).toBe(home);
    expect(expandHome('~/a/b', env)).toBe(join(home, 'a', 'b'));
    expect(expandHome('~\\a', env)).toBe(join(home, 'a'));
    expect(expandHome('a/~/b', env)).toBe('a/~/b');
    expect(expandHome('~other', env)).toBe('~other');
  });

  it('makes paths absolute and rejects relative ones', () => {
    expect(toAbsolute('~/lib', env)).toBe(join(home, 'lib'));
    expect(toAbsolute(join(root, 'data', '..', 'x'), env)).toBe(join(root, 'x'));
    expect(toAbsolute('relative/dir', env)).toBeUndefined();
    expect(toAbsolute('./dir', env)).toBeUndefined();
  });

  it('detects containment', () => {
    const inside = (child: string, parent: string, caseInsensitive = false) =>
      isPathInside(child, parent, { pathApi, caseInsensitive });
    const repo = join(root, 'work', 'repo');

    expect(inside(repo, repo)).toBe(true);
    expect(inside(join(repo, 'a', 'b'), repo)).toBe(true);
    expect(inside(join(repo, 'a', '..', '..', 'other'), repo)).toBe(false);
    expect(inside(join(root, 'work'), repo)).toBe(false);
    expect(inside(join(root, 'work', 'repo-two'), repo)).toBe(false);
    expect(inside(join(root, 'work', '..repo'), join(root, 'work'))).toBe(true);
    // path.win32 already compares case-insensitively, as Windows does.
    expect(inside(join(root, 'Work', 'Repo', 'x'), repo)).toBe(pathApi === path.win32);
    expect(inside(join(root, 'Work', 'Repo', 'x'), repo, true)).toBe(true);
  });
});

describe('isFullyAbsolute', () => {
  it('needs a drive or a UNC share on Windows', () => {
    for (const ok of ['C:\\Users\\someone', 'C:/Users/someone', 'd:\\x', '\\\\server\\share\\x', '//server/share/x']) {
      expect(isFullyAbsolute(ok, path.win32), ok).toBe(true);
    }
    // `/c/Users/...` is a Git Bash path that reached Windows unconverted:
    // Node would resolve it to `<current drive>:\c\Users\...` (decisions.md, H8).
    for (const bad of ['/c/Users/someone', '\\data', '/', 'C:relative', 'relative', '\\\\server']) {
      expect(isFullyAbsolute(bad, path.win32), bad).toBe(false);
    }
    expect(toAbsolute('/c/Users/someone/.briefstack', { homedir: 'C:\\Users\\someone', pathApi: path.win32 })).toBeUndefined();
  });

  it('accepts any rooted path on POSIX', () => {
    expect(isFullyAbsolute('/c/Users/someone', path.posix)).toBe(true);
    expect(isFullyAbsolute('relative', path.posix)).toBe(false);
  });
});

describe('paths (win32 only)', () => {
  it('treats other drives as outside', () => {
    const env = { pathApi: path.win32, caseInsensitive: true };
    expect(isPathInside('D:\\work\\repo', 'C:\\work\\repo', env)).toBe(false);
  });
});
