import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../src/frontmatter/index.js';
import {
  DENY_RULES,
  buildPlan,
  checkOutputDir,
  loadTemplate,
  renderTemplate,
  scaffold,
  type ProtectedDir,
  type ScaffoldOptions,
  type Template,
} from '../../src/scaffold/index.js';
import { parseSpec, type SpecInput } from '../../src/spec/index.js';
import { baseProfiles, specInput, tempDir, writeTree } from '../helpers.js';

const spec = (overrides: Partial<SpecInput> = {}) => parseSpec(specInput(overrides), 'spec.json');

const TEMPLATE_TREE = {
  'generic/common/CLAUDE.md': '# {{name}}\n\n{{summary}}\n\n## Done when\n\n{{doneWhen}}\n{{unknown}}\n',
  'generic/common/docs/BRIEF.md': '# Brief: {{name}}\n\n{{deliverables}}\n',
  'generic/claude-app/INSTRUCTIONS.md': 'Instructions for {{name}}\n',
  'generic/claude-app/NEXT_STEPS.md': 'Steps\n\n{{scheduledTasks}}\n',
  'generic/claude-code/docs/BRIEF.md': '# Brief (claude-code): {{name}}\n',
  'generic/common/.gitignore': 'node_modules/\n',
};

describe('renderTemplate', () => {
  it('fills known placeholders and leaves unknown ones', () => {
    expect(renderTemplate('{{ name }} / {{other}} / {{name}}', { name: 'X' })).toBe('X / {{other}} / X');
  });

  it('does not treat inherited properties as variables', () => {
    expect(renderTemplate('{{constructor}}', {})).toBe('{{constructor}}');
  });
});

describe('loadTemplate', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('templates'));
  });
  afterEach(() => cleanup());

  it('merges common and target folders, target winning', async () => {
    await writeTree(path.join(dir, 'base'), TEMPLATE_TREE);
    const code = await loadTemplate('generic', 'claude-code', [path.join(dir, 'base')]);
    expect(code.files.map((file) => file.path)).toEqual(['.gitignore', 'CLAUDE.md', 'docs/BRIEF.md']);
    expect(code.files.find((file) => file.path === 'docs/BRIEF.md')?.content).toContain('claude-code');

    const app = await loadTemplate('generic', 'claude-app', [path.join(dir, 'base')]);
    expect(app.files.map((file) => file.path)).toEqual([
      '.gitignore',
      'CLAUDE.md',
      'INSTRUCTIONS.md',
      'NEXT_STEPS.md',
      'docs/BRIEF.md',
    ]);
  });

  it('prefers the first root that has the template', async () => {
    await writeTree(path.join(dir, 'base'), TEMPLATE_TREE);
    await writeTree(path.join(dir, 'personal'), { 'generic/common/CLAUDE.md': 'mine\n' });
    const template = await loadTemplate('generic', 'claude-code', [
      path.join(dir, 'personal'),
      path.join(dir, 'base'),
    ]);
    expect(template.dir).toBe(path.join(dir, 'personal', 'generic'));
    expect(template.files).toEqual([{ path: 'CLAUDE.md', content: 'mine\n' }]);
  });

  it('reports where it looked when the template is missing', async () => {
    await expect(loadTemplate('nope', 'claude-code', [dir])).rejects.toMatchObject({
      code: 'scaffold.templateNotFound',
      params: { template: 'nope', searched: [path.join(dir, 'nope')] },
    });
  });
});

describe('buildPlan', () => {
  const template: Template = {
    name: 'generic',
    dir: 'unused',
    files: [
      { path: 'CLAUDE.md', content: '# {{name}}\n' },
      { path: 'notes.md', content: 'from template\n' },
    ],
  };

  it('plans the claude-code files', () => {
    const plan = buildPlan(
      spec({
        directories: ['data'],
        files: [
          { path: 'notes.md', purpose: 'ignored, template wins' },
          { path: 'docs/plan.md', purpose: 'The plan.' },
          { path: 'data/list.csv', purpose: 'A list.' },
        ],
        agents: [{ name: 'checker', description: 'Checks things', tools: ['Read', 'Grep'], tier: 'light' }],
        skills: [{ name: 'weekly-review', description: 'Review the week', purpose: 'Steps here.' }],
      }),
      template,
    );
    const files = Object.fromEntries(plan.files.map((file) => [file.path, file.content]));

    expect(plan.directories).toEqual(['data']);
    expect(Object.keys(files)).toEqual([
      '.briefstack/profile.json',
      '.briefstack/spec.json',
      '.claude/agents/checker.md',
      '.claude/settings.json',
      '.claude/skills/weekly-review/SKILL.md',
      '.gitignore',
      'CLAUDE.md',
      'data/list.csv',
      'docs/plan.md',
      'notes.md',
    ]);
    expect(files['CLAUDE.md']).toBe('# Garden planner\n');
    expect(files['notes.md']).toBe('from template\n');
    expect(files['docs/plan.md']).toBe('# plan\n\nThe plan.\n');
    expect(files['data/list.csv']).toBe('');
    expect(JSON.parse(files['.claude/settings.json'] ?? '')).toEqual({ permissions: { deny: DENY_RULES } });
    expect(JSON.parse(files['.briefstack/profile.json'] ?? '')).toEqual({
      profile: 'balanced',
      agents: { checker: 'light' },
    });
    expect(JSON.parse(files['.briefstack/spec.json'] ?? '').slug).toBe('garden-planner');

    const agent = parseFrontmatter(files['.claude/agents/checker.md'] ?? '', 'checker.md');
    expect(agent.data).toEqual({ name: 'checker', description: 'Checks things', tools: 'Read, Grep' });
    expect(agent.body).toBe('\nChecks things\n');
    const skill = parseFrontmatter(files['.claude/skills/weekly-review/SKILL.md'] ?? '', 'SKILL.md');
    expect(skill.data).toEqual({ name: 'weekly-review', description: 'Review the week' });
    expect(skill.body).toBe('\nSteps here.\n');
  });

  it('leaves Claude Code files out for claude-app', () => {
    const plan = buildPlan(spec({ target: 'claude-app' }), template);
    expect(plan.files.some((file) => file.path.startsWith('.claude/'))).toBe(false);
  });

  it('appends the template .gitignore to the base one', () => {
    const plan = buildPlan(spec(), { ...template, files: [{ path: '.gitignore', content: 'node_modules/\n' }] });
    const gitignore = plan.files.find((file) => file.path === '.gitignore')?.content ?? '';
    expect(gitignore).toContain('.env\n');
    expect(gitignore.endsWith('\nnode_modules/\n')).toBe(true);
  });

  it('refuses templates that write reserved paths', () => {
    for (const reserved of ['.claude/settings.json', '.briefstack/profile.json', '.git/config']) {
      expect(() =>
        buildPlan(spec(), { ...template, files: [{ path: reserved, content: '' }] }),
      ).toThrow(expect.objectContaining({ code: 'scaffold.templateReservedPath' }));
    }
  });
});

describe('checkOutputDir', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let protectedDirs: ProtectedDir[];
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('outdir'));
    protectedDirs = [
      { root: 'repo', path: path.join(dir, 'repo') },
      { root: 'library', path: path.join(dir, 'home', '.briefstack', 'library') },
    ];
    await mkdir(path.join(dir, 'repo'), { recursive: true });
  });
  afterEach(() => cleanup());

  const refusedFor = (outDir: string) =>
    checkOutputDir(outDir, protectedDirs, false).then(
      () => undefined,
      (error: { code?: string; params?: { root?: string } }) => `${error.code}:${error.params?.root}`,
    );

  it('accepts a new folder elsewhere', async () => {
    const result = await checkOutputDir(path.join(dir, 'projects', 'new'), protectedDirs, false);
    expect(result).toEqual({ outDir: path.join(dir, 'projects', 'new'), existed: false });
  });

  it('refuses folders inside the repo or the library, even if missing', async () => {
    expect(await refusedFor(path.join(dir, 'repo', 'out'))).toBe('scaffold.forbiddenOutput:repo');
    expect(await refusedFor(path.join(dir, 'home', '.briefstack', 'library', 'x'))).toBe(
      'scaffold.forbiddenOutput:library',
    );
  });

  it('refuses folders that contain the repo or the library', async () => {
    expect(await refusedFor(dir)).toBe('scaffold.forbiddenOutput:repo');
    expect(await refusedFor(path.join(dir, 'home'))).toBe('scaffold.forbiddenOutput:library');
  });

  it('compares paths ignoring case on Windows and macOS', async () => {
    const shouted = path.join(dir, 'REPO', 'out');
    const expected = process.platform === 'linux' ? undefined : 'scaffold.forbiddenOutput:repo';
    expect(await refusedFor(shouted)).toBe(expected);
  });

  it('follows links before comparing', async () => {
    const link = path.join(dir, 'link-to-repo');
    await symlink(path.join(dir, 'repo'), link, 'junction');
    expect(await refusedFor(path.join(link, 'out'))).toBe('scaffold.forbiddenOutput:repo');
  });

  it('refuses files and non-empty folders unless allowed', async () => {
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'x');
    expect(await refusedFor(file)).toBe('scaffold.notADirectory:undefined');

    const full = path.join(dir, 'full');
    await writeTree(full, { 'keep.txt': 'x' });
    expect(await refusedFor(full)).toBe('scaffold.nonEmptyOutput:undefined');
    expect(await checkOutputDir(full, protectedDirs, true)).toEqual({ outDir: full, existed: true });

    const empty = path.join(dir, 'empty');
    await mkdir(empty);
    expect(await checkOutputDir(empty, protectedDirs, false)).toEqual({ outDir: empty, existed: true });
  });
});

describe('scaffold', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let options: ScaffoldOptions;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('scaffold'));
    await writeTree(path.join(dir, 'templates'), TEMPLATE_TREE);
    options = {
      protectedDirs: [{ root: 'repo', path: path.join(dir, 'repo') }],
      templateRoots: [path.join(dir, 'templates')],
      profiles: await baseProfiles(),
    };
  });
  afterEach(() => cleanup());

  it('creates a claude-code project and a git repo', async () => {
    const outDir = path.join(dir, 'out', 'garden');
    const result = await scaffold(spec({ directories: ['logs'] }), outDir, options);

    expect(result.outDir).toBe(outDir);
    expect(result.template).toBe('generic');
    expect(result.gitInitialised).toBe(true);
    expect(result.warnings).toEqual([]);
    expect((await stat(path.join(outDir, '.git'))).isDirectory()).toBe(true);
    expect((await stat(path.join(outDir, 'logs'))).isDirectory()).toBe(true);

    const claude = await readFile(path.join(outDir, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('# Garden planner');
    expect(claude).toContain('- The calendar covers a full year');
    expect(claude).toContain('{{unknown}}');
    expect(await readFile(path.join(outDir, 'docs', 'BRIEF.md'), 'utf8')).toContain('claude-code');
    expect(await readFile(path.join(outDir, '.claude', 'settings.json'), 'utf8')).toContain('Read(.env)');
  });

  it('creates a claude-app project', async () => {
    const outDir = path.join(dir, 'app');
    const result = await scaffold(
      spec({
        target: 'claude-app',
        scheduledTasks: [{ name: 'Weekly', schedule: 'Mondays 09:00', prompt: 'Review the garden.' }],
      }),
      outDir,
      { ...options, gitInit: false },
    );
    expect(result.files).toContain('INSTRUCTIONS.md');
    expect(result.files.some((file) => file.startsWith('.claude/'))).toBe(false);
    expect(await readFile(path.join(outDir, 'NEXT_STEPS.md'), 'utf8')).toContain('Review the garden.');
  });

  it('never overwrites existing files, and writes nothing when it refuses', async () => {
    const outDir = path.join(dir, 'existing');
    await writeTree(outDir, { 'CLAUDE.md': 'mine\n', 'other.txt': 'x' });

    await expect(scaffold(spec(), outDir, options)).rejects.toMatchObject({ code: 'scaffold.nonEmptyOutput' });
    await expect(
      scaffold(spec(), outDir, { ...options, allowNonEmpty: true, gitInit: false }),
    ).rejects.toMatchObject({ code: 'scaffold.wouldOverwrite', params: { paths: ['CLAUDE.md'] } });

    expect(await readFile(path.join(outDir, 'CLAUDE.md'), 'utf8')).toBe('mine\n');
    await expect(stat(path.join(outDir, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('adds to a non-empty folder when allowed and nothing clashes', async () => {
    const outDir = path.join(dir, 'existing');
    await writeTree(outDir, { 'other.txt': 'x' });
    const result = await scaffold(spec(), outDir, { ...options, allowNonEmpty: true, gitInit: false });
    expect(result.files).toContain('CLAUDE.md');
    expect(await readFile(path.join(outDir, 'other.txt'), 'utf8')).toBe('x');
  });

  it('refuses a destination inside a protected folder', async () => {
    await expect(scaffold(spec(), path.join(dir, 'repo', 'x'), options)).rejects.toMatchObject({
      code: 'scaffold.forbiddenOutput',
    });
  });

  it('applies the spec profile to generated agents by tier', async () => {
    const outDir = path.join(dir, 'tiers');
    const result = await scaffold(
      spec({
        profile: 'max',
        agents: [
          { name: 'scout', description: 'Looks around', tools: ['Read'], tier: 'light' },
          { name: 'writer', description: 'Writes', tools: ['Read', 'Write'], tier: 'heavy' },
        ],
      }),
      outDir,
      { ...options, gitInit: false },
    );
    expect(result.profile).toBe('max');
    const max = options.profiles.presets.max;
    for (const [name, tier] of [['scout', 'light'], ['writer', 'heavy']] as const) {
      const text = await readFile(path.join(outDir, '.claude', 'agents', `${name}.md`), 'utf8');
      expect(parseFrontmatter(text, name).data).toMatchObject({
        name,
        model: max?.tiers[tier],
        effort: max?.effort,
      });
    }
    const profile = JSON.parse(await readFile(path.join(outDir, '.briefstack', 'profile.json'), 'utf8'));
    expect(profile).toEqual({ profile: 'max', agents: { scout: 'light', writer: 'heavy' } });
  });

  it('refuses an unknown profile before writing anything', async () => {
    const outDir = path.join(dir, 'unknown-profile');
    await expect(scaffold(spec({ profile: 'turbo' }), outDir, options)).rejects.toMatchObject({
      code: 'usage.unknownProfile',
    });
    await expect(stat(outDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
