import { describe, expect, it } from 'vitest';
import { extractLinks, maskCode, resolvesRelative, resolvesWikilink } from '../../src/validate/index.js';

const paths = {
  files: ['CLAUDE.md', 'docs/BRIEF.md', 'docs/notes/Ideas.md', 'docs/img/plan.png', 'README.md'],
  directories: ['docs', 'docs/notes', 'docs/img'],
};

describe('extractLinks', () => {
  it('finds wikilinks and relative links with line numbers', () => {
    const text = [
      '# Title',
      'See [[Ideas]], [[BRIEF|the brief]] and ![[plan.png]].',
      'Read [the brief](docs/BRIEF.md "Brief") or ![plan](<docs/img/plan.png>).',
      '',
      '[ref]: docs/notes/Ideas.md',
    ].join('\n');
    expect(extractLinks(text)).toEqual([
      { kind: 'wikilink', target: 'Ideas', line: 2 },
      { kind: 'wikilink', target: 'BRIEF|the brief', line: 2 },
      { kind: 'wikilink', target: 'plan.png', line: 2 },
      { kind: 'relative', target: 'docs/BRIEF.md', line: 3 },
      { kind: 'relative', target: 'docs/img/plan.png', line: 3 },
      { kind: 'relative', target: 'docs/notes/Ideas.md', line: 5 },
    ]);
  });

  it('skips URLs, mailto and pure anchors', () => {
    const text = '[a](https://x.org/a.md) [b](http://x) [c](mailto:me@x.org) [d](#top) [e](obsidian://open)';
    expect(extractLinks(text)).toEqual([]);
  });

  it('ignores links in fenced code blocks and inline code', () => {
    const text = [
      'Use `[[not-a-link]]` and ``[x](missing.md)``.',
      '```markdown',
      '[[inside-fence]] [y](missing.md)',
      '```',
      '~~~',
      '[[tilde-fence]]',
      '~~~',
      '[[after]]',
    ].join('\n');
    expect(extractLinks(text)).toEqual([{ kind: 'wikilink', target: 'after', line: 8 }]);
  });

  it('keeps line numbers when masking code', () => {
    expect(maskCode(['```', 'x', '```', 'a `b` c'])).toEqual(['', '', '', 'a     c']);
  });
});

describe('resolvesRelative', () => {
  it('resolves relative to the linking file, with anchors and queries stripped', () => {
    expect(resolvesRelative('BRIEF.md#scope', 'docs/notes/../x.md', paths)).toBe(true);
    expect(resolvesRelative('../CLAUDE.md', 'docs/BRIEF.md', paths)).toBe(true);
    expect(resolvesRelative('notes/Ideas.md?plain=1', 'docs/BRIEF.md', paths)).toBe(true);
    expect(resolvesRelative('./img/', 'docs/BRIEF.md', paths)).toBe(true);
    expect(resolvesRelative('/docs/BRIEF.md', 'docs/notes/Ideas.md', paths)).toBe(true);
    expect(resolvesRelative('..', 'docs/BRIEF.md', paths)).toBe(true);
  });

  it('decodes percent-encoded paths', () => {
    const spaced = { files: ['docs/my notes.md'], directories: ['docs'] };
    expect(resolvesRelative('docs/my%20notes.md', 'CLAUDE.md', spaced)).toBe(true);
  });

  it('reports missing targets, wrong case and links leaving the project', () => {
    expect(resolvesRelative('docs/missing.md', 'CLAUDE.md', paths)).toBe(false);
    expect(resolvesRelative('docs/brief.md', 'CLAUDE.md', paths)).toBe(false);
    expect(resolvesRelative('../../outside.md', 'docs/BRIEF.md', paths)).toBe(false);
  });
});

describe('resolvesWikilink', () => {
  it('resolves by note name anywhere in the project, ignoring case', () => {
    expect(resolvesWikilink('Ideas', paths)).toBe(true);
    expect(resolvesWikilink('ideas', paths)).toBe(true);
    expect(resolvesWikilink('notes/Ideas', paths)).toBe(true);
    expect(resolvesWikilink('BRIEF.md', paths)).toBe(true);
  });

  it('handles aliases, headings, block references and same-note headings', () => {
    expect(resolvesWikilink('BRIEF|the brief', paths)).toBe(true);
    expect(resolvesWikilink('BRIEF\\|escaped in a table', paths)).toBe(true);
    expect(resolvesWikilink('BRIEF#Scope', paths)).toBe(true);
    expect(resolvesWikilink('BRIEF#^block', paths)).toBe(true);
    expect(resolvesWikilink('#Local heading', paths)).toBe(true);
  });

  it('resolves attachments by file name', () => {
    expect(resolvesWikilink('plan.png', paths)).toBe(true);
    expect(resolvesWikilink('plan.jpg', paths)).toBe(false);
  });

  it('reports notes that do not exist', () => {
    expect(resolvesWikilink('Missing note', paths)).toBe(false);
    expect(resolvesWikilink('Ideas2', paths)).toBe(false);
    expect(resolvesWikilink('other/Ideas', paths)).toBe(false);
  });
});
