import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareContext } from '../../src/improve/filters.js';
import { git, revParse } from '../../src/improve/git.js';
import { validateRound } from '../../src/improve/validate.js';
import { makeImproveRepo, RESEARCHER, researcherRound, testGit } from '../improveWorld.js';
import { tempDir, useHermeticGit } from '../helpers.js';

useHermeticGit();

let dir: string;
let repo: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('improve-validate'));
  repo = path.join(dir, 'repo');
  await makeImproveRepo(repo);
});

afterEach(async () => {
  await cleanup();
});

const file = (relative: string) => path.join(repo, ...relative.split('/'));
const context = () => prepareContext({ homedir: path.join(dir, 'user'), username: undefined, folders: [], profileTexts: [] });

async function round(): Promise<{ base: string; head: string }> {
  const base = await revParse(repo, 'HEAD');
  const { edits } = researcherRound();
  const edit = edits[0] as { file: string; find: string; replace: string };
  await writeFile(file(edit.file), (await readFile(file(edit.file), 'utf8')).replace(edit.find, edit.replace), 'utf8');
  await testGit(repo, ['add', '-A']);
  return { base, head: base };
}

async function commit(message: string): Promise<string> {
  await testGit(repo, ['commit', '--quiet', '-m', message]);
  return revParse(repo, 'HEAD');
}

describe('validateRound', () => {
  it('accepts a plain body edit', async () => {
    const { base } = await round();
    const head = await commit('round');
    const check = await validateRound({ repoDir: repo, baseCommit: base, head, worktreeDir: repo, submission: researcherRound().submission, context: context() });
    expect(check.problems).toEqual([]);
  });

  it('rejects a change of the file mode, such as the executable bit', async () => {
    const { base } = await round();
    await git(repo, ['update-index', '--chmod=+x', '--', RESEARCHER]);
    const head = await commit('round');
    const check = await validateRound({ repoDir: repo, baseCommit: base, head, worktreeDir: repo, submission: researcherRound().submission, context: context() });
    expect(check.problems.map((p) => `${p.kind}:${p.file ?? ''}`)).toEqual([`mode:${RESEARCHER}`]);
  });
});
