import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PathEnv } from '../../src/config/paths.js';
import { isValidModel } from '../../src/models.js';
import { DENY_RULES, scaffold } from '../../src/scaffold/index.js';
import { parseSpec, type SpecInput, type Target } from '../../src/spec/index.js';
import {
  REQUIRED_FILES,
  checkAgentFile,
  checkSkillFile,
  splitToolList,
  validateProject,
  type Finding,
} from '../../src/validate/index.js';
import { baseProfiles, specInput, tempDir, writeTree } from '../helpers.js';

const fakeEnv: PathEnv = {
  env: {},
  homedir: path.join(path.parse(process.cwd()).root, 'fake-home', 'someone'),
  pathApi: path,
  caseInsensitive: process.platform !== 'linux',
};

const specJson = (overrides: Partial<SpecInput> = {}) =>
  `${JSON.stringify(parseSpec(specInput(overrides), 'spec.json'), null, 2)}\n`;

const settingsJson = (value: unknown = { permissions: { deny: DENY_RULES } }) => `${JSON.stringify(value, null, 2)}\n`;

const AGENT = '---\nname: helper\ndescription: Helps.\ntools: Read, Grep\nmodel: sonnet\neffort: medium\n---\n\nBody.\n';
const SKILL = '---\nname: notes\ndescription: Takes notes.\n---\n\nBody.\n';

/** A project that validates clean for the target. */
function cleanTree(target: Target): Record<string, string> {
  const common = {
    'docs/BRIEF.md': '# Brief\n\nSee [[INSTRUCTIONS]] or [the steps](../NEXT_STEPS.md).\n',
    '.gitignore': '.env\n',
    '.briefstack/profile.json': '{ "profile": "balanced", "agents": {} }\n',
    '.briefstack/spec.json': specJson({ target }),
  };
  if (target === 'claude-code') {
    return {
      ...common,
      'docs/BRIEF.md': '# Brief\n\nSee [[helper]] and [the agent](../.claude/agents/helper.md).\n',
      'CLAUDE.md': '# Garden planner\n\nRead [the brief](docs/BRIEF.md).\n',
      '.claude/settings.json': settingsJson(),
      '.claude/agents/helper.md': AGENT,
      '.claude/skills/notes/SKILL.md': SKILL,
    };
  }
  return {
    ...common,
    'INSTRUCTIONS.md': 'Instructions. Context in [[BRIEF]].\n',
    'NEXT_STEPS.md': '1. Open the Claude desktop app.\n',
  };
}

const rules = (findings: readonly Finding[]) => findings.map((item) => item.rule);

describe('validateProject', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('validate'));
  });
  afterEach(() => cleanup());

  async function project(target: Target, changes: Record<string, string | null> = {}): Promise<string> {
    const root = path.join(dir, 'project');
    const tree: Record<string, string> = cleanTree(target);
    for (const [file, content] of Object.entries(changes)) {
      if (content === null) delete tree[file];
      else tree[file] = content;
    }
    await writeTree(root, tree);
    await mkdir(path.join(root, '.git'), { recursive: true });
    return root;
  }

  const run = (root: string, pathEnv: PathEnv = fakeEnv) => validateProject(root, { pathEnv });

  for (const target of ['claude-code', 'claude-app'] as const) {
    it(`accepts a clean ${target} project`, async () => {
      const result = await run(await project(target));
      expect(result.findings).toEqual([]);
      expect(result).toMatchObject({ target, errors: 0, warnings: 0 });
    });
  }

  it('refuses a folder that does not exist or is a file', async () => {
    await expect(run(path.join(dir, 'nope'))).rejects.toMatchObject({ code: 'validate.projectNotFound' });
    await writeFile(path.join(dir, 'file.txt'), 'x', 'utf8');
    await expect(run(path.join(dir, 'file.txt'))).rejects.toMatchObject({ code: 'validate.notADirectory' });
  });

  describe('target', () => {
    it('reports a missing spec and runs only the common checks', async () => {
      const result = await run(await project('claude-code', { '.briefstack/spec.json': null, 'CLAUDE.md': null }));
      expect(result.target).toBeUndefined();
      expect(result.findings).toEqual([
        { rule: 'target.unknown', severity: 'warning', params: {} },
        { rule: 'required.missing', severity: 'error', file: '.briefstack/spec.json', params: { kind: 'file' } },
      ]);
    });

    it('reports invalid JSON', async () => {
      const result = await run(await project('claude-code', { '.briefstack/spec.json': '{ nope' }));
      expect(rules(result.findings)).toEqual(['target.unknown', 'spec.invalidJson']);
    });

    it('reports an invalid spec but keeps a valid target', async () => {
      const broken = JSON.stringify({ ...JSON.parse(specJson({ target: 'claude-app' })), slug: 'Bad Slug' });
      const result = await run(await project('claude-app', { '.briefstack/spec.json': broken }));
      expect(result.target).toBe('claude-app');
      expect(result.findings).toEqual([
        expect.objectContaining({
          rule: 'spec.invalid',
          params: { issues: [expect.objectContaining({ path: 'slug', rule: 'slug' })] },
        }),
      ]);
    });
  });

  describe('required files', () => {
    it('lists the same files as the plan', () => {
      expect(REQUIRED_FILES['claude-code']).toContain('.claude/settings.json');
      expect(REQUIRED_FILES['claude-app']).toEqual(
        expect.arrayContaining(['INSTRUCTIONS.md', 'NEXT_STEPS.md', '.git']),
      );
      expect(REQUIRED_FILES['claude-app']).not.toContain('CLAUDE.md');
    });

    it('reports missing and empty files for claude-code', async () => {
      const root = await project('claude-code', { 'CLAUDE.md': null, '.gitignore': '  \n' });
      await rm(path.join(root, '.git'), { recursive: true });
      const result = await run(root);
      expect(result.findings).toEqual([
        { rule: 'required.missing', severity: 'error', file: '.git', params: { kind: 'gitRepo' } },
        { rule: 'required.empty', severity: 'error', file: '.gitignore', params: {} },
        { rule: 'required.missing', severity: 'error', file: 'CLAUDE.md', params: { kind: 'file' } },
      ]);
      expect(result.errors).toBe(3);
    });

    it('reports missing claude-app files', async () => {
      const result = await run(await project('claude-app', { 'NEXT_STEPS.md': null, 'INSTRUCTIONS.md': '' }));
      expect(result.findings.map((item) => [item.rule, item.file])).toEqual([
        ['required.empty', 'INSTRUCTIONS.md'],
        ['required.missing', 'NEXT_STEPS.md'],
        // docs/BRIEF.md links to the missing file.
        ['link.relative', 'docs/BRIEF.md'],
      ]);
    });

    it('accepts .git as a file (worktrees) and does not scan it', async () => {
      const root = await project('claude-app');
      await rm(path.join(root, '.git'), { recursive: true });
      await writeFile(path.join(root, '.git'), 'gitdir: D:/elsewhere/.git/worktrees/x\n', 'utf8');
      expect((await run(root)).findings).toEqual([]);
    });
  });

  describe('frontmatter', () => {
    it('reports agent and skill files with broken or incomplete frontmatter', async () => {
      const result = await run(
        await project('claude-code', {
          '.claude/agents/bad-yaml.md': '---\nname: [unclosed\n---\n',
          '.claude/agents/no-fm.md': 'Just text.\n',
          '.claude/agents/no-desc.md': '---\nname: x\ndescription: "  "\ntools: Read\n---\n',
          '.claude/skills/broken/SKILL.md': '---\nname: broken\n',
          '.claude/skills/empty/README.md': 'no skill file\n',
        }),
      );
      expect(result.findings.map((item) => [item.rule, item.file])).toEqual([
        ['frontmatter.invalid', '.claude/agents/bad-yaml.md'],
        ['frontmatter.missingField', '.claude/agents/no-desc.md'],
        ['frontmatter.missing', '.claude/agents/no-fm.md'],
        ['frontmatter.invalid', '.claude/skills/broken/SKILL.md'],
        ['skill.missingFile', '.claude/skills/empty/SKILL.md'],
      ]);
    });

    it('checks agents in a claude-app project too', async () => {
      const result = await run(await project('claude-app', { '.claude/agents/x.md': 'no frontmatter\n' }));
      expect(rules(result.findings)).toEqual(['frontmatter.missing']);
    });
  });

  describe('application code', () => {
    it('reports source code and build files outside .claude and .briefstack', async () => {
      const result = await run(
        await project('claude-code', {
          'src/fen_check/uci.py': 'print(1)\n',
          'tests/test_uci.py': 'def test(): pass\n',
          'pyproject.toml': '[project]\n',
          'docs/PLAN.md': '# Plan\n',
          '.claude/skills/notes/scripts/helper.sh': 'echo hi\n',
        }),
      );
      expect(result.findings).toEqual([
        { rule: 'code.applicationFile', severity: 'error', file: 'pyproject.toml', params: { kind: 'buildFile' } },
        { rule: 'code.applicationFile', severity: 'error', file: 'src/fen_check/uci.py', params: { kind: 'source' } },
        { rule: 'code.applicationFile', severity: 'error', file: 'tests/test_uci.py', params: { kind: 'source' } },
      ]);
    });
  });

  describe('CLAUDE.md length', () => {
    it('accepts 59 lines and rejects 60', async () => {
      const lines = (count: number) => `${Array.from({ length: count }, (_, i) => `line ${i}`).join('\n')}\n`;
      expect((await run(await project('claude-code', { 'CLAUDE.md': lines(59) }))).findings).toEqual([]);
      await cleanup();
      ({ dir, cleanup } = await tempDir('validate'));
      const result = await run(await project('claude-code', { 'CLAUDE.md': lines(60) }));
      expect(result.findings).toEqual([
        { rule: 'claudeMd.tooLong', severity: 'error', file: 'CLAUDE.md', params: { lines: 60, limit: 60 } },
      ]);
    });

    it('applies to claude-app only when CLAUDE.md exists', async () => {
      const long = 'x\n'.repeat(80);
      const result = await run(await project('claude-app', { 'CLAUDE.md': long }));
      expect(rules(result.findings)).toEqual(['claudeMd.tooLong']);
    });
  });

  describe('secrets', () => {
    it('reports secret-looking strings with file and line, never the value', async () => {
      const key = 'sk-' + 'ant-api03-' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z';
      const result = await run(await project('claude-code', { 'notes/setup.md': `# Setup\n\nKEY ${key}\n` }));
      expect(result.findings).toEqual([
        { rule: 'secret.found', severity: 'error', file: 'notes/setup.md', line: 3, params: { kind: 'anthropic' } },
      ]);
      expect(JSON.stringify(result.findings)).not.toContain(key);
    });

    it('accepts the generated deny rules and documentation about secrets', async () => {
      const doc = '# Secrets\n\nPut your API key in `.env` (API_KEY=<your key>); it is denied by `Read(.env)`.\n';
      expect((await run(await project('claude-code', { 'docs/secrets.md': doc }))).findings).toEqual([]);
    });

    it('skips binary files and folders that are never scanned', async () => {
      const key = 'ghp' + '_' + 'aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2';
      const root = await project('claude-code', { 'node_modules/pkg/index.js': key, '.git/config': key });
      await writeFile(path.join(root, 'image.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(key)]));
      expect((await run(root)).findings).toEqual([]);
    });
  });

  describe('absolute paths', () => {
    it('reports the home folder and other machine paths', async () => {
      const home = fakeEnv.homedir;
      const result = await run(
        await project('claude-code', {
          'docs/paths.md': `# Paths\n\nMine: ${home}${path.sep}x\nTheirs: /home/bob/x\n`,
        }),
      );
      expect(result.findings.map((item) => [item.rule, item.line, (item.params as { kind: string }).kind])).toEqual([
        ['path.absolute', 3, 'homeDir'],
        ['path.absolute', 4, 'homeFolder'],
      ]);
    });

    it('accepts ~ paths, deny patterns and URLs', async () => {
      const doc = '# Paths\n\nProjects live in ~/briefstack-projects. See https://example.com/home/x.\n';
      const settings = settingsJson({ permissions: { deny: [...DENY_RULES, 'Read(//**/.env)'] } });
      const result = await run(await project('claude-code', { 'docs/paths.md': doc, '.claude/settings.json': settings }));
      expect(result.findings).toEqual([]);
    });
  });

  describe('links', () => {
    it('reports broken wikilinks and relative links with their lines', async () => {
      const doc = ['# Links', '', '[[Missing note]]', '[gone](./gone.md)', '`[[in code]]`', '[ok](BRIEF.md)'].join('\n');
      const result = await run(await project('claude-code', { 'docs/links.md': doc }));
      expect(result.findings).toEqual([
        { rule: 'link.wikilink', severity: 'error', file: 'docs/links.md', line: 3, params: { target: 'Missing note' } },
        { rule: 'link.relative', severity: 'error', file: 'docs/links.md', line: 4, params: { target: './gone.md' } },
      ]);
    });

    it('resolves wikilinks against notes in any folder', async () => {
      const result = await run(
        await project('claude-code', { 'docs/a/one.md': '[[two]] [[two#Part|alias]]\n', 'notes/b/two.md': 'x\n' }),
      );
      expect(result.findings).toEqual([]);
    });
  });

  describe('settings', () => {
    it('reports hooks, allow rules and a missing deny list', async () => {
      const settings = settingsJson({ hooks: { Stop: [] }, permissions: { allow: ['Bash'] } });
      const result = await run(await project('claude-code', { '.claude/settings.json': settings }));
      expect(rules(result.findings)).toEqual(['settings.allow', 'settings.hooks', 'settings.noDeny']);
    });

    it('reports invalid JSON and missing default deny rules', async () => {
      const invalid = await run(await project('claude-code', { '.claude/settings.json': '{ nope' }));
      expect(rules(invalid.findings)).toEqual(['settings.invalidJson']);
      await cleanup();
      ({ dir, cleanup } = await tempDir('validate'));

      const partial = settingsJson({ permissions: { deny: DENY_RULES.slice(1) } });
      const result = await run(await project('claude-code', { '.claude/settings.json': partial }));
      expect(result.findings).toEqual([
        {
          rule: 'settings.missingDenyRule',
          severity: 'warning',
          file: '.claude/settings.json',
          params: { rule: DENY_RULES[0] },
        },
      ]);
      expect(result.errors).toBe(0);
    });

    it('does not require settings for claude-app but still rejects hooks there', async () => {
      const result = await run(await project('claude-app', { '.claude/settings.json': settingsJson({ hooks: {} }) }));
      expect(rules(result.findings)).toEqual(['settings.hooks']);
    });
  });

  it('sorts findings deterministically', async () => {
    const result = await run(
      await project('claude-code', {
        'b.md': '[[x]]\n[[y]]\n',
        'Z.md': '[[q]]\n',
        'a.md': '[[w]]\n',
      }),
    );
    expect(result.findings.map((item) => `${item.file}:${item.line}`)).toEqual(['Z.md:1', 'a.md:1', 'b.md:1', 'b.md:2']);
  });
});

describe('agent frontmatter', () => {
  const agent = (fields: string) => `---\nname: a\ndescription: d\n${fields}---\n\nBody.\n`;
  const check = (fields: string) => rules(checkAgentFile(agent(fields), '.claude/agents/a.md'));

  it('accepts tools as a string or a YAML list, and unknown fields', () => {
    expect(check('tools: Read, Bash(npm test:*, x), Grep\n')).toEqual([]);
    expect(check('tools:\n  - Read\n  - Grep\ncolor: blue\nmaxTurns: 3\n')).toEqual([]);
  });

  it('rejects tools that launch agents, in any form', () => {
    expect(checkAgentFile(agent('tools: Read, Agent\n'), 'a.md')).toEqual([
      expect.objectContaining({ rule: 'agent.spawnTool', params: { tool: 'Agent' } }),
    ]);
    expect(check('tools:\n  - Task\n')).toEqual(['agent.spawnTool']);
    expect(check('tools: Agent(helper, other)\n')).toEqual(['agent.spawnTool']);
    expect(check('tools: AgentX, MyTask\n')).toEqual([]);
  });

  it('rejects malformed or omitted tools', () => {
    expect(check('tools: 3\n')).toEqual(['agent.invalidTools']);
    expect(check('tools:\n  - 1\n')).toEqual(['agent.invalidTools']);
    expect(check('')).toEqual(['agent.toolsOmitted']);
    expect(check('disallowedTools: Agent\n')).toEqual([]);
  });

  it('checks model and effort values', () => {
    for (const model of ['haiku', 'sonnet', 'opus', 'fable', 'opus[1m]', 'inherit', 'claude-opus-5-5', 'claude-sonnet-4-5[1m]']) {
      expect(isValidModel(model)).toBe(true);
    }
    for (const model of ['gpt-4', 'Opus', 'opus[2m]', 'claude-', '']) expect(isValidModel(model)).toBe(false);
    expect(check('tools: Read\nmodel: opus\neffort: xhigh\n')).toEqual([]);
    expect(check('tools: Read\nmodel: gpt-4\neffort: extreme\n')).toEqual(['agent.invalidModel', 'agent.invalidEffort']);
    expect(check('tools: Read\nmodel: 4\n')).toEqual(['agent.invalidModel']);
  });

  it('splits tool lists on top-level commas only', () => {
    expect(splitToolList('Read, Bash(git log:*, x),Grep ,')).toEqual(['Read', 'Bash(git log:*, x)', 'Grep']);
  });

  it('requires name and description in skills', () => {
    expect(checkSkillFile('---\nname: s\ndescription: d\nallowed-tools: Read\n---\n', 'SKILL.md')).toEqual([]);
    expect(checkSkillFile('---\ndescription: d\n---\n', 'SKILL.md')).toEqual([
      expect.objectContaining({ rule: 'frontmatter.missingField', params: { field: 'name' } }),
    ]);
  });
});

describe('scaffolded projects', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('validate-scaffold'));
  });
  afterEach(() => cleanup());

  for (const target of ['claude-code', 'claude-app'] as const) {
    it(`validate clean for ${target}`, async () => {
      const templates = path.join(dir, 'templates');
      await writeTree(templates, {
        'generic/common/docs/BRIEF.md': '# Brief: {{name}}\n\n{{deliverables}}\n\nBack to [[ideas]].\n',
        'generic/claude-code/CLAUDE.md': '# {{name}}\n\n{{summary}}\n\nRead [the brief](docs/BRIEF.md).\n',
        'generic/claude-app/CLAUDE.md': '# {{name}}\n',
        'generic/claude-app/INSTRUCTIONS.md': 'Instructions for {{name}}. See [[BRIEF]].\n',
        'generic/claude-app/NEXT_STEPS.md': '# Next steps\n\n{{scheduledTasks}}\n',
      });
      const extra: Partial<SpecInput> =
        target === 'claude-code'
          ? {
              agents: [{ name: 'checker', description: 'Checks.', tools: ['Read', 'Grep'], tier: 'light' }],
              skills: [{ name: 'weekly', description: 'Weekly review.' }],
            }
          : { scheduledTasks: [{ name: 'Weekly', schedule: 'every Monday', prompt: 'Review the week.' }] };
      const spec = parseSpec(specInput({ target, ...extra, files: [{ path: 'notes/ideas.md', purpose: 'Ideas.' }] }), 'spec.json');
      const outDir = path.join(dir, 'out');
      const result = await scaffold(spec, outDir, { protectedDirs: [], templateRoots: [templates], profiles: await baseProfiles() });

      const validation = await validateProject(outDir, { pathEnv: fakeEnv });
      if (!result.gitInitialised) {
        // Without git on the machine only the repository check can fail.
        expect(rules(validation.findings)).toEqual(['required.missing']);
        return;
      }
      expect(validation.findings).toEqual([]);
      expect(validation.target).toBe(target);
    });
  }
});

describe('agent without tools', () => {
  it('is an error: it would get the Agent tool', () => {
    const findings = checkAgentFile('---\nname: a\ndescription: d\n---\nbody\n', 'a.md');
    expect(findings).toEqual([expect.objectContaining({ rule: 'agent.toolsOmitted', severity: 'error' })]);
  });
});
