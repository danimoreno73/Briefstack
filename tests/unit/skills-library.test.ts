import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BriefstackError, isBriefstackError } from '../../src/errors.js';
import { initLibrary } from '../../src/library/index.js';
import { FakeSkillReviewer } from '../../src/skills/modelReview.js';
import { parseRecord, renderRecord, skillNameFrom } from '../../src/skills/record.js';
import { SkillService, normaliseTags } from '../../src/skills/service.js';
import { tempDir, useHermeticGit } from '../helpers.js';
import { EXFILTRATOR, HARMLESS } from '../skillFixtures.js';
import { fakeSha, sampleRepo, startFakeGitHub, type FakeFile, type FakeGitHub } from '../skillsWorld.js';

useHermeticGit();

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

async function failure(promise: Promise<unknown>): Promise<BriefstackError> {
  try {
    await promise;
  } catch (error) {
    if (isBriefstackError(error)) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

const prefixed = (prefix: string, files: Record<string, string | FakeFile>): Record<string, string | FakeFile> =>
  Object.fromEntries(Object.entries(files).map(([p, v]) => [`${prefix}/${p}`, v]));

describe('skill names', () => {
  it('come from the frontmatter name, else the folder, as a slug', () => {
    expect(skillNameFrom(['PDF Tools', 'x'])).toBe('pdf-tools');
    expect(skillNameFrom([undefined, 'My_Skill'])).toBe('my-skill');
    expect(skillNameFrom(['Ünïcode Name'])).toBe('unicode-name');
    expect(skillNameFrom(['!!!', 'synced', 'files', 'fallback'])).toBe('fallback');
    expect(skillNameFrom(['anthropic-skills-x'])).toBeUndefined();
  });

  it('tags are normalised and checked', () => {
    expect(normaliseTags([' Writing ', 'notes', 'writing', 'two words'])).toEqual(['writing', 'notes', 'two-words']);
    expect(() => normaliseTags(['bad!'])).toThrow(BriefstackError);
    expect(() => normaliseTags(Array.from({ length: 11 }, (_, i) => `t${i}`))).toThrow(BriefstackError);
  });
});

describe('SkillService', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let libraryDir: string;
  let gh: FakeGitHub;
  let service: SkillService;
  let reviewer: FakeSkillReviewer;
  let clock = 0;
  let commit: string;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('skills-lib'));
    libraryDir = path.join(dir, 'library');
    await initLibrary({ libraryDir, projectsDir: path.join(dir, 'projects'), sessionsDir: path.join(dir, 'sessions'), repoDir: path.join(dir, 'repo') });
    const sample = sampleRepo({ ...prefixed('skills/tidy', HARMLESS), ...prefixed('skills/sync', EXFILTRATOR), 'skills/tidy-2/SKILL.md': '---\nname: tidy-notes\ndescription: Another.\n---\n' });
    commit = sample.commit;
    gh = await startFakeGitHub({ 'acme/skills': sample.repo });
    reviewer = new FakeSkillReviewer((input) => (input.scripts.length > 0 ? { harmful: true, reason: 'The script posts ~/.ssh/id_rsa.' } : { harmful: false, reason: 'Plain instructions.' }));
    clock = 0;
    service = new SkillService({
      libraryDir: async () => libraryDir,
      fetch: { apiBase: gh.apiBase, rawBase: gh.rawBase },
      reviewer,
      now: () => new Date(Date.UTC(2026, 9, 24, 10, 0, clock++)),
    });
  });
  afterEach(async () => {
    await gh.close();
    await cleanup();
  });

  const lastCommit = () => git(libraryDir, ['log', '-1', '--format=%s']).trim();
  const committedFiles = () => git(libraryDir, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort();

  it('adds a skill into quarantine: files exactly as fetched, a metadata note, one commit', async () => {
    const result = await service.add('https://github.com/acme/skills/tree/main/skills/tidy', ['Notes']);
    expect(result.committed).toBe(true);
    const record = result.detail?.record;
    expect(record).toMatchObject({ name: 'tidy-notes', status: 'quarantine', tags: ['notes'], hasScripts: false, network: false });
    expect(record?.source).toMatchObject({ repo: 'acme/skills', path: 'skills/tidy', ref: 'main', commit, link: `https://github.com/acme/skills/tree/${commit}/skills/tidy` });
    expect(record?.license).toEqual({ spdx: 'MIT', source: 'file', file: 'LICENSE' });
    expect(record?.model).toMatchObject({ state: 'clear', model: 'haiku' });
    const base = path.join(libraryDir, 'skills', 'tidy-notes');
    expect(await readFile(path.join(base, 'files', 'SKILL.md'), 'utf8')).toBe(HARMLESS['SKILL.md']);
    const note = await readFile(path.join(base, 'tidy-notes.md'), 'utf8');
    expect(parseRecord(note, 'x')).toEqual(record);
    expect(note).toContain('# tidy-notes');
    expect(lastCommit()).toBe('library: add skill tidy-notes (quarantine)');
    expect(committedFiles()).toEqual(['skills/tidy-notes/files/LICENSE', 'skills/tidy-notes/files/SKILL.md', 'skills/tidy-notes/files/guide.md', 'skills/tidy-notes/tidy-notes.md']);
    // Not listed in INDEX.md: the interviewer and the architect read it.
    expect(await readFile(path.join(libraryDir, 'INDEX.md'), 'utf8')).not.toContain('tidy-notes');
    expect(git(libraryDir, ['status', '--porcelain']).trim()).toBe('');
  });

  it('records scripts, network, findings and the model flag of a malicious skill', async () => {
    const result = await service.add('https://github.com/acme/skills/tree/main/skills/sync');
    const record = result.detail?.record;
    expect(record).toMatchObject({ name: 'sync-helper', hasScripts: true, network: true });
    expect(record?.model).toMatchObject({ state: 'flagged' });
    expect(record?.findings.some((f) => f.rule === 'credentials' && f.file === 'scripts/sync.sh')).toBe(true);
    expect(reviewer.inputs.at(-1)?.scripts.map((s) => s.path)).toEqual(['scripts/steal.py', 'scripts/sync.sh']);
    // The executable bit is kept in the record, the bytes as they were.
    expect(record?.files.find((f) => f.path === 'scripts/sync.sh')?.executable).toBe(true);
  });

  it('refuses a second skill with the same name, saying whether it is the same source', async () => {
    await service.add('https://github.com/acme/skills/tree/main/skills/tidy');
    expect((await failure(service.add('https://github.com/acme/skills/tree/v1.0/skills/tidy'))).params).toEqual({ name: 'tidy-notes', sameSource: true });
    expect((await failure(service.add('https://github.com/acme/skills/tree/main/skills/tidy-2'))).params).toEqual({ name: 'tidy-notes', sameSource: false });
  });

  it('lists, shows, approves, rejects, tags and deletes, one commit each', async () => {
    await service.add('https://github.com/acme/skills/tree/main/skills/tidy');
    await service.add('https://github.com/acme/skills/tree/main/skills/sync');
    expect((await service.list()).map((s) => [s.name, s.status, s.hasScripts])).toEqual([
      ['sync-helper', 'quarantine', true],
      ['tidy-notes', 'quarantine', false],
    ]);
    expect(await service.approvedIndex()).toEqual([]);

    await service.approve('tidy-notes');
    expect(lastCommit()).toBe('library: approve skill tidy-notes');
    expect((await failure(service.approve('tidy-notes'))).code).toBe('skills.wrongStatus');
    await service.setTags('tidy-notes', ['meetings', 'notes']);
    expect(lastCommit()).toBe('library: tag skill tidy-notes');
    expect(await service.approvedIndex()).toEqual([{ name: 'tidy-notes', description: 'Tidies meeting notes into decisions and actions. Use after a meeting.', tags: ['meetings', 'notes'] }]);

    await service.reject('sync-helper');
    expect((await service.get('sync-helper')).record.status).toBe('rejected');
    await service.approve('sync-helper');
    await service.reject('sync-helper');

    await service.remove('sync-helper');
    expect(lastCommit()).toBe('library: delete skill sync-helper');
    await expect(stat(path.join(libraryDir, 'skills', 'sync-helper'))).rejects.toThrow();
    expect((await failure(service.get('sync-helper'))).code).toBe('skills.notFound');
    expect(git(libraryDir, ['status', '--porcelain']).trim()).toBe('');
  });

  it('refuses to approve files that changed since the review, and to install unapproved or changed files', async () => {
    await service.add('https://github.com/acme/skills/tree/main/skills/tidy');
    expect((await failure(service.approvedFiles('tidy-notes'))).code).toBe('skills.notApproved');
    const file = path.join(libraryDir, 'skills', 'tidy-notes', 'files', 'guide.md');
    await writeFile(file, 'changed\n', 'utf8');
    expect((await failure(service.approve('tidy-notes'))).params).toEqual({ name: 'tidy-notes', path: 'guide.md' });
    await writeFile(file, HARMLESS['guide.md'] as string, 'utf8');
    await service.approve('tidy-notes');
    expect((await service.approvedFiles('tidy-notes')).record.name).toBe('tidy-notes');
    await writeFile(path.join(libraryDir, 'skills', 'tidy-notes', 'files', 'extra.md'), 'x', 'utf8');
    expect((await failure(service.approvedFiles('tidy-notes'))).params).toEqual({ name: 'tidy-notes', path: 'extra.md' });
  });

  it('reads a file of a version and never sends a binary', async () => {
    await service.add('https://github.com/acme/skills/tree/main/skills/tidy');
    expect(await service.readFile('tidy-notes', 'guide.md')).toMatchObject({ kind: 'markdown', text: HARMLESS['guide.md'] });
    expect((await failure(service.readFile('tidy-notes', '../../INDEX.md'))).code).toBe('skills.fileNotFound');
    expect((await failure(service.get('../x'))).code).toBe('skills.notFound');
  });

  it('a new version: only for approved skills, into quarantine next to the approved one, with a diff; approve or reject it', async () => {
    await service.add('https://github.com/acme/skills/tree/main/skills/tidy');
    expect((await failure(service.checkUpdate('tidy-notes'))).code).toBe('skills.wrongStatus');
    await service.approve('tidy-notes');
    expect((await service.checkUpdate('tidy-notes')).outcome).toBe('upToDate');

    // The branch moves on: guide.md changes and a script appears.
    const repo = gh.repos.get('acme/skills');
    if (repo === undefined) throw new Error('no repo');
    const second = fakeSha('sample-2');
    const files = { ...(repo.commits[commit]?.files ?? {}), 'skills/tidy/guide.md': '# Guide\n\nKeep each action short.\n', 'skills/tidy/run.sh': { content: '#!/bin/sh\necho\n', mode: '100755' as const } };
    repo.commits[second] = { files };
    repo.refs.main = second;

    const update = await service.checkUpdate('tidy-notes');
    expect(update.outcome).toBe('updated');
    expect(lastCommit()).toBe('library: new version of skill tidy-notes (quarantine)');
    const detail = update.detail;
    expect(detail?.record.status).toBe('approved');
    expect(detail?.record.source.commit).toBe(commit);
    expect(detail?.record.next?.source.commit).toBe(second);
    expect(detail?.record.next?.hasScripts).toBe(true);
    expect(detail?.diff?.map((d) => [d.path, d.change])).toEqual([
      ['guide.md', 'changed'],
      ['run.sh', 'added'],
    ]);
    expect(detail?.diff?.[0]?.hunks?.[0]?.lines.map((l) => `${l.op}${l.text}`)).toContain('+Keep each action short.');
    // The architect still sees the approved version only.
    expect((await service.approvedIndex())[0]?.name).toBe('tidy-notes');
    expect((await service.list())[0]?.update).toBe(true);
    expect((await failure(service.checkUpdate('tidy-notes'))).code).toBe('skills.updatePending');

    await service.rejectUpdate('tidy-notes');
    expect((await service.get('tidy-notes')).record.next).toBeUndefined();
    await expect(stat(path.join(libraryDir, 'skills', 'tidy-notes', 'next'))).rejects.toThrow();

    await service.checkUpdate('tidy-notes');
    await service.approveUpdate('tidy-notes');
    const after = (await service.get('tidy-notes')).record;
    expect(after).toMatchObject({ status: 'approved', hasScripts: true });
    expect(after.source.commit).toBe(second);
    expect(after.next).toBeUndefined();
    expect(await readdir(path.join(libraryDir, 'skills', 'tidy-notes'))).toEqual(['files', 'tidy-notes.md']);
    expect(await readFile(path.join(libraryDir, 'skills', 'tidy-notes', 'files', 'guide.md'), 'utf8')).toContain('short');
    expect((await failure(service.approveUpdate('tidy-notes'))).code).toBe('skills.noUpdate');
    expect(git(libraryDir, ['status', '--porcelain']).trim()).toBe('');
  });

  it('a skill added at a commit is pinned: there is nothing newer to look for', async () => {
    await service.add(`https://github.com/acme/skills/tree/${commit}/skills/tidy`);
    await service.approve('tidy-notes');
    expect((await service.checkUpdate('tidy-notes')).outcome).toBe('pinned');
  });

  it('a skill with its own .gitignore still has every file committed', async () => {
    const repo = gh.repos.get('acme/skills');
    if (repo === undefined) throw new Error('no repo');
    const files = repo.commits[commit]?.files ?? {};
    files['skills/ign/SKILL.md'] = '---\nname: ign\ndescription: x\n---\n';
    files['skills/ign/.gitignore'] = '*.log\n';
    files['skills/ign/notes.log'] = 'kept\n';
    await service.add('https://github.com/acme/skills/tree/main/skills/ign');
    expect(committedFiles()).toContain('skills/ign/files/notes.log');
  });

  it('a metadata note survives a round trip and a hand edit that breaks it makes the skill unreadable', async () => {
    const result = await service.add('https://github.com/acme/skills/tree/main/skills/tidy');
    const record = result.detail?.record;
    if (record === undefined) throw new Error('no record');
    expect(parseRecord(renderRecord(record), 'x')).toEqual(record);
    await writeFile(path.join(libraryDir, 'skills', 'tidy-notes', 'tidy-notes.md'), '---\nname: tidy-notes\n---\n', 'utf8');
    expect((await failure(service.get('tidy-notes'))).code).toBe('skills.unreadable');
    expect(await service.list()).toEqual([]);
  });
});
