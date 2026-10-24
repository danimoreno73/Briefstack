import { afterEach, describe, expect, it } from 'vitest';
import { BriefstackError, isBriefstackError } from '../../src/errors.js';
import { fetchSkill, gitBlobSha, type FetchOptions } from '../../src/skills/github.js';
import { fakeSha, sampleRepo, startFakeGitHub, type FakeFile, type FakeGitHub, type FakeGitHubOptions } from '../skillsWorld.js';

let gh: FakeGitHub | undefined;
afterEach(async () => {
  await gh?.close();
  gh = undefined;
});

async function world(extra: Record<string, FakeFile | string> = {}, options: FakeGitHubOptions = {}) {
  const sample = sampleRepo(extra);
  gh = await startFakeGitHub({ 'acme/skills': sample.repo }, options);
  const opts: FetchOptions = { apiBase: gh.apiBase, rawBase: gh.rawBase };
  return { gh, opts, commit: sample.commit };
}

async function failure(promise: Promise<unknown>): Promise<BriefstackError> {
  try {
    await promise;
  } catch (error) {
    if (isBriefstackError(error)) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('gitBlobSha', () => {
  it('is git hash-object', () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
});

describe('fetchSkill', () => {
  it('pins a branch to its commit and returns the folder files with the repo-root license', async () => {
    const { opts, commit } = await world();
    const skill = await fetchSkill('https://github.com/acme/skills/tree/main/skills/tool', opts);
    expect(skill).toMatchObject({ owner: 'acme', repo: 'skills', ref: 'main', commit, path: 'skills/tool' });
    expect(skill.files.map((f) => [f.path, f.executable])).toEqual([
      ['SKILL.md', false],
      ['scripts/run.sh', true],
    ]);
    expect(skill.files[1]?.bytes.toString()).toBe('#!/bin/sh\necho hi\n');
    expect(skill.rootLicense?.path).toBe('LICENSE');
    expect(skill.rootLicense?.bytes.toString()).toContain('MIT License');
  });

  it('takes a SKILL.md link, a tag, a short SHA and the repo root (default branch)', async () => {
    const { opts, commit } = await world({ 'SKILL.md': '---\nname: root\ndescription: Root skill.\n---\n' });
    expect((await fetchSkill('https://github.com/acme/skills/blob/v1.0/skills/hello/SKILL.md', opts)).path).toBe('skills/hello');
    expect((await fetchSkill(`https://github.com/acme/skills/tree/${commit.slice(0, 7)}/skills/hello`, opts)).commit).toBe(commit);
    const root = await fetchSkill('https://github.com/acme/skills', opts);
    expect(root).toMatchObject({ ref: 'HEAD', path: '' });
    expect(root.rootLicense).toBeUndefined();
    expect(root.files.some((f) => f.path === 'LICENSE')).toBe(true);
  });

  it('finds a ref with a slash by trying the shortest split first', async () => {
    const { opts, gh: server } = await world();
    const skill = await fetchSkill('https://github.com/acme/skills/tree/feature/x/skills/hello', opts);
    expect(skill).toMatchObject({ ref: 'feature/x', path: 'skills/hello' });
    expect(server.requests.filter((r) => r.includes('/commits/'))).toEqual(['/api/repos/acme/skills/commits/feature', '/api/repos/acme/skills/commits/feature/x']);
  });

  it('downloads only from the pinned commit, walking one folder level at a time', async () => {
    const { opts, gh: server, commit } = await world();
    await fetchSkill('https://github.com/acme/skills/tree/main/skills/hello', opts);
    const api = server.requests.filter((r) => r.startsWith('/api/'));
    expect(api).toHaveLength(4);
    expect(server.requests.filter((r) => r.startsWith('/raw/')).every((r) => r.startsWith(`/raw/acme/skills/${commit}/`))).toBe(true);
  });

  it('reports a missing repo, an unknown ref, a missing folder and a folder with no SKILL.md', async () => {
    const { opts } = await world({ 'docs/readme.md': '# x\n' });
    expect((await failure(fetchSkill('https://github.com/acme/nope/tree/main/x', opts))).code).toBe('skills.repoNotFound');
    expect((await failure(fetchSkill('https://github.com/acme/skills/tree/nope/x', opts))).code).toBe('skills.refNotFound');
    expect((await failure(fetchSkill('https://github.com/acme/skills/tree/main/skills/absent', opts))).code).toBe('skills.pathNotFound');
    expect((await failure(fetchSkill('https://github.com/acme/skills/tree/main/docs', opts))).code).toBe('skills.noSkillFile');
  });

  it('refuses symlinks, submodules, LFS pointers and git control files', async () => {
    const cases: [Record<string, FakeFile | string>, string][] = [
      [{ 'skills/bad/link': { content: '../../etc/passwd', mode: '120000' } }, 'symlink'],
      [{ 'skills/bad/vendor': { content: '', mode: '160000' } }, 'submodule'],
      [{ 'skills/bad/big.bin': 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n' }, 'lfs'],
      [{ 'skills/bad/.gitattributes': '* text eol=crlf\n' }, 'gitControl'],
      [{ 'skills/bad/sub/.GITMODULES': '' }, 'gitControl'],
    ];
    for (const [extra, kind] of cases) {
      const { opts } = await world({ 'skills/bad/SKILL.md': '---\ndescription: x\n---\n', ...extra });
      const error = await failure(fetchSkill('https://github.com/acme/skills/tree/main/skills/bad', opts));
      expect(error.code, kind).toBe('skills.forbiddenEntry');
      expect((error.params as { kind: string }).kind).toBe(kind);
      await gh?.close();
      gh = undefined;
    }
  });

  it('refuses names that are not portable and names that differ only in case', async () => {
    const cases: [Record<string, FakeFile | string>, string][] = [
      [{ 'skills/bad/CON.md': 'x' }, 'unsafePath'],
      [{ 'skills/bad/a:b.md': 'x' }, 'unsafePath'],
      [{ 'skills/bad/trailing. ': 'x' }, 'unsafePath'],
      [{ 'skills/bad/notes.md': 'x', 'skills/bad/NOTES.md': 'y' }, 'caseCollision'],
      [{ 'skills/bad/Docs': 'x', 'skills/bad/docs/a.md': 'y' }, 'caseCollision'],
    ];
    for (const [extra, kind] of cases) {
      const { opts } = await world({ 'skills/bad/SKILL.md': '---\ndescription: x\n---\n', ...extra });
      const error = await failure(fetchSkill('https://github.com/acme/skills/tree/main/skills/bad', opts));
      expect(error.code, kind).toBe('skills.forbiddenEntry');
      expect((error.params as { kind: string }).kind, JSON.stringify(extra)).toBe(kind);
      await gh?.close();
      gh = undefined;
    }
  });

  it('applies the limits on files, file size and total size before downloading', async () => {
    const many = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`skills/hello/f${i}.md`, 'x']));
    const { opts, gh: server } = await world(many);
    const files = await failure(fetchSkill('https://github.com/acme/skills/tree/main/skills/hello', { ...opts, limits: { maxFiles: 3 } }));
    expect(files.params).toMatchObject({ what: 'files', limit: 3, actual: 6 });
    const one = await failure(fetchSkill('https://github.com/acme/skills/tree/main/skills/hello', { ...opts, limits: { maxFileBytes: 20 } }));
    expect(one.params).toMatchObject({ what: 'file', path: 'SKILL.md' });
    const total = await failure(fetchSkill('https://github.com/acme/skills/tree/main/skills/hello', { ...opts, limits: { maxTotalBytes: 100 } }));
    expect(total.params).toMatchObject({ what: 'total', limit: 100 });
    expect(server.requests.some((r) => r.startsWith('/raw/'))).toBe(false);
  });

  it('takes only 40-hex object ids from a listing: a folder sha never shapes the next URL', async () => {
    const { opts, gh: server } = await world();
    const bent: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).includes('/git/trees/')) return response;
      const data = (await response.json()) as { tree: { type: string; sha: string }[] };
      data.tree = data.tree.map((entry) => (entry.type === 'tree' ? { ...entry, sha: '../../../commits/main' } : entry));
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const error = await failure(fetchSkill('https://github.com/acme/skills/tree/main/skills/hello', { ...opts, fetch: bent }));
    expect(error).toMatchObject({ code: 'skills.network', params: { detail: expect.stringContaining('unknown shape') } });
    // Only the pin and the root listing went out; nothing was asked with the bent sha.
    expect(server.requests).toHaveLength(2);
  });

  it('refuses a truncated listing', async () => {
    const { opts } = await world({}, { truncate: true });
    const error = await failure(fetchSkill('https://github.com/acme/skills/tree/main/skills/hello', opts));
    expect(error.params).toMatchObject({ kind: 'truncated' });
  });

  it('refuses bytes that do not match the commit', async () => {
    const { opts } = await world({}, { tamper: new Set(['skills/hello/reference.md']) });
    const error = await failure(fetchSkill('https://github.com/acme/skills/tree/main/skills/hello', opts));
    expect(error.code).toBe('skills.integrity');
    expect(error.params).toEqual({ path: 'reference.md' });
  });

  it('turns a rate limit into a clear error with the reset time', async () => {
    const { opts } = await world({}, { rateLimited: true });
    const error = await failure(fetchSkill('https://github.com/acme/skills/tree/main/skills/hello', opts));
    expect(error.code).toBe('skills.rateLimited');
    expect(error.params).toEqual({ reset: new Date(1792866475 * 1000).toISOString() });
  });

  it('never follows a redirect', async () => {
    const { opts } = await world({}, { redirectRaw: true });
    const error = await failure(fetchSkill('https://github.com/acme/skills/tree/main/skills/hello', opts));
    expect(error.code).toBe('skills.network');
    expect((error.params as { detail: string }).detail).toContain('redirect');
  });

  it('gives up on a slow answer', async () => {
    const { opts } = await world({}, { rawDelayMs: 2000 });
    const error = await failure(fetchSkill('https://github.com/acme/skills/tree/main/skills/hello', { ...opts, limits: { requestTimeoutMs: 100 } }));
    expect(error.code).toBe('skills.network');
    expect((error.params as { detail: string }).detail).toContain('timed out');
  });

  it('a fetch that cannot reach the host fails cleanly', async () => {
    const error = await failure(fetchSkill('https://github.com/acme/skills', { apiBase: 'http://127.0.0.1:1', rawBase: 'http://127.0.0.1:1' }));
    expect(error.code).toBe('skills.network');
  });

  it('a fake commit SHA is 40 hex characters', () => {
    expect(fakeSha('x')).toMatch(/^[0-9a-f]{40}$/);
  });
});
