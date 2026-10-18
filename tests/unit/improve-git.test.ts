import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyChanges,
  changedFiles,
  commitWorktree,
  createWorktree,
  currentBranch,
  fileAt,
  git,
  linkNodeModules,
  mergeText,
  removeWorktree,
  revertChangesOf,
  revParse,
  untrackedFiles,
} from '../../src/improve/git.js';
import { tempDir, useHermeticGit } from '../helpers.js';

useHermeticGit();

const AGENT = '.claude/agents/demo.md';
const RULE = 'library/rules/target.md';
const head = (model: string) => `---\nname: demo\ndescription: A demo agent.\ntools: Read\nmodel: ${model}\neffort: medium\n---\n`;
const BODY = ['', ...Array.from({ length: 9 }, (_, i) => `Line ${i + 1} of the body.`), ''].join('\n');
const RULE_TEXT = '# Target rule\n\nOne.\nTwo.\nThree.\nFour.\nFive.\nSix.\n';

let dir: string;
let repo: string;
let cleanup: () => Promise<void>;

async function commitAll(message: string): Promise<string> {
  await git(repo, ['add', '-A']);
  await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', message]);
  return revParse(repo, 'HEAD');
}

const write = (file: string, text: string) => writeFile(path.join(repo, ...file.split('/')), text, 'utf8');
const read = (file: string) => readFile(path.join(repo, ...file.split('/')), 'utf8');

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('improve-git'));
  repo = path.join(dir, 'repo');
  await mkdir(path.join(repo, '.claude', 'agents'), { recursive: true });
  await mkdir(path.join(repo, 'library', 'rules'), { recursive: true });
  await git(repo, ['init', '--quiet', '-b', 'master']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  await write(AGENT, head('opus') + BODY);
  await write(RULE, RULE_TEXT);
  await write('other.txt', 'other\n');
  await write('.gitignore', 'node_modules/\n');
  await commitAll('start');
});

afterEach(async () => {
  await cleanup();
});

describe('worktrees', () => {
  it('creates a worktree outside the repo, commits a round, lists changes and removes it all', async () => {
    const base = await revParse(repo, 'HEAD');
    const wt = path.join(dir, 'worktrees', 'p1');
    await createWorktree(repo, wt, 'improve/p1', base);
    expect(await currentBranch(wt)).toBe('improve/p1');
    expect(await commitWorktree(wt, 'nothing')).toBeUndefined();
    await writeFile(path.join(wt, ...AGENT.split('/')), head('opus') + BODY.replace('Line 2', 'Line two'), 'utf8');
    await writeFile(path.join(wt, 'new.md'), 'new\n', 'utf8');
    expect(await untrackedFiles(wt)).toEqual(['new.md']);
    const round = await commitWorktree(wt, 'Round 1');
    expect(round).toMatch(/^[0-9a-f]{40}$/);
    expect(await changedFiles(repo, base, round as string)).toEqual([
      { path: AGENT, status: 'modified', mode: '100644' },
      { path: 'new.md', status: 'added', mode: '100644' },
    ]);
    expect(await fileAt(repo, round as string, 'new.md')).toBe('new\n');
    expect(await fileAt(repo, base, 'new.md')).toBeUndefined();

    // node_modules is a link the removal takes away without touching what it points to.
    await mkdir(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(repo, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8');
    await linkNodeModules(repo, wt);
    expect((await lstat(path.join(wt, 'node_modules'))).isSymbolicLink()).toBe(true);
    expect(await untrackedFiles(wt)).toEqual([]);

    await removeWorktree(repo, wt, 'improve/p1');
    await expect(stat(wt)).rejects.toThrow();
    expect(await readFile(path.join(repo, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('x');
    expect((await git(repo, ['branch', '--list', 'improve/p1'])).trim()).toBe('');
    // Removing again is fine.
    await removeWorktree(repo, wt, 'improve/p1');
  });
});

describe('mergeText', () => {
  it('merges changes in other lines and refuses the same lines', async () => {
    const base = 'a\nb\nc\nd\ne\nf\ng\n';
    expect(await mergeText(base, base, 'a\nB\nc\nd\ne\nf\ng\n')).toBe('a\nB\nc\nd\ne\nf\ng\n');
    expect(await mergeText('a\nb\nc\nd\ne\nf\nG\n', base, 'a\nB\nc\nd\ne\nf\ng\n')).toBe('a\nB\nc\nd\ne\nf\nG\n');
    expect(await mergeText('a\nX\nc\nd\ne\nf\ng\n', base, 'a\nB\nc\nd\ne\nf\ng\n')).toBeUndefined();
  });
});

describe('applyChanges', () => {
  const change = (proposedBody: string, baseText = head('opus') + BODY) => ({
    path: AGENT,
    bodyOnly: true,
    base: baseText,
    proposed: head('opus') + proposedBody,
  });

  it('commits the body with the committed frontmatter and keeps the uncommitted one on disk', async () => {
    await write(AGENT, head('haiku') + BODY);
    const before = await revParse(repo, 'HEAD');
    const result = await applyChanges(repo, 'master', [change(BODY.replace('Line 2 of', 'Line 2, better, of'))], 'Apply improvement p1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await revParse(repo, 'HEAD')).toBe(result.commit);
    expect(await revParse(repo, 'HEAD^')).toBe(before);
    expect(await fileAt(repo, 'HEAD', AGENT)).toBe(head('opus') + BODY.replace('Line 2 of', 'Line 2, better, of'));
    expect(await read(AGENT)).toBe(head('haiku') + BODY.replace('Line 2 of', 'Line 2, better, of'));
    expect((await git(repo, ['status', '--porcelain'])).trimEnd()).toBe(` M ${AGENT}`);
    expect(await git(repo, ['diff', '--cached'])).toBe('');
    const unstaged = await git(repo, ['diff']);
    expect(unstaged).toMatch(/^-model: opus$/m);
    expect(unstaged).toMatch(/^\+model: haiku$/m);
    expect(unstaged).not.toMatch(/Line 2/);
    expect((await git(repo, ['diff', '--name-only', 'HEAD^', 'HEAD'])).trim()).toBe(AGENT);
    expect((await git(repo, ['log', '-1', '--format=%s'])).trim()).toBe('Apply improvement p1');
  });

  it('merges when master moved in other lines, and refuses the same lines', async () => {
    const base = head('opus') + BODY;
    await write(AGENT, head('opus') + BODY.replace('Line 8 of', 'Line 8, by hand, of'));
    await write('other.txt', 'changed\n');
    await commitAll('hand edit');
    const ok = await applyChanges(repo, 'master', [change(BODY.replace('Line 2 of', 'Line 2, better, of'), base)], 'Apply p2');
    expect(ok.ok).toBe(true);
    const merged = await fileAt(repo, 'HEAD', AGENT);
    expect(merged).toContain('Line 2, better, of');
    expect(merged).toContain('Line 8, by hand, of');
    const refused = await applyChanges(repo, 'master', [change(BODY.replace('Line 8 of', 'Line 8, mine, of'), base)], 'Apply p3');
    expect(refused).toEqual({ ok: false, reason: 'conflict', path: AGENT });
  });

  it('refuses an uncommitted body change, another branch and a missing file, changing nothing', async () => {
    const start = await revParse(repo, 'HEAD');
    await write(AGENT, head('opus') + BODY.replace('Line 5 of', 'Line 5, local, of'));
    expect(await applyChanges(repo, 'master', [change(BODY.replace('Line 2 of', 'x'))], 'A')).toEqual({ ok: false, reason: 'uncommitted', path: AGENT });
    await write(AGENT, head('opus') + BODY);
    expect(await applyChanges(repo, 'master', [{ ...change(BODY), path: 'gone.md' }], 'A')).toEqual({ ok: false, reason: 'missing', path: 'gone.md' });
    await git(repo, ['checkout', '--quiet', '-b', 'other']);
    expect(await applyChanges(repo, 'master', [change(BODY.replace('Line 2 of', 'x'))], 'A')).toEqual({ ok: false, reason: 'wrongBranch', current: 'other' });
    expect(await revParse(repo, 'master')).toBe(start);
  });

  it('applies whole library files, and refuses an uncommitted change anywhere in them', async () => {
    const proposed = RULE_TEXT.replace('Two.', 'Two, clearer.');
    const result = await applyChanges(repo, 'master', [{ path: RULE, bodyOnly: false, base: RULE_TEXT, proposed }], 'Apply rule');
    expect(result.ok).toBe(true);
    expect(await read(RULE)).toBe(proposed);
    expect((await git(repo, ['status', '--porcelain'])).trim()).toBe('');
    await write(RULE, `${proposed}local\n`);
    expect(await applyChanges(repo, 'master', [{ path: RULE, bodyOnly: false, base: proposed, proposed: RULE_TEXT }], 'B')).toEqual({
      ok: false,
      reason: 'uncommitted',
      path: RULE,
    });
  });

  it('reverts an applied change and keeps later ones and the uncommitted frontmatter', async () => {
    const applied = await applyChanges(repo, 'master', [change(BODY.replace('Line 2 of', 'Line 2, better, of'))], 'Apply p1');
    if (!applied.ok) throw new Error('not applied');
    await write(AGENT, head('opus') + BODY.replace('Line 2 of', 'Line 2, better, of').replace('Line 8 of', 'Line 8, later, of'));
    await commitAll('later');
    await write(AGENT, head('haiku') + BODY.replace('Line 2 of', 'Line 2, better, of').replace('Line 8 of', 'Line 8, later, of'));
    const changes = await revertChangesOf(repo, applied.commit, [{ path: AGENT, bodyOnly: true }]);
    const reverted = await applyChanges(repo, 'master', changes, 'Revert p1');
    expect(reverted.ok).toBe(true);
    expect(await fileAt(repo, 'HEAD', AGENT)).toBe(head('opus') + BODY.replace('Line 8 of', 'Line 8, later, of'));
    expect(await read(AGENT)).toBe(head('haiku') + BODY.replace('Line 8 of', 'Line 8, later, of'));
  });
});
