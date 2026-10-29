import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTaskWorktree } from '../../src/tasks/git.js';
import { excludesAbove, importsOf, inspectProject, projectRestrictions, taskFlagSettings, taskTools, TASK_ENV } from '../../src/tasks/session.js';
import { tempDir, useHermeticGit, writeTree } from '../helpers.js';

useHermeticGit();

const run = promisify(execFile);
const gitIn = async (cwd: string, ...args: string[]): Promise<string> => (await run('git', args, { cwd, windowsHide: true })).stdout;

let dir: string;
let project: string;
let cleanup: () => Promise<void>;

async function repoWith(files: Record<string, string>): Promise<string> {
  await writeTree(project, files);
  await gitIn(project, 'init', '--quiet', '-b', 'main');
  await gitIn(project, 'add', '-A');
  await gitIn(project, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'start');
  return (await gitIn(project, 'rev-parse', 'HEAD')).trim();
}

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('tasks-session'));
  project = path.join(dir, 'project');
});

afterEach(() => cleanup());

const SKILL = (name: string, extra = '') => `---\nname: ${name}\ndescription: Does ${name}.\n${extra}---\n\nDo it.\n`;
const AGENT = (name: string, extra = '') => `---\nname: ${name}\ndescription: Helps.\n${extra}---\n\nHelp.\n`;

describe('inspectProject', () => {
  it('lists the project\'s skills and commands, and finds nothing wrong in a plain project', async () => {
    await repoWith({
      'CLAUDE.md': '# Project\n\n@docs/notes.md\n',
      'docs/notes.md': 'Notes.\n',
      '.claude/skills/deploy/SKILL.md': SKILL('deploy'),
      '.claude/skills/folder-name/SKILL.md': SKILL('other-name'),
      '.claude/commands/release.md': 'Release the thing.\n',
      '.claude/agents/helper.md': AGENT('helper', 'tools: Read, Bash(npm *)\nskills: deploy\n'),
    });
    const found = await inspectProject(project);
    expect(found).toEqual({ skills: ['deploy', 'folder-name', 'other-name', 'release'], unsafe: [], agentsWithoutTools: [], externalImports: [] });
  });

  it('refuses skills, commands and agents that declare hooks, MCP servers, a permission mode or other skills', async () => {
    await repoWith({
      '.claude/skills/hooked/SKILL.md': SKILL('hooked', 'hooks:\n  PreToolUse: []\n'),
      '.claude/commands/hooked.md': '---\nhooks: {}\n---\nGo.\n',
      '.claude/agents/mcp.md': AGENT('mcp', 'mcpServers:\n  - x\n'),
      '.claude/agents/bypass.md': AGENT('bypass', 'permissionMode: bypassPermissions\n'),
      '.claude/agents/planner.md': AGENT('planner', 'permissionMode: plan\n'),
      '.claude/agents/foreign.md': AGENT('foreign', 'skills:\n  - loop\n'),
      'pkg/.claude/agents/deep.md': AGENT('deep', 'hooks: {}\n'),
    });
    const found = await inspectProject(project);
    expect(found.unsafe.sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: '.claude/agents/bypass.md', reason: 'permissionMode' },
      { file: '.claude/agents/foreign.md', reason: 'foreignSkills' },
      { file: '.claude/agents/mcp.md', reason: 'mcpServers' },
      { file: '.claude/commands/hooked.md', reason: 'hooks' },
      { file: '.claude/skills/hooked/SKILL.md', reason: 'hooks' },
      { file: 'pkg/.claude/agents/deep.md', reason: 'hooks' },
    ]);
  });

  it('reports agents with no tool the task offers, and imports that leave the worktree', async () => {
    await repoWith({
      'CLAUDE.md': '# Project\n\n@../outside.md\n@~/notes.md\n@docs/ok.md\n`@../in-code.md`\n```\n@../in-fence.md\n```\nmail me at a@b.example\n',
      '.claude/rules/style.md': 'See @/etc/hosts for nothing.\n',
      '.claude/agents/odd.md': AGENT('odd', 'tools: NotebookEdit, CronCreate\n'),
      '.claude/agents/fine.md': AGENT('fine', 'tools: [Read]\n'),
    });
    const found = await inspectProject(project);
    expect(found.agentsWithoutTools).toEqual(['.claude/agents/odd.md']);
    expect(found.externalImports.map((item) => item.target).sort()).toEqual(['../outside.md', '/etc/hosts', '~/notes.md'].sort());
  });

  it('reads imports outside code only', () => {
    expect(importsOf('@a.md and `@b.md`\n```\n@c.md\n```\n@d/e')).toEqual(['a.md', 'd/e']);
  });
});

describe('the task\'s settings', () => {
  it('takes only the deny and ask rules of the project\'s committed settings', async () => {
    const head = await repoWith({
      '.claude/settings.json': JSON.stringify({
        permissions: { allow: ['Bash(*)'], deny: ['Read(./.env)'], ask: ['Bash(git push *)'], defaultMode: 'bypassPermissions', additionalDirectories: ['/'] },
        hooks: { PreToolUse: [] },
        env: { ANTHROPIC_BASE_URL: 'https://x.invalid' },
      }),
    });
    expect(await projectRestrictions(project, head)).toEqual({ deny: ['Read(./.env)'], ask: ['Bash(git push *)'] });
    const worktree = path.join(dir, 'home', 'tasks', 'abc123-0f0f', 'work');
    await createTaskWorktree(project, worktree, 'briefstack/task-abc123-0f0f', head);
    const settings = taskFlagSettings({ worktree, rulesFile: path.join(dir, 'home', 'tasks', 'abc123-0f0f', 'guard.json'), restrictions: await projectRestrictions(project, head) });
    // Nothing that widens: no allow rule, no mode, no extra folder, no env, no project hook; and not disableAllHooks (M0).
    expect(settings.permissions).toEqual({ deny: ['Read(./.env)'], ask: ['Bash(git push *)'] });
    const text = JSON.stringify(settings);
    for (const word of ['allow', 'defaultMode', 'additionalDirectories', 'ANTHROPIC_BASE_URL', 'disableAllHooks', 'bypassPermissions']) expect(text, word).not.toContain(`"${word}`);
    expect(settings).toMatchObject({ disableBundledSkills: true, disableSkillShellExecution: true, enabledPlugins: { 'cc-plugin-plugin-authoring@builtin': false } });
    expect((settings.hooks as { PreToolUse: unknown[] }).PreToolUse).toHaveLength(1);
  });

  it('has no restrictions without a settings file or with one that does not parse', async () => {
    const head = await repoWith({ 'a.txt': 'a\n' });
    expect(await projectRestrictions(project, head)).toEqual({ deny: [], ask: [] });
    expect(taskFlagSettings({ worktree: path.join(dir, 'w'), rulesFile: path.join(dir, 'g.json'), restrictions: { deny: [], ask: [] } }).permissions).toBeUndefined();
  });

  it('leaves out the memory files of every folder above the worktree, AGENTS.md included', () => {
    const worktree = path.join(dir, 'home', 'tasks', 'abc123-0f0f', 'work');
    const patterns = excludesAbove(worktree);
    const forward = (file: string) => file.split(path.sep).join('/');
    for (const folder of [path.join(dir, 'home', 'tasks', 'abc123-0f0f'), path.join(dir, 'home'), dir, path.parse(dir).root]) {
      for (const name of ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', path.join('.claude', 'AGENTS.md'), path.join('.claude', 'rules', '**')]) {
        expect(patterns).toContain(forward(path.join(folder, name)));
      }
    }
    expect(patterns).not.toContain(forward(path.join(worktree, 'CLAUDE.md')));
  });

  it('offers Skill only when the project has skills, and turns Claude Code\'s own skills and cron off', () => {
    expect(taskTools([])).not.toContain('Skill');
    expect(taskTools(['deploy'])).toContain('Skill');
    for (const tools of [taskTools([]), taskTools(['deploy'])]) {
      expect(tools).toEqual(expect.arrayContaining(['Glob', 'Grep', 'Bash', 'PowerShell']));
      for (const tool of ['CronCreate', 'RemoteTrigger', 'Monitor', 'EnterWorktree', 'Workflow', 'NotebookEdit']) expect(tools).not.toContain(tool);
    }
    expect(TASK_ENV).toEqual({ CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1', CLAUDE_CODE_DISABLE_CRON: '1' });
  });
});
