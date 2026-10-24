import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli.js';
import { BriefstackError, isBriefstackError } from '../../src/errors.js';
import { parseFrontmatter } from '../../src/frontmatter/index.js';
import { initLibrary } from '../../src/library/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { scaffold } from '../../src/scaffold/index.js';
import { FakeSkillReviewer } from '../../src/skills/modelReview.js';
import { INSTALL_RECORD, installSkills, nextStepsWithSkill, readInstalled } from '../../src/skills/install.js';
import { SkillService } from '../../src/skills/service.js';
import { readZip } from '../../src/skills/zip.js';
import { parseSpec, type SpecInput } from '../../src/spec/index.js';
import { validateProject } from '../../src/validate/index.js';
import { baseProfiles, specInput, tempDir, useHermeticGit } from '../helpers.js';
import { EXFILTRATOR, HARMLESS } from '../skillFixtures.js';
import { sampleRepo, startFakeGitHub, type FakeGitHub } from '../skillsWorld.js';

useHermeticGit();

async function failure(promise: Promise<unknown>): Promise<BriefstackError> {
  try {
    await promise;
  } catch (error) {
    if (isBriefstackError(error)) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

const prefixed = (prefix: string, files: object) => Object.fromEntries(Object.entries(files).map(([p, v]) => [`${prefix}/${p}`, v as string]));

describe('skills install', { timeout: 60_000 }, () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let libraryDir: string;
  let gh: FakeGitHub;
  let service: SkillService;
  let home: string;

  const spec = (overrides: Partial<SpecInput>) => parseSpec(specInput(overrides), 'spec.json');
  const make = async (name: string, overrides: Partial<SpecInput>) => {
    const outDir = path.join(dir, 'projects', name);
    await scaffold(spec({ slug: name, ...overrides }), outDir, {
      protectedDirs: [{ root: 'library', path: libraryDir }],
      templateRoots: [path.join(PACKAGE_ROOT, 'library', 'templates')],
      profiles: await baseProfiles(),
      gitInit: false,
    });
    await mkdir(path.join(outDir, '.git'));
    return outDir;
  };

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('skills-install'));
    home = path.join(dir, 'home');
    libraryDir = path.join(home, 'library');
    await initLibrary({ libraryDir, projectsDir: path.join(dir, 'projects'), sessionsDir: path.join(home, 'sessions'), repoDir: path.join(dir, 'repo') });
    gh = await startFakeGitHub({ 'acme/skills': sampleRepo({ ...prefixed('skills/tidy', HARMLESS), ...prefixed('skills/sync', EXFILTRATOR) }).repo });
    service = new SkillService({ libraryDir: async () => libraryDir, fetch: { apiBase: gh.apiBase, rawBase: gh.rawBase }, reviewer: new FakeSkillReviewer() });
    await service.add('https://github.com/acme/skills/tree/main/skills/tidy');
    await service.approve('tidy-notes');
    await service.add('https://github.com/acme/skills/tree/main/skills/sync');
  }, 60_000);
  afterEach(async () => {
    await gh.close();
    await cleanup();
  });

  it('copies an approved skill into .claude/skills byte for byte, records it, and the agent preloads it', async () => {
    const project = await make('garden', {
      agents: [{ name: 'notetaker', description: 'Takes notes.', tools: ['Read'], tier: 'light' }],
      librarySkills: [{ name: 'tidy-notes', reason: 'Meetings produce notes to tidy.', agent: 'notetaker' }],
    });
    const agent = await readFile(path.join(project, '.claude', 'agents', 'notetaker.md'), 'utf8');
    expect(parseFrontmatter(agent, 'a').data.skills).toEqual(['tidy-notes']);

    const before = await validateProject(project);
    expect(before.findings.map((f) => f.rule)).toContain('librarySkill.notInstalled');

    const result = await installSkills({ projectDir: project, skills: service });
    expect(result.installed.map((e) => [e.name, e.location, e.agent])).toEqual([['tidy-notes', '.claude/skills/tidy-notes', 'notetaker']]);
    for (const [file, content] of Object.entries(HARMLESS)) {
      expect(await readFile(path.join(project, '.claude', 'skills', 'tidy-notes', file), 'utf8')).toBe(content);
    }
    const recorded = await readInstalled(project);
    expect(recorded[0]).toMatchObject({ name: 'tidy-notes', repo: 'acme/skills', path: 'skills/tidy', license: 'MIT' });
    expect((await validateProject(project)).findings).toEqual([]);

    // Installing again does nothing.
    const again = await installSkills({ projectDir: project, skills: service });
    expect(again).toMatchObject({ installed: [], already: ['tidy-notes'] });
  });

  it('the validator catches an edited, added or removed file in an installed skill, and leaves its text alone otherwise', async () => {
    const project = await make('edited', { librarySkills: [{ name: 'tidy-notes', reason: 'Notes.' }] });
    await installSkills({ projectDir: project, skills: service });
    const base = path.join(project, '.claude', 'skills', 'tidy-notes');
    // The author's own text (a link to a missing file, a TODO) is not the validator's business.
    expect((await validateProject(project)).findings).toEqual([]);
    await writeFile(path.join(base, 'guide.md'), 'edited\n', 'utf8');
    await writeFile(path.join(base, 'extra.md'), 'x\n', 'utf8');
    const findings = (await validateProject(project)).findings.filter((f) => f.rule === 'librarySkill.modified');
    expect(findings.map((f) => f.params)).toEqual(expect.arrayContaining([{ name: 'tidy-notes', path: 'guide.md' }, { name: 'tidy-notes', path: 'extra.md' }]));
    await writeFile(path.join(project, ...INSTALL_RECORD.split('/')), '{', 'utf8');
    expect((await validateProject(project)).findings.map((f) => f.rule)).toContain('librarySkill.invalidRecord');
  });

  it('for a claude-app project writes a ZIP with the skill folder at its root and a line in NEXT_STEPS.md', async () => {
    const project = await make('app', { target: 'claude-app', language: 'es', librarySkills: [{ name: 'tidy-notes', reason: 'Notas.' }] });
    await installSkills({ projectDir: project, skills: service });
    const zip = readZip(await readFile(path.join(project, 'skills', 'tidy-notes.zip')));
    expect(zip.map((e) => e.path).sort()).toEqual(['tidy-notes/LICENSE', 'tidy-notes/SKILL.md', 'tidy-notes/guide.md']);
    expect(zip.find((e) => e.path === 'tidy-notes/SKILL.md')?.bytes.toString()).toBe(HARMLESS['SKILL.md']);
    const steps = await readFile(path.join(project, 'NEXT_STEPS.md'), 'utf8');
    expect(steps).toContain('## Skills');
    expect(steps).toContain('`skills/tidy-notes.zip`');
    expect(steps).toContain('Upload a skill');
    expect((await validateProject(project)).findings).toEqual([]);
    await writeFile(path.join(project, 'NEXT_STEPS.md'), '# Pasos\n', 'utf8');
    expect((await validateProject(project)).findings.map((f) => f.rule)).toEqual(['librarySkill.nextSteps']);
  });

  it('the same files always give the same ZIP', async () => {
    const a = await make('app-a', { target: 'claude-app', librarySkills: [{ name: 'tidy-notes', reason: 'x' }] });
    const b = await make('app-b', { target: 'claude-app', librarySkills: [{ name: 'tidy-notes', reason: 'x' }] });
    await installSkills({ projectDir: a, skills: service });
    await installSkills({ projectDir: b, skills: service });
    expect(await readFile(path.join(a, 'skills', 'tidy-notes.zip'))).toEqual(await readFile(path.join(b, 'skills', 'tidy-notes.zip')));
  });

  it('adds one skill to an existing project with --skill, and never twice', async () => {
    const project = await make('existing', {});
    const result = await installSkills({ projectDir: project, skills: service, only: 'tidy-notes' });
    expect(result.installed[0]?.agent).toBeUndefined();
    expect((await failure(installSkills({ projectDir: project, skills: service, only: 'tidy-notes' }))).code).toBe('skills.alreadyInstalled');
    expect((await validateProject(project)).findings).toEqual([]);
  });

  it('refuses unapproved skills, existing folders, non-projects and protected folders', async () => {
    const project = await make('refusals', {});
    expect((await failure(installSkills({ projectDir: project, skills: service, only: 'sync-helper' }))).code).toBe('skills.notApproved');
    await mkdir(path.join(project, '.claude', 'skills', 'tidy-notes'), { recursive: true });
    expect((await failure(installSkills({ projectDir: project, skills: service, only: 'tidy-notes' }))).params).toEqual({ path: '.claude/skills/tidy-notes' });
    expect(await readdir(path.join(project, '.claude', 'skills', 'tidy-notes'))).toEqual([]);
    expect(await readInstalled(project)).toEqual([]);
    const plain = path.join(dir, 'plain');
    await mkdir(plain);
    expect((await failure(installSkills({ projectDir: plain, skills: service }))).code).toBe('skills.notAProject');
    expect((await failure(installSkills({ projectDir: path.join(dir, 'nope'), skills: service }))).code).toBe('skills.projectNotFound');
    expect((await failure(installSkills({ projectDir: project, skills: service, protectedDirs: [{ root: 'library', path: path.join(dir, 'projects') }] }))).code).toBe('scaffold.forbiddenOutput');
  });

  it('refuses library files that changed after approval, and leaves nothing behind', async () => {
    const project = await make('tampered', { librarySkills: [{ name: 'tidy-notes', reason: 'x' }] });
    await writeFile(path.join(libraryDir, 'skills', 'tidy-notes', 'files', 'guide.md'), 'tampered\n', 'utf8');
    expect((await failure(installSkills({ projectDir: project, skills: service }))).code).toBe('skills.modified');
    await expect(stat(path.join(project, '.claude', 'skills', 'tidy-notes'))).rejects.toThrow();
  });

  it.runIf(process.platform !== 'win32')('never writes through a symlinked .claude/skills that leads out of the project', async () => {
    const project = await make('linked', {});
    const outside = path.join(dir, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(project, '.claude', 'skills'));
    expect((await failure(installSkills({ projectDir: project, skills: service, only: 'tidy-notes' }))).code).toBe('skills.wouldOverwrite');
    expect(await readdir(outside)).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')('keeps the executable bit of scripts', async () => {
    await service.approve('sync-helper');
    const project = await make('exec', {});
    await installSkills({ projectDir: project, skills: service, only: 'sync-helper' });
    const mode = (await stat(path.join(project, '.claude', 'skills', 'sync-helper', 'scripts', 'sync.sh'))).mode;
    expect(mode & 0o111).not.toBe(0);
    await chmod(path.join(project, '.claude', 'skills', 'sync-helper', 'scripts', 'sync.sh'), 0o644);
  });

  it('runs from the CLI against the library of the config', async () => {
    const project = await make('cli', { librarySkills: [{ name: 'tidy-notes', reason: 'x' }] });
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIO = {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      cwd: dir,
      pathEnv: { env: { BRIEFSTACK_HOME: home, BRIEFSTACK_LANG: 'en' }, homedir: path.join(dir, 'user'), pathApi: path, caseInsensitive: process.platform !== 'linux' },
    };
    expect(await main(['skills', 'install', project], io)).toBe(0);
    expect(out.join('\n')).toContain('Installed tidy-notes in .claude/skills/tidy-notes');
    expect(await main(['skills', 'install', project, '--skill', 'sync-helper'], io)).toBe(1);
    expect(err.join('\n')).toContain('only approved skills can be installed');
    expect(await main(['skills', 'list'], io)).toBe(2);
  });
});

describe('nextStepsWithSkill', () => {
  it('adds the section once and one line per archive inside it', () => {
    const first = nextStepsWithSkill('# Next steps\n\n## Start\n\nOpen the app.\n', '- `skills/a.zip`: a', 'en');
    expect(first).toMatch(/## Skills\n\nSkills from your library[^\n]*\n\n- `skills\/a.zip`: a\n$/);
    const second = nextStepsWithSkill(`${first}\n## Later\n\nMore.\n`, '- `skills/b.zip`: b', 'en');
    expect(second).toContain('- `skills/a.zip`: a\n- `skills/b.zip`: b\n\n## Later');
  });
});
