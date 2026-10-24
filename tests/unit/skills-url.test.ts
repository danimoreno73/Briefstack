import { describe, expect, it } from 'vitest';
import { isBriefstackError } from '../../src/errors.js';
import { parseSkillUrl, refCandidates, treeUrl } from '../../src/skills/url.js';

const reason = (url: string): string | undefined => {
  try {
    parseSkillUrl(url);
    return undefined;
  } catch (error) {
    if (isBriefstackError(error) && error.code === 'skills.invalidUrl') return (error.params as { reason: string }).reason;
    throw error;
  }
};

describe('parseSkillUrl', () => {
  it('reads a repo root, a folder at a ref and a SKILL.md link', () => {
    expect(parseSkillUrl('https://github.com/acme/skills')).toMatchObject({ owner: 'acme', repo: 'skills', kind: 'root', rest: [] });
    expect(parseSkillUrl('https://github.com/acme/skills.git')).toMatchObject({ repo: 'skills' });
    expect(parseSkillUrl('https://www.github.com/acme/skills/tree/main/skills/hello')).toMatchObject({ kind: 'tree', rest: ['main', 'skills', 'hello'] });
    expect(parseSkillUrl('https://github.com/acme/skills/blob/v1.0/skills/hello/SKILL.md')).toMatchObject({ kind: 'blob', rest: ['v1.0', 'skills', 'hello'] });
    expect(parseSkillUrl('  https://github.com/acme/skills/tree/main/a%20b?x=1#top ')).toMatchObject({ rest: ['main', 'a b'] });
  });

  it('refuses other hosts, plain http, other shapes and non-SKILL.md files', () => {
    expect(reason('http://github.com/acme/skills')).toBe('notHttps');
    expect(reason('https://gitlab.com/acme/skills')).toBe('notGithub');
    expect(reason('https://github.com.evil.example/acme/skills')).toBe('notGithub');
    expect(reason('https://user:pw@github.com/acme/skills')).toBe('notGithub');
    expect(reason('https://github.com:8443/acme/skills')).toBe('notGithub');
    expect(reason('https://raw.githubusercontent.com/acme/skills/main/SKILL.md')).toBe('notGithub');
    expect(reason('https://github.com/acme')).toBe('shape');
    expect(reason('https://github.com/acme/skills/issues/3')).toBe('shape');
    expect(reason('https://github.com/acme/skills/tree')).toBe('shape');
    // The URL parser resolves dot segments, encoded or not: nothing climbs out of the repo path.
    expect(parseSkillUrl('https://github.com/acme/skills/tree/main/%2e%2e/x').rest).toEqual(['x']);
    expect(reason('https://github.com/acme/skills/tree/main/a%2Fb')).toBe('shape');
    expect(reason('https://github.com/acme/skills/tree/main/a%00b')).toBe('shape');
    expect(reason('https://github.com/-bad/skills')).toBe('shape');
    expect(reason('not a url')).toBe('shape');
    expect(reason(`https://github.com/acme/skills/tree/main/${'a'.repeat(2100)}`)).toBe('shape');
    expect(reason('https://github.com/acme/skills/blob/main/skills/hello/README.md')).toBe('notSkillFile');
    expect(reason('https://github.com/acme/skills/blob/SKILL.md')).toBe('notSkillFile');
  });
});

describe('refCandidates', () => {
  it('splits a slashed ref shortest first, at most five ways', () => {
    expect(refCandidates(parseSkillUrl('https://github.com/a/b'))).toEqual([{ ref: 'HEAD', path: '' }]);
    expect(refCandidates(parseSkillUrl('https://github.com/a/b/tree/feature/x/skills/y'))).toEqual([
      { ref: 'feature', path: 'x/skills/y' },
      { ref: 'feature/x', path: 'skills/y' },
      { ref: 'feature/x/skills', path: 'y' },
      { ref: 'feature/x/skills/y', path: '' },
    ]);
    expect(refCandidates(parseSkillUrl('https://github.com/a/b/tree/1/2/3/4/5/6/7'))).toHaveLength(5);
    expect(refCandidates(parseSkillUrl('https://github.com/a/b/blob/main/SKILL.md'))).toEqual([{ ref: 'main', path: '' }]);
  });
});

describe('treeUrl', () => {
  it('links a folder at a commit, encoding each segment', () => {
    expect(treeUrl('a', 'b', 'c'.repeat(40), 'skills/my skill')).toBe(`https://github.com/a/b/tree/${'c'.repeat(40)}/skills/my%20skill`);
    expect(treeUrl('a', 'b', 'c'.repeat(40), '')).toBe(`https://github.com/a/b/tree/${'c'.repeat(40)}`);
  });
});
