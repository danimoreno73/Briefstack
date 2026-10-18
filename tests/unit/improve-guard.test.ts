import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateImproveToolUse, improveCanUseTool, improveGuardHook, type ImproveGuardRules } from '../../src/improve/guard.js';
import {
  decideImproveToolUse,
  improveGuardCommandLine,
  improveGuardSettings,
  IMPROVE_GUARD_TIMEOUT_S,
  writeImproveRulesSync,
} from '../../src/improve/guardCommand.js';
import { tempDir, writeTree } from '../helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
let rules: ImproveGuardRules;
let rulesFile: string;

const SUBMIT = 'mcp__briefstack-improve__submit_proposal';

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('improve-guard'));
  const worktree = path.join(dir, 'wt');
  const evidence = path.join(dir, 'p1', 'evidence');
  await writeTree(worktree, {
    '.claude/agents/interviewer.md': '---\nname: interviewer\n---\nBody\n',
    '.claude/skills/new-project/SKILL.md': '---\nname: new-project\n---\nBody\n',
    '.claude/settings.json': '{}',
    'library/rules/target.md': '# Rule\n',
    'src/cli.ts': 'export {};\n',
    'package.json': '{}',
  });
  await writeTree(evidence, { 'request.md': 'Do better.\n' });
  await writeTree(dir, { 'outside/secret.md': 'x\n' });
  rules = { worktree, evidence: [evidence], submitTool: SUBMIT };
  rulesFile = path.join(dir, 'p1', 'guard.json');
  writeImproveRulesSync(rulesFile, { v: 1, ...rules, evidence: [...rules.evidence] });
});

afterEach(async () => {
  await cleanup();
});

const at = (...parts: string[]) => path.join(rules.worktree, ...parts);
const decide = (tool_name: string, tool_input: unknown) => evaluateImproveToolUse(rules, { tool_name, tool_input });

describe('improvement guard', () => {
  it('allows writes to existing allowlisted files in the worktree', async () => {
    for (const file of [at('.claude', 'agents', 'interviewer.md'), at('.claude', 'skills', 'new-project', 'SKILL.md'), at('library', 'rules', 'target.md')]) {
      expect((await decide('Edit', { file_path: file })).verdict, file).toBe('allow');
      expect((await decide('Write', { file_path: file })).verdict, file).toBe('allow');
    }
  });

  it('denies writes anywhere else, new files and relative paths', async () => {
    const denied = [
      at('src', 'cli.ts'),
      at('package.json'),
      at('.claude', 'settings.json'),
      at('.claude', 'agents', 'new-agent.md'),
      at('library', 'rules', 'new.md'),
      at('.git', 'config'),
      path.join(dir, 'outside', 'secret.md'),
      path.join(rules.evidence[0] as string, 'request.md'),
      rulesFile,
      '.claude/agents/interviewer.md',
    ];
    for (const file of denied) expect((await decide('Write', { file_path: file })).verdict, file).toBe('deny');
    expect((await decide('Write', {})).verdict).toBe('deny');
    expect((await decide('NotebookEdit', { notebook_path: at('library', 'rules', 'target.md') })).verdict).toBe('deny');
  });

  it('allows reads in the worktree and the evidence only', async () => {
    expect((await decide('Read', { file_path: at('src', 'cli.ts') })).verdict).toBe('allow');
    expect((await decide('Read', { file_path: path.join(rules.evidence[0] as string, 'request.md') })).verdict).toBe('allow');
    expect((await decide('Glob', { pattern: '**/*.md' })).verdict).toBe('allow');
    expect((await decide('Grep', { pattern: 'x', path: 'library' })).verdict).toBe('allow');
    expect((await decide('Read', { file_path: path.join(dir, 'outside', 'secret.md') })).verdict).toBe('deny');
    expect((await decide('Read', { file_path: rulesFile })).verdict).toBe('deny');
    expect((await decide('Grep', { pattern: 'x', path: dir })).verdict).toBe('deny');
    expect((await decide('Read', { file_path: at('.git', 'config') })).verdict).toBe('deny');
    expect((await decide('Glob', { pattern: '*', path: at('node_modules') })).verdict).toBe('deny');
  });

  it('denies a Glob pattern that is absolute or climbs with ..', async () => {
    const outside = path.join(dir, 'outside').replaceAll('\\', '/');
    for (const pattern of [`${outside}/**/*.md`, '/etc/**', 'C:/Users/**/*.md', 'c:\\Users\\*', '\\\\server\\share\\*', '~/**/*.md', '../**/*.md', 'library/../../outside/*', '..\\*']) {
      expect((await decide('Glob', { pattern })).verdict, pattern).toBe('deny');
      expect((await decide('Glob', { pattern, path: at('library') })).verdict, pattern).toBe('deny');
    }
    expect((await decide('Glob', { pattern: 'library/**/*.md', path: at() })).verdict).toBe('allow');
    expect((await decide('Glob', { pattern: '**/*.md', path: rules.evidence[0] })).verdict).toBe('allow');
  });

  it('denies every other tool and allows only its own submit tool', async () => {
    for (const tool of ['Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'mcp__other__x', 'mcp__briefstack-chat__start_creation']) {
      expect((await decide(tool, { command: 'echo hi' })).verdict, tool).toBe('deny');
    }
    expect((await decide(SUBMIT, {})).verdict).toBe('allow');
  });

  it('answers the hook and canUseTool the same way', async () => {
    const denials: string[] = [];
    const hook = improveGuardHook(rules, (tool) => denials.push(tool));
    const signal = new AbortController().signal;
    const base = { session_id: 's', transcript_path: '', cwd: rules.worktree, tool_use_id: 't' };
    const allowed = await hook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: at('library', 'rules', 'target.md') } }, 't', { signal });
    expect(allowed).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    const denied = await hook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, 't', { signal });
    expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(denials).toEqual(['Bash']);
    const can = improveCanUseTool(rules);
    const options = { signal, toolUseID: 't' } as Parameters<typeof can>[2];
    expect(await can('Edit', { file_path: at('.claude', 'agents', 'interviewer.md') }, options)).toMatchObject({ behavior: 'allow' });
    expect(await can('Edit', { file_path: at('src', 'cli.ts') }, options)).toMatchObject({ behavior: 'deny' });
    expect(await can('Bash', { command: 'ls' }, options)).toMatchObject({ behavior: 'deny' });
  });
});

describe('improvement command hook', () => {
  const call = (tool_name: string, tool_input: unknown) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', tool_name, tool_input });

  it('denies what the guard denies and lets the rest through', async () => {
    expect(await decideImproveToolUse(call('Edit', { file_path: at('library', 'rules', 'target.md') }), rulesFile)).toEqual({ code: 0 });
    expect((await decideImproveToolUse(call('Edit', { file_path: at('src', 'cli.ts') }), rulesFile)).code).toBe(2);
    expect((await decideImproveToolUse(call('Bash', { command: 'ls' }), rulesFile)).code).toBe(2);
    expect(await decideImproveToolUse(JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }), rulesFile)).toEqual({ code: 0 });
  });

  it('fails closed', async () => {
    const ok = call('Edit', { file_path: at('library', 'rules', 'target.md') });
    expect((await decideImproveToolUse(ok, path.join(dir, 'none.json'))).code).toBe(2);
    expect((await decideImproveToolUse('{', rulesFile)).code).toBe(2);
    expect((await decideImproveToolUse(JSON.stringify({ hook_event_name: 'PreToolUse' }), rulesFile)).code).toBe(2);
    await writeFile(rulesFile, JSON.stringify({ v: 1, worktree: 'relative', evidence: [], submitTool: SUBMIT }), 'utf8');
    expect((await decideImproveToolUse(ok, rulesFile)).code).toBe(2);
  });

  it('is registered on every tool, blocking when it fails', () => {
    const settings = improveGuardSettings(rulesFile);
    expect(settings.hooks.PreToolUse).toEqual([
      { hooks: [{ type: 'command', command: process.execPath, args: improveGuardCommandLine(rulesFile).args, onFailure: 'block', timeout: IMPROVE_GUARD_TIMEOUT_S }] },
    ]);
  });

  it('runs as a process: exit 0 when allowed, 2 with the reason when denied', async () => {
    const run = (stdin: string) =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, improveGuardCommandLine(rulesFile).args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => (stderr += chunk));
        child.on('exit', (code) => resolve({ code, stderr }));
        child.stdin.end(stdin);
      });
    await mkdir(path.join(dir, 'x'), { recursive: true });
    expect(await run(call('Edit', { file_path: at('library', 'rules', 'target.md') }))).toEqual({ code: 0, stderr: '' });
    const denied = await run(call('Write', { file_path: at('src', 'cli.ts') }));
    expect(denied.code).toBe(2);
    expect(denied.stderr).toContain('not a file an improvement may change');
  }, 30_000);
});
