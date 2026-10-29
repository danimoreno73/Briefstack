import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { declaresHooks, evaluateTaskToolUse, isDefinitionFile, protectedProjectFile, type TaskGuardRules } from '../../src/tasks/guard.js';
import { tempDir, writeTree } from '../helpers.js';

let dir: string;
let worktree: string;
let rules: TaskGuardRules;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('tasks-guard'));
  worktree = path.join(dir, 'home', 'tasks', 'abc123-0f0f', 'work');
  await writeTree(worktree, {
    'src/app.ts': 'export {};\n',
    '.claude/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Deploys.\n---\n\nDeploy.\n',
    '.claude/agents/helper.md': '---\nname: helper\ndescription: Helps.\n---\n\nHelp.\n',
  });
  await writeTree(path.join(dir, 'project'), { 'CLAUDE.md': '# Project\n' });
  rules = { worktree, skills: ['deploy'] };
});

afterEach(() => cleanup());

const call = (tool_name: string, tool_input: Record<string, unknown>, agent_id?: string) => evaluateTaskToolUse(rules, { tool_name, tool_input, agent_id });
const inWork = (...parts: string[]) => path.join(worktree, ...parts);

describe('task guard: reads', () => {
  it('allows reads inside the worktree and refuses everything outside it', async () => {
    expect(await call('Read', { file_path: inWork('src', 'app.ts') })).toMatchObject({ verdict: 'allow' });
    expect(await call('Grep', { pattern: 'x' })).toMatchObject({ verdict: 'allow' });
    expect(await call('Glob', { pattern: 'src/**/*.ts' })).toMatchObject({ verdict: 'allow' });
    expect(await call('Read', { file_path: path.join(dir, 'project', 'CLAUDE.md') })).toMatchObject({ verdict: 'deny' });
    expect(await call('Read', { file_path: path.join(dir, 'home', 'tasks', 'abc123-0f0f', 'guard.json') })).toMatchObject({ verdict: 'deny' });
    expect(await call('Grep', { pattern: 'x', path: path.join(dir, 'home') })).toMatchObject({ verdict: 'deny' });
    expect(await call('Read', { file_path: '../../guard.json' })).toMatchObject({ verdict: 'deny' });
  });

  it('refuses .git and rooted or climbing Glob patterns', async () => {
    expect(await call('Read', { file_path: inWork('.git') })).toMatchObject({ verdict: 'deny' });
    expect(await call('Read', { file_path: inWork('sub', '.git', 'config') })).toMatchObject({ verdict: 'deny' });
    for (const pattern of ['/etc/*', 'C:/Users/*', '~/x', '../*', 'src/../../*', '\\\\server\\share\\*']) {
      expect(await call('Glob', { pattern }), pattern).toMatchObject({ verdict: 'deny' });
    }
  });

  it('refuses a link inside the worktree that leads outside it', async () => {
    const link = inWork('outside');
    try {
      await symlink(path.join(dir, 'project'), link, 'junction');
    } catch {
      return; // No right to make links here.
    }
    expect(await call('Read', { file_path: path.join(link, 'CLAUDE.md') })).toMatchObject({ verdict: 'deny' });
    expect(await call('Write', { file_path: path.join(link, 'CLAUDE.md'), content: 'x' })).toMatchObject({ verdict: 'deny' });
  });
});

describe('task guard: writes', () => {
  it('allows writes inside the worktree, new files and folders included', async () => {
    expect(await call('Write', { file_path: inWork('src', 'new.ts'), content: 'x' })).toMatchObject({ verdict: 'allow' });
    expect(await call('Write', { file_path: inWork('docs', 'deep', 'a.md'), content: 'x' })).toMatchObject({ verdict: 'allow' });
    expect(await call('Edit', { file_path: inWork('src', 'app.ts'), old_string: 'export', new_string: 'export const a = 1;\nexport' })).toMatchObject({ verdict: 'allow' });
  });

  it('refuses writes outside the worktree, to its root, with a relative path, and in .git', async () => {
    expect(await call('Write', { file_path: path.join(dir, 'project', 'CLAUDE.md'), content: 'x' })).toMatchObject({ verdict: 'deny' });
    expect(await call('Write', { file_path: path.join(dir, 'home', 'tasks', 'abc123-0f0f', 'guard.json'), content: '{}' })).toMatchObject({ verdict: 'deny' });
    expect(await call('Write', { file_path: worktree, content: 'x' })).toMatchObject({ verdict: 'deny' });
    expect(await call('Write', { file_path: 'src/app.ts', content: 'x' })).toMatchObject({ verdict: 'deny' });
    expect(await call('Write', { file_path: inWork('.git'), content: 'x' })).toMatchObject({ verdict: 'deny' });
    expect(await call('Edit', { file_path: inWork('.git', 'config'), old_string: 'a', new_string: 'b' })).toMatchObject({ verdict: 'deny' });
  });

  it('refuses settings files, .mcp.json and hook files at any depth', async () => {
    for (const file of ['.claude/settings.json', '.claude/settings.local.json', 'pkg/.claude/settings.json', '.mcp.json', '.claude/hooks/check.sh', '.husky/pre-commit', 'tools/.githooks/pre-push']) {
      expect(await call('Write', { file_path: inWork(...file.split('/')), content: '{}' }), file).toMatchObject({ verdict: 'deny' });
    }
    expect(await call('Write', { file_path: inWork('.claude', 'settings.md'), content: 'x' })).toMatchObject({ verdict: 'allow' });
  });

  it('refuses a skill, command or agent file that would declare hooks, by Write or by Edit', async () => {
    const hooked = '---\nname: deploy\ndescription: Deploys.\nhooks:\n  PreToolUse: []\n---\n\nDeploy.\n';
    expect(await call('Write', { file_path: inWork('.claude', 'skills', 'deploy', 'SKILL.md'), content: hooked })).toMatchObject({ verdict: 'deny' });
    expect(await call('Write', { file_path: inWork('.claude', 'commands', 'go.md'), content: hooked })).toMatchObject({ verdict: 'deny' });
    expect(await call('Write', { file_path: inWork('pkg', '.claude', 'agents', 'x.md'), content: hooked })).toMatchObject({ verdict: 'deny' });
    expect(
      await call('Edit', { file_path: inWork('.claude', 'agents', 'helper.md'), old_string: 'description: Helps.', new_string: 'description: Helps.\nhooks: {}' }),
    ).toMatchObject({ verdict: 'deny' });
    // A broken frontmatter cannot be told apart: refused too.
    expect(await call('Write', { file_path: inWork('.claude', 'agents', 'helper.md'), content: '---\nname: [helper\n---\n' })).toMatchObject({ verdict: 'deny' });
    // An edit that cannot apply cannot be checked.
    expect(await call('Edit', { file_path: inWork('.claude', 'agents', 'missing.md'), old_string: 'a', new_string: 'b' })).toMatchObject({ verdict: 'deny' });
    // Without hooks, it goes ahead.
    expect(
      await call('Edit', { file_path: inWork('.claude', 'agents', 'helper.md'), old_string: 'Help.', new_string: 'Help more.' }),
    ).toMatchObject({ verdict: 'allow' });
    expect(await call('Write', { file_path: inWork('.claude', 'skills', 'deploy', 'SKILL.md'), content: '---\nname: deploy\ndescription: Deploys the hooks.\n---\n\nhooks: are fine in the body.\n' })).toMatchObject({ verdict: 'allow' });
  });

  it('tells definition files and protected files from the rest', () => {
    expect(isDefinitionFile('.claude/skills/a/SKILL.md')).toBe(true);
    expect(isDefinitionFile('.claude/skills/a/notes.md')).toBe(true);
    expect(isDefinitionFile('x/.claude/commands/a.md')).toBe(true);
    expect(isDefinitionFile('.claude/skills/a/run.sh')).toBe(false);
    expect(isDefinitionFile('docs/agents/a.md')).toBe(false);
    expect(protectedProjectFile('src/app.ts')).toBeUndefined();
    expect(declaresHooks('no frontmatter\nhooks: x\n')).toBe(false);
    expect(declaresHooks('---\n"hooks": {}\n---\n')).toBe(true);
  });
});

describe('task guard: other tools', () => {
  it('asks for every shell command and web request, keyed on the whole string', async () => {
    expect(await call('Bash', { command: 'npm test' })).toEqual({ verdict: 'ask', reason: expect.any(String), kind: 'shell', key: 'npm test' });
    expect(await call('PowerShell', { command: 'npm test && curl x' })).toMatchObject({ verdict: 'ask', key: 'npm test && curl x' });
    expect(await call('Bash', { command: '  ' })).toMatchObject({ verdict: 'deny' });
    expect(await call('Bash', { command: 'sleep 99', run_in_background: true })).toMatchObject({ verdict: 'deny' });
    expect(await call('WebFetch', { url: 'https://example.com/a', prompt: 'read' })).toMatchObject({ verdict: 'ask', kind: 'web', key: 'https://example.com/a' });
    expect(await call('WebSearch', { query: 'vitest' })).toMatchObject({ verdict: 'ask', kind: 'web', key: 'vitest' });
  });

  it('allows only the project\'s skills', async () => {
    expect(await call('Skill', { skill: 'deploy' })).toMatchObject({ verdict: 'allow' });
    for (const skill of ['loop', 'schedule', 'design', 'plugin-authoring', 'anthropic-skills:docx', 'Deploy']) {
      expect(await call('Skill', { skill }), skill).toMatchObject({ verdict: 'deny' });
    }
    expect(await call('Skill', {})).toMatchObject({ verdict: 'deny' });
  });

  it('allows subagents in the foreground only, and the hand-back to subagents only', async () => {
    expect(await call('Agent', { subagent_type: 'helper', prompt: 'go' })).toMatchObject({ verdict: 'allow' });
    expect(await call('Agent', { subagent_type: 'helper', prompt: 'go', isolation: 'worktree' })).toMatchObject({ verdict: 'deny' });
    expect(await call('Agent', { subagent_type: 'helper', prompt: 'go', mode: 'bypassPermissions' })).toMatchObject({ verdict: 'deny' });
    expect(await call('Agent', { subagent_type: 'helper', prompt: 'go', run_in_background: true })).toMatchObject({ verdict: 'deny' });
    expect(await call('SubagentHandback', { report: 'x' }, 'agent-1')).toMatchObject({ verdict: 'allow' });
    expect(await call('SubagentHandback', { report: 'x' })).toMatchObject({ verdict: 'deny' });
  });

  it('refuses every tool the task does not offer', async () => {
    for (const tool of ['CronCreate', 'ScheduleWakeup', 'RemoteTrigger', 'Monitor', 'EnterWorktree', 'NotebookEdit', 'MultiEdit', 'Workflow', 'mcp__x__y', 'TaskOutput']) {
      expect(await call(tool, {}), tool).toMatchObject({ verdict: 'deny' });
    }
    expect(await call('AskUserQuestion', { questions: [] })).toMatchObject({ verdict: 'allow' });
    expect(await call('ToolSearch', { query: 'x' })).toMatchObject({ verdict: 'allow' });
  });
});

describe('task guard: a folder that does not exist yet', () => {
  it('resolves through the nearest folder that does', async () => {
    await mkdir(inWork('a'), { recursive: true });
    expect(await call('Write', { file_path: inWork('a', 'b', 'c', 'd.txt'), content: 'x' })).toMatchObject({ verdict: 'allow' });
  });
});
