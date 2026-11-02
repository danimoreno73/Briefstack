import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { proposalDiff } from '../../src/tasks/proposal.js';
import { validateTaskDiff } from '../../src/tasks/validate.js';
import { tempDir, useHermeticGit, writeTree } from '../helpers.js';
import { commitAll, gitIn } from '../taskWorld.js';

useHermeticGit();

let dir: string;
let repo: string;
let base: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('tasks-validate'));
  repo = path.join(dir, 'repo');
  await writeTree(repo, { 'src/app.ts': 'export const a = 1;\n', 'notes.md': `Old line with ${path.join(dir, 'old')} in it.\n` });
  await gitIn(repo, 'init', '--quiet', '-b', 'main');
  await gitIn(repo, 'config', 'core.autocrlf', 'false');
  base = await commitAll(repo, 'start');
});

afterEach(() => cleanup());

/** Adds a link as git stores it, without making one on disk (Windows may not allow it). */
async function addLink(file: string, target: string): Promise<void> {
  const sha = (await run(repo, ['hash-object', '-w', '--stdin'], target)).trim();
  await gitIn(repo, 'update-index', '--add', '--cacheinfo', `120000,${sha},${file}`);
}

async function run(cwd: string, args: string[], input: string): Promise<string> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, windowsHide: true }, (error, stdout) => (error === null ? resolve(stdout) : reject(error)));
    child.stdin?.end(input);
  });
}

/**
 * Exactly `count` KB of text in lines of 1 KB. Short lines: the secret and
 * path scans take time that grows with the square of a line's length.
 */
const kilobytes = (char: string, count: number): string => `${char.repeat(1023)}\n`.repeat(count);

const commitIndex = async (message: string) => {
  await gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '--no-verify', '-m', message);
  return (await gitIn(repo, 'rev-parse', 'HEAD')).trim();
};

describe('validateTaskDiff', () => {
  it('finds nothing in a plain change', async () => {
    await writeTree(repo, { 'src/app.ts': 'export const a = 2;\n', 'src/new.ts': 'export {};\n' });
    const head = await commitAll(repo, 'change');
    expect(await validateTaskDiff(repo, base, head)).toEqual([]);
  });

  it('refuses changes to settings, .mcp.json and hook files, and definitions that declare hooks', async () => {
    await writeTree(repo, {
      '.claude/settings.json': '{}\n',
      '.mcp.json': '{}\n',
      '.husky/pre-commit': 'echo\n',
      '.claude/agents/a.md': '---\nname: a\ndescription: x\nhooks: {}\n---\nGo.\n',
      '.claude/skills/s/SKILL.md': '---\nname: s\ndescription: x\n---\nFine.\n',
    });
    const head = await commitAll(repo, 'change');
    const found = await validateTaskDiff(repo, base, head);
    expect(found.filter((item) => item.level === 'error').map((item) => item.file).sort()).toEqual(['.claude/agents/a.md', '.claude/settings.json', '.husky/pre-commit', '.mcp.json']);
    expect(found.every((item) => item.kind === 'settingsOrHooks')).toBe(true);
  });

  it('refuses a link that leads out of the project, not one that stays in it', async () => {
    await addLink('inside', 'src/app.ts');
    await addLink('up', '../../etc/passwd');
    await addLink('rooted', '/etc/passwd');
    const head = await commitIndex('links');
    const found = await validateTaskDiff(repo, base, head);
    expect(found.filter((item) => item.level === 'error').map((item) => [item.file, item.kind, item.detail]).sort()).toEqual([
      ['rooted', 'outsideWorktree', 'link'],
      ['up', 'outsideWorktree', 'link'],
    ]);
  });

  it('warns about added lines that look like secrets or personal paths, not about old ones', async () => {
    const token = ['ghp', 'Zx81Qm4Lr7Tp2Vw9Ks3Nd6Fh0Jb5Yc1Ga8Ue'].join('_');
    await writeTree(repo, {
      'src/app.ts': `export const a = 1;\nexport const key = '${token}';\n`,
      'notes.md': `Old line with ${path.join(dir, 'old')} in it.\nNew line.\n`,
      'docs/where.md': `See ${path.join(path.parse(dir).root, 'Users', 'someone', 'x')}.\n`,
    });
    const head = await commitAll(repo, 'change');
    const found = await validateTaskDiff(repo, base, head, { env: {}, homedir: path.join(dir, 'nohome'), pathApi: path, caseInsensitive: process.platform !== 'linux' });
    expect(found).toContainEqual({ kind: 'secret', level: 'warning', file: 'src/app.ts' });
    expect(found).toContainEqual({ kind: 'personalPath', level: 'warning', file: 'docs/where.md' });
    expect(found.find((item) => item.file === 'notes.md')).toBeUndefined();
    expect(found.every((item) => item.level === 'warning')).toBe(true);
  });

  it('warns about each file the proposal page cannot show: over 256 KB, binary, a link (S10)', async () => {
    await writeTree(repo, {
      'big.txt': `${kilobytes('x', 256)}!`,
      'edge.txt': kilobytes('y', 256),
      'bin/data.bin': 'a\0b',
      'notes.md': 'Plain text.\n',
    });
    await gitIn(repo, 'add', '-A');
    await addLink('inside', 'src/app.ts');
    await addLink('up', '../../etc/passwd');
    const head = await commitIndex('unshown');
    const found = await validateTaskDiff(repo, base, head);
    expect(found.filter((item) => item.kind === 'notShown').map((item) => [item.file, item.level, item.detail]).sort()).toEqual([
      ['big.txt', 'warning', 'large'],
      ['bin/data.bin', 'warning', 'binary'],
      ['inside', 'warning', 'link'],
    ]);
    // A link that leads out is refused, which says more than the warning.
    expect(found.filter((item) => item.file === 'up')).toEqual([{ kind: 'outsideWorktree', level: 'error', file: 'up', detail: 'link' }]);
    // The same files the page lists by name only.
    const diff = await proposalDiff(repo, base, head);
    expect(diff.files.filter((file) => !file.shown).map((file) => file.path).sort()).toEqual(['big.txt', 'bin/data.bin', 'inside', 'up']);
  });

  it('warns about a file that becomes too large or binary, or that was and is deleted', async () => {
    await writeTree(repo, { 'old.bin': '\0old', 'grows.txt': 'small\n' });
    const start = await commitAll(repo, 'start 2');
    await writeTree(repo, { 'grows.txt': kilobytes('z', 300) });
    await gitIn(repo, 'rm', '--quiet', 'old.bin');
    const head = await commitAll(repo, 'change');
    const found = await validateTaskDiff(repo, start, head);
    expect(found.map((item) => [item.file, item.kind, item.detail]).sort()).toEqual([
      ['grows.txt', 'notShown', 'large'],
      ['old.bin', 'notShown', 'binary'],
    ]);
  });

  it('keeps every error when many files only warn', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i += 1) files[`a/${String(i).padStart(2, '0')}.bin`] = `\0${i}`;
    await writeTree(repo, files);
    await gitIn(repo, 'add', '-A');
    await addLink('zz-up', '../outside');
    const head = await commitIndex('many');
    const found = await validateTaskDiff(repo, base, head);
    expect(found).toContainEqual({ kind: 'outsideWorktree', level: 'error', file: 'zz-up', detail: 'link' });
    expect(found.filter((item) => item.level === 'warning')).toHaveLength(50);
  });
});
