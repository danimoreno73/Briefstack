import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { BriefstackError } from '../../src/errors.js';
import { parseFrontmatter, setFrontmatterFields } from '../../src/frontmatter/index.js';

const AGENT = [
  '---',
  'name: interviewer',
  'description: Gap analysis for a new project idea. Use at the start of /new-project, and again after the user answers.',
  'tools: Read, Grep, Glob',
  '# a comment that must survive',
  'model: sonnet',
  'effort: medium',
  '---',
  '',
  'Body with --- inside',
  '---',
  'and a trailing rule.',
  '',
].join('\n');

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof BriefstackError) return error.code;
    throw error;
  }
  return undefined;
}

describe('parseFrontmatter', () => {
  it('parses fields and keeps the body', () => {
    const parsed = parseFrontmatter(AGENT, 'a.md');
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.data).toMatchObject({ name: 'interviewer', model: 'sonnet', effort: 'medium' });
    expect(parsed.body).toBe('\nBody with --- inside\n---\nand a trailing rule.\n');
  });

  it('handles CRLF and a BOM', () => {
    const text = `\uFEFF${AGENT.replace(/\n/g, '\r\n')}`;
    const parsed = parseFrontmatter(text, 'a.md');
    expect(parsed.data.model).toBe('sonnet');
    expect(parsed.body.startsWith('\r\nBody')).toBe(true);
  });

  it('returns the whole text as body without frontmatter', () => {
    expect(parseFrontmatter('# Title\n', 'a.md')).toEqual({
      hasFrontmatter: false,
      data: {},
      body: '# Title\n',
    });
  });

  it('treats empty frontmatter as no fields', () => {
    expect(parseFrontmatter('---\n---\nbody', 'a.md').data).toEqual({});
  });

  it('reports unclosed, invalid and non-mapping frontmatter', () => {
    expect(errorCode(() => parseFrontmatter('---\nname: x\n', 'a.md'))).toBe(
      'frontmatter.unclosed',
    );
    expect(errorCode(() => parseFrontmatter('---\nname: [x\n---\n', 'a.md'))).toBe(
      'frontmatter.invalidYaml',
    );
    expect(errorCode(() => parseFrontmatter('---\n- a\n- b\n---\n', 'a.md'))).toBe(
      'frontmatter.notAMapping',
    );
  });
});

describe('setFrontmatterFields', () => {
  it('leaves the file byte-for-byte unchanged when values already match', () => {
    expect(setFrontmatterFields(AGENT, { model: 'sonnet', effort: 'medium' }, 'a.md')).toBe(AGENT);
  });

  it('changes only the target lines', () => {
    const updated = setFrontmatterFields(AGENT, { model: 'opus', effort: 'high' }, 'a.md');
    expect(updated).toBe(
      AGENT.replace('model: sonnet', 'model: opus').replace('effort: medium', 'effort: high'),
    );
  });

  it('preserves CRLF line endings and the BOM', () => {
    const crlf = `\uFEFF${AGENT.replace(/\n/g, '\r\n')}`;
    const updated = setFrontmatterFields(crlf, { model: 'haiku' }, 'a.md');
    expect(updated).toBe(crlf.replace('model: sonnet', 'model: haiku'));
  });

  it('appends a missing field before the closing line', () => {
    const text = '---\nname: x\n---\nbody\n';
    expect(setFrontmatterFields(text, { effort: 'low' }, 'a.md')).toBe(
      '---\nname: x\neffort: low\n---\nbody\n',
    );
  });

  it('quotes values that need it', () => {
    const updated = setFrontmatterFields(AGENT, { model: 'a: b' }, 'a.md');
    expect(parseFrontmatter(updated, 'a.md').data.model).toBe('a: b');
  });

  it('accepts full model IDs and bracketed aliases', () => {
    for (const model of ['claude-opus-5-5', 'opus[1m]', 'inherit']) {
      const updated = setFrontmatterFields(AGENT, { model }, 'a.md');
      expect(parseFrontmatter(updated, 'a.md').data.model).toBe(model);
    }
  });

  it('adds frontmatter to a file without it', () => {
    expect(setFrontmatterFields('# Title\r\n', { model: 'opus' }, 'a.md')).toBe(
      '---\r\nmodel: opus\r\n---\r\n# Title\r\n',
    );
  });

  it('refuses to rewrite multi-line values', () => {
    const block = '---\nmodel: |\n  sonnet\n---\n';
    expect(errorCode(() => setFrontmatterFields(block, { model: 'opus' }, 'a.md'))).toBe(
      'frontmatter.blockValue',
    );
    const list = '---\nmodel:\n- sonnet\n---\n';
    expect(errorCode(() => setFrontmatterFields(list, { model: 'opus' }, 'a.md'))).toBe(
      'frontmatter.blockValue',
    );
  });

  it('is a no-op on the repo agent files with their own values', async () => {
    const dir = new URL('../../.claude/agents/', import.meta.url);
    const files = (await readdir(dir)).filter((name) => name.endsWith('.md'));
    expect(files.length).toBe(5);
    for (const name of files) {
      const text = await readFile(new URL(name, dir), 'utf8');
      const { data } = parseFrontmatter(text, name);
      expect(typeof data.model).toBe('string');
      expect(typeof data.effort).toBe('string');
      const fields = { model: data.model as string, effort: data.effort as string };
      expect(setFrontmatterFields(text, fields, name)).toBe(text);
    }
  });
});
