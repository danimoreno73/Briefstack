import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PathEnv } from '../../src/config/index.js';
import { isBriefstackError } from '../../src/errors.js';
import { FakeImprovementRunner, type FakeImproveScript } from '../../src/improve/fakeRunner.js';
import { git, revParse } from '../../src/improve/git.js';
import { ImprovementManager } from '../../src/improve/manager.js';
import { FakeRealCheckRunner } from '../../src/improve/realCheck.js';
import { ImproveStore } from '../../src/improve/store.js';
import { FakeVerifier } from '../../src/improve/verify.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { tempDir, useHermeticGit } from '../helpers.js';

useHermeticGit();

const RESEARCHER = '.claude/agents/researcher.md';
const INTERVIEWER = '.claude/agents/interviewer.md';
const RULE = 'library/rules/target.md';
const SKILL = '.claude/skills/new-project/SKILL.md';

let dir: string;
let repo: string;
let home: string;
let cleanup: () => Promise<void>;
let blockers: string[];
let manager: ImprovementManager | undefined;

const read = (file: string) => readFile(path.join(repo, ...file.split('/')), 'utf8');
const write = (file: string, text: string) => writeFile(path.join(repo, ...file.split('/')), text, 'utf8');
const exists = (target: string) => stat(target).then(() => true, () => false);

async function commitAll(message: string): Promise<void> {
  await git(repo, ['add', '-A']);
  await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', message]);
}

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('improve-manager'));
  repo = path.join(dir, 'repo');
  home = path.join(dir, 'home');
  for (const folder of ['.claude/agents', '.claude/skills', 'library/rules']) {
    await cp(path.join(PACKAGE_ROOT, ...folder.split('/')), path.join(repo, ...folder.split('/')), { recursive: true });
  }
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await write('src/cli.ts', 'export {};\n');
  await write('.gitignore', 'node_modules/\n');
  await git(repo, ['init', '--quiet', '-b', 'master']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  await commitAll('start');
  await mkdir(path.join(home, 'library', 'profile'), { recursive: true });
  await writeFile(path.join(home, 'library', 'profile', 'style.md'), '---\nsummary: Style\n---\n# Style\n\nI always want answers written as a haiku about mountains.\n', 'utf8');
  blockers = [];
  manager = undefined;
});

afterEach(async () => {
  await manager?.shutdown();
  await cleanup();
});

const submission = (files: string[], title = 'Shorter research reports') => ({
  title,
  expectedEffect: 'Reports half as long.',
  changes: files.map((file) => ({ file, rationale: 'Two review rounds said the report was too long.', evidence: ['sessions/s1.json'] })),
});

const researcherEdit = { file: RESEARCHER, find: 'Never fill a gap with a guess.', replace: 'Never fill a gap with a guess. Keep the report under one page.' };

async function open(script: FakeImproveScript, extra: { verifier?: FakeVerifier; realChecks?: FakeRealCheckRunner; holdStarts?: <T>(task: () => Promise<T>) => Promise<T> } = {}) {
  const runner = new FakeImprovementRunner(script);
  const verifier = extra.verifier ?? new FakeVerifier();
  const pathEnv: PathEnv = { env: { BRIEFSTACK_HOME: home }, homedir: path.join(dir, 'user'), pathApi: path, caseInsensitive: process.platform !== 'linux' };
  manager = await ImprovementManager.open({
    store: new ImproveStore(path.join(home, 'improve')),
    repoDir: repo,
    runner,
    verifier,
    ...(extra.realChecks === undefined ? {} : { realChecks: extra.realChecks }),
    pathEnv,
    locations: async () => ({ home, libraryDir: path.join(home, 'library'), projectsDir: path.join(dir, 'projects'), sessionsDir: path.join(home, 'sessions') }),
    profile: async () => ({ model: 'haiku', effort: 'low' }),
    blockers: async () => blockers,
    ...(extra.holdStarts === undefined ? {} : { holdStarts: extra.holdStarts }),
    gatePollMs: 20,
  });
  return { manager, runner, verifier };
}

async function settled(id: string) {
  for (let i = 0; i < 1500; i += 1) {
    const view = await (manager as ImprovementManager).get(id);
    if (view.status !== 'preparing' && view.status !== 'verifying') return view;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('never settled');
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return isBriefstackError(error) ? error.code : String(error);
  }
}

describe('ImprovementManager', { timeout: 60_000 }, () => {
  it('prepares a proposal in a worktree outside the repo, validates and tests it', async () => {
    const { manager: m, runner, verifier } = await open({ rounds: [{ edits: [researcherEdit], submission: submission([RESEARCHER]) }] });
    const started = await m.prepare('Make research reports shorter.', { lessons: false });
    expect(started.status).toBe('preparing');
    const view = await settled(started.id);
    expect(view.status).toBe('ready');
    expect(view.title).toBe('Shorter research reports');
    expect(view.validation).toEqual({ ok: true, problems: [] });
    expect(view.checks?.ok).toBe(true);
    expect(view.files.map((f) => [f.path, f.kind, f.added, f.removed, f.rationale])).toEqual([[RESEARCHER, 'agent', 1, 1, 'Two review rounds said the report was too long.']]);
    expect(view).not.toHaveProperty('worktreeDir');
    const start = runner.started[0];
    expect(start?.model).toBe('haiku');
    expect(path.relative(repo, start?.worktreeDir ?? '').startsWith('..')).toBe(true);
    expect(await readFile(path.join(start?.evidenceDir ?? '', 'request.md'), 'utf8')).toContain('Make research reports shorter.');
    expect(verifier.calls).toEqual([start?.worktreeDir]);
    expect((await git(repo, ['branch', '--list', `improve/${started.id}`])).trim()).not.toBe('');
    // Nothing touched the repo's own working tree.
    expect((await git(repo, ['status', '--porcelain'])).trim()).toBe('');
  });

  it('approves as one commit on master, removes the worktree, and reverts with one more', async () => {
    const { manager: m, runner } = await open({ rounds: [{ edits: [researcherEdit], submission: submission([RESEARCHER]) }] });
    const { id } = await m.prepare('Shorter reports.');
    await settled(id);
    const before = await revParse(repo, 'HEAD');
    const applied = await m.approve(id);
    expect(applied.status).toBe('applied');
    expect(await revParse(repo, 'HEAD^')).toBe(before);
    expect(await revParse(repo, 'HEAD')).toBe(applied.appliedCommit);
    expect((await git(repo, ['log', '-1', '--format=%B'])).trim()).toMatch(new RegExp(`^Apply improvement ${id}: Shorter research reports[^]*Briefstack-Improvement: ${id}$`));
    expect(await read(RESEARCHER)).toContain('Keep the report under one page.');
    expect((await git(repo, ['status', '--porcelain'])).trim()).toBe('');
    expect(await exists(runner.started[0]?.worktreeDir ?? '')).toBe(false);
    expect((await git(repo, ['branch', '--list', `improve/${id}`])).trim()).toBe('');

    const reverted = await m.revert(id);
    expect(reverted.status).toBe('reverted');
    expect(await revParse(repo, 'HEAD^')).toBe(applied.appliedCommit);
    expect(await read(RESEARCHER)).not.toContain('Keep the report under one page.');
    expect((await git(repo, ['log', '-1', '--format=%s'])).trim()).toBe(`Revert improvement ${id}: Shorter research reports`);
    expect(await codeOf(m.revert(id))).toBe('improve.wrongState');
  });

  it('keeps uncommitted usage set changes in the frontmatter when it applies', async () => {
    const { manager: m } = await open({ rounds: [{ edits: [researcherEdit], submission: submission([RESEARCHER]) }] });
    const { id } = await m.prepare('Shorter reports.');
    await settled(id);
    const original = await read(RESEARCHER);
    await write(RESEARCHER, original.replace(/^model: .*$/m, 'model: haiku-test'));
    await m.approve(id);
    const onDisk = await read(RESEARCHER);
    expect(onDisk).toMatch(/^model: haiku-test$/m);
    expect(onDisk).toContain('Keep the report under one page.');
    expect(await git(repo, ['show', `HEAD:${RESEARCHER}`])).not.toContain('haiku-test');
    expect((await git(repo, ['status', '--porcelain'])).trimEnd()).toBe(` M ${RESEARCHER}`);
  });

  it('waits while a creation runs and applies once none does', async () => {
    const { manager: m } = await open({ rounds: [{ edits: [researcherEdit], submission: submission([RESEARCHER]) }] });
    const { id } = await m.prepare('Shorter reports.');
    await settled(id);
    blockers = ['A meal planner'];
    const before = await revParse(repo, 'HEAD');
    expect((await m.approve(id)).status).toBe('waiting');
    expect(await m.blockers()).toEqual(['A meal planner']);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await revParse(repo, 'HEAD')).toBe(before);
    blockers = [];
    for (let i = 0; i < 1500 && (await m.get(id)).status === 'waiting'; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await m.get(id)).status).toBe('applied');
    expect(await revParse(repo, 'HEAD^')).toBe(before);
  });

  it('applies and reverts while creation starts are held, and looks for running creations inside that hold', async () => {
    const events: string[] = [];
    let startJustBefore = true;
    const holdStarts = async <T,>(task: () => Promise<T>): Promise<T> => {
      events.push('hold');
      // A creation that registered just before the hold was taken: the check inside it must see it.
      if (startJustBefore) {
        blockers = ['A meal planner'];
        startJustBefore = false;
      }
      try {
        return await task();
      } finally {
        events.push('release');
      }
    };
    const { manager: m } = await open({ rounds: [{ edits: [researcherEdit], submission: submission([RESEARCHER]) }] }, { holdStarts });
    const { id } = await m.prepare('Shorter reports.');
    await settled(id);
    expect((await m.approve(id)).status).toBe('waiting');
    expect(events).toEqual(['hold', 'release']);
    blockers = [];
    for (let i = 0; i < 1500 && (await m.get(id)).status === 'waiting'; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await m.get(id)).status).toBe('applied');
    expect(events.slice(-2)).toEqual(['hold', 'release']);
    events.length = 0;
    expect((await m.revert(id)).status).toBe('reverted');
    expect(events).toEqual(['hold', 'release']);
  });

  it('refuses the approval when master changed the file, even in other lines, and a new round starts from the current master', async () => {
    const { manager: m, verifier } = await open({
      rounds: [
        { edits: [researcherEdit], submission: submission([RESEARCHER]) },
        { edits: [], submission: submission([RESEARCHER], 'Shorter reports, again') },
      ],
    });
    const { id } = await m.prepare('Shorter reports.');
    await settled(id);
    await write(RESEARCHER, (await read(RESEARCHER)).replace('Do not download or run anything.', 'Never download or run anything.'));
    await commitAll('hand edit');
    const tip = await revParse(repo, 'HEAD');
    expect(await codeOf(m.approve(id))).toBe('improve.baseChanged');
    expect(await revParse(repo, 'HEAD')).toBe(tip);
    const refused = await m.get(id);
    expect(refused.status).toBe('ready');
    expect(refused.error).toContain(RESEARCHER);

    await m.askChanges(id, 'Prepare it again on the current branch.');
    const again = await settled(id);
    expect(again.status).toBe('ready');
    expect(again.baseCommit).toBe(tip);
    expect(verifier.calls).toHaveLength(2);
    expect(again.files[0]?.base).toContain('Never download or run anything.');
    await m.approve(id);
    expect(await revParse(repo, 'HEAD^')).toBe(tip);
    const applied = await read(RESEARCHER);
    expect(applied).toContain('Keep the report under one page.');
    expect(applied).toContain('Never download or run anything.');
  });

  it('rejects a change to a locked block, a forbidden path, a new file and personal data, without testing', async () => {
    const verifier = new FakeVerifier();
    const { manager: m } = await open(
      {
        rounds: [
          {
            edits: [
              { file: SKILL, find: 'Never ask in plain text and never end the turn instead.', replace: 'Ask in plain text when unsure.' },
              { file: 'src/cli.ts', text: 'export const x = 1;\n' },
              { file: 'library/rules/new.md', text: 'new\n' },
              { file: RULE, find: '# ', replace: `See ${path.join(dir, 'user', 'notes.md')}\n\n# ` },
              { file: INTERVIEWER, find: 'Rules:', replace: 'I always want answers written as a haiku about mountains.\n\nRules:' },
            ],
            submission: submission([SKILL, 'src/cli.ts', RULE, INTERVIEWER]),
          },
        ],
      },
      { verifier },
    );
    const { id } = await m.prepare('Do it.');
    const view = await settled(id);
    expect(view.status).toBe('rejected');
    const kinds = (view.validation?.problems ?? []).map((p) => `${p.kind}:${p.file ?? ''}`).sort();
    expect(kinds).toEqual([`forbiddenPath:src/cli.ts`, `locked:${SKILL}`, `notModified:library/rules/new.md`, `personalPath:${RULE}`, `profileText:${INTERVIEWER}`]);
    expect(verifier.calls).toEqual([]);
    expect(await codeOf(m.approve(id))).toBe('improve.wrongState');
  });

  it('rejects a file the session left where git ignores it, listed before the round is committed', async () => {
    await write('.gitignore', 'node_modules/\n*.local.md\n');
    await commitAll('ignore local notes');
    const { manager: m, verifier } = await open({
      rounds: [{ edits: [researcherEdit, { file: 'notes.local.md', text: 'hidden\n' }, { file: 'library/rules/new.md', text: 'new\n' }], submission: submission([RESEARCHER]) }],
    });
    const view = await settled((await m.prepare('x')).id);
    expect(view.status).toBe('rejected');
    expect((view.validation?.problems ?? []).map((p) => `${p.kind}:${p.file ?? ''}`).sort()).toEqual(['forbiddenPath:notes.local.md', 'notModified:library/rules/new.md']);
    expect(verifier.calls).toEqual([]);
  });

  it('rejects a frontmatter change and a round with no changes', async () => {
    const { manager: m } = await open({
      rounds: [
        { edits: [{ file: RESEARCHER, find: 'tools:', replace: 'tools: Bash,' }], submission: submission([RESEARCHER]) },
      ],
    });
    const { id } = await m.prepare('x');
    const view = await settled(id);
    expect(view.validation?.problems.map((p) => p.kind)).toEqual(['frontmatter']);

    const second = await open({ rounds: [{ text: 'Nothing to change.' }] });
    const empty = await settled((await second.manager.prepare('y')).id);
    expect(empty.status).toBe('rejected');
    expect(empty.validation?.problems.map((p) => p.kind)).toEqual(['noChanges']);
    expect(empty.rounds[0]?.outcome).toBe('noProposal');
    expect(empty.rounds[0]?.text).toBe('Nothing to change.');
  });

  it('runs another round on the same branch when asked for changes', async () => {
    const { manager: m, runner } = await open({
      rounds: [
        { edits: [researcherEdit], submission: submission([RESEARCHER]) },
        { edits: [{ file: RULE, find: '# ', replace: '# ' }, { file: RESEARCHER, find: 'under one page', replace: 'under half a page' }], submission: submission([RESEARCHER], 'Even shorter') },
      ],
    });
    const { id } = await m.prepare('Shorter reports.');
    await settled(id);
    await m.askChanges(id, 'Even shorter, please.');
    const view = await settled(id);
    expect(view.status).toBe('ready');
    expect(view.rounds.map((r) => [r.n, r.feedback, r.outcome])).toEqual([
      [1, undefined, 'submitted'],
      [2, 'Even shorter, please.', 'submitted'],
    ]);
    expect(runner.started[1]?.feedback).toBe('Even shorter, please.');
    expect(runner.started[1]?.worktreeDir).toBe(runner.started[0]?.worktreeDir);
    expect(view.title).toBe('Even shorter');
    await m.approve(id);
    expect(await read(RESEARCHER)).toContain('under half a page');
    expect((await git(repo, ['log', '--format=%s', '-2'])).trim().split('\n')).toEqual([`Apply improvement ${id}: Even shorter`, 'start']);
  });

  it('discards: removes the worktree and the branch', async () => {
    const { manager: m, runner } = await open({ rounds: [{ edits: [researcherEdit], submission: submission([RESEARCHER]) }] });
    const { id } = await m.prepare('x');
    await settled(id);
    expect((await m.discard(id)).status).toBe('discarded');
    expect(await exists(runner.started[0]?.worktreeDir ?? '')).toBe(false);
    expect((await git(repo, ['branch', '--list', `improve/${id}`])).trim()).toBe('');
    expect(await codeOf(m.approve(id))).toBe('improve.wrongState');
  });

  it('runs one session at a time, and a restart marks an interrupted one failed', async () => {
    const { manager: m } = await open({ rounds: [{ hold: true }] });
    const { id } = await m.prepare('x');
    expect(m.activeId()).toBe(id);
    expect(await codeOf(m.prepare('y'))).toBe('improve.busy');
    await m.shutdown();
    // A stopped session ends as failed; a record a crash left as preparing is fixed on open.
    const store = new ImproveStore(path.join(home, 'improve'));
    const record = await store.load(id);
    if (record === undefined) throw new Error('missing');
    record.status = 'preparing';
    delete record.rounds[0]?.endedAt;
    await store.save(record);
    const reopened = await open({ rounds: [] });
    const view = await reopened.manager.get(id);
    expect(view.status).toBe('failed');
    expect(view.rounds[0]?.outcome).toBe('interrupted');
  });

  it('fails when the tests fail, and offers and runs the matching real check', async () => {
    const failing = new FakeVerifier([{ ok: false, steps: [{ name: 'test', ok: false, ms: 5, tail: '1 failed' }] }]);
    const first = await open({ rounds: [{ edits: [researcherEdit], submission: submission([RESEARCHER]) }] }, { verifier: failing });
    const failed = await settled((await first.manager.prepare('x')).id);
    expect(failed.status).toBe('failed');
    expect(failed.checks?.steps[0]?.tail).toBe('1 failed');
    await first.manager.shutdown();

    const realChecks = new FakeRealCheckRunner({ ok: true, output: 'PASS  interviewer target' });
    const { manager: m } = await open(
      { rounds: [{ edits: [{ file: INTERVIEWER, find: 'Rules:', replace: 'Rules (keep them):' }], submission: submission([INTERVIEWER]) }] },
      { realChecks },
    );
    const { id } = await m.prepare('Interviewer.');
    const view = await settled(id);
    expect(view.offeredCheck).toBe('interviewer-target');
    await m.startCheck(id);
    for (let i = 0; i < 1500 && (await m.get(id)).realCheck?.state === 'running'; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await m.get(id)).realCheck).toMatchObject({ name: 'interviewer-target', state: 'passed', output: 'PASS  interviewer target' });
    expect(realChecks.calls[0]?.name).toBe('interviewer-target');
  });
});
