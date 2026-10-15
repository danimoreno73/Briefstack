import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { GIT_STATUS_ARGS, effortRecorder, onlyThisCommand } from '../../scripts/real/common.js';

// These scripts start real Claude Code sessions and are never run by the tests;
// what can be checked without one is checked here.

describe('check-effort: reads the effort from a Stop hook', () => {
  const signal = { signal: new AbortController().signal };
  const stop = (extra: Record<string, unknown>) =>
    ({ hook_event_name: 'Stop', session_id: 's', transcript_path: '', cwd: '', stop_hook_active: false, ...extra }) as never;

  it('keeps the level a Stop hook input reports, and nothing else', async () => {
    const recorder = effortRecorder();
    await recorder.hook(stop({}), undefined, signal);
    expect(recorder.level()).toBeUndefined();
    await recorder.hook({ hook_event_name: 'PreToolUse', effort: { level: 'max' } } as never, undefined, signal);
    expect(recorder.level()).toBeUndefined();
    await recorder.hook(stop({ effort: { level: 'low' } }), undefined, signal);
    expect(recorder.level()).toBe('low');
  });

  it('registers that hook and no longer trusts the init message', async () => {
    const script = await readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'check-effort.ts'), 'utf8');
    expect(script).toContain('hooks: { Stop: [{ hooks: [recorder.hook] }] }');
    expect(script).toContain('level === effort');
    expect(script).not.toMatch(/\{ effort\?: unknown \}\)\.effort/);
  });
});

describe('check-guard-auto: the cases it tries', () => {
  it('asks for a .git write, Monitor and a main-session WebFetch, and expects the guard to deny each', async () => {
    const script = await readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'check-guard-auto.ts'), 'utf8');
    expect(script).toContain("path.join(box.projects, 'app', '.git', 'hooks', 'pre-commit')");
    expect(script).toContain("options.tools = [...(options.tools as string[]), 'Monitor']");
    expect(script).toContain('Use the Monitor tool');
    for (const name of [
      'web fetch by the main session denied by the guard',
      'write in .git denied by the guard',
      'write in .git left no file',
      'Monitor denied by the guard',
      'Monitor command did not run',
    ]) {
      expect(script).toMatch(new RegExp(`ok =\\s*report\\(\\s*'${name.replaceAll('.', '\\.')}'`));
    }
    expect(script).not.toContain('decided by the classifier');
  });
});

describe('check-kill-tree: the one command it allows', () => {
  const expected = 'node "C:/Temp/briefstack-real-kill-abc123/sleeper.cjs"';
  const decide = onlyThisCommand(expected);

  it('allows that command, character for character, in the shell tools', async () => {
    expect(await decide('Bash', { command: expected })).toMatchObject({ behavior: 'allow' });
    expect(await decide('PowerShell', { command: `  ${expected}  ` })).toMatchObject({ behavior: 'allow' });
  });

  it('denies any other command, a chained one, or one with the path changed', async () => {
    for (const command of [
      'echo hello',
      `${expected} && echo hi`,
      `${expected}; rm -rf /`,
      `${expected} | tee out.txt`,
      `${expected} > ${'C:/Users/x/out.txt'}`,
      `cd / && ${expected}`,
      'node "C:/Temp/briefstack-real-kill-abc123/other.cjs"',
      'node "C:/Temp/sleeper.cjs"',
      "node 'C:/Temp/briefstack-real-kill-abc123/sleeper.cjs'",
      `${expected}\nrm x`,
      '',
    ]) {
      expect(await decide('Bash', { command }), command).toMatchObject({ behavior: 'deny' });
    }
    expect(await decide('Bash', {})).toMatchObject({ behavior: 'deny' });
    expect(await decide('Bash', { command: 42 })).toMatchObject({ behavior: 'deny' });
  });

  it('denies every other tool, even with the right command in its input', async () => {
    for (const tool of ['Write', 'Edit', 'Read', 'WebFetch', 'AskUserQuestion', 'Agent', 'mcp__x__y']) {
      expect(await decide(tool, { command: expected, file_path: 'C:/Temp/x', url: 'https://example.com' }), tool).toMatchObject({ behavior: 'deny' });
    }
  });

  it('is what the script uses, with only the shell tools available', async () => {
    const script = await readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'check-kill-tree.ts'), 'utf8');
    expect(script).toContain('canUseTool: onlyThisCommand(command)');
    expect(script).toContain("tools: ['Bash', 'PowerShell']");
    expect(script).not.toContain("behavior: 'allow'");
  });
});

describe('preflight: nothing is written to the real repo or library', () => {
  it('runs git status without optional locks, so the index is not refreshed', async () => {
    expect(GIT_STATUS_ARGS).toEqual(['--no-optional-locks', 'status', '--porcelain']);
    const script = await readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'preflight.ts'), 'utf8');
    // Every git call goes through the same arguments.
    expect(script.match(/run\('git'/g)).toHaveLength(2);
    expect(script.match(/run\('git', \[\.\.\.GIT_STATUS_ARGS\]/g)).toHaveLength(2);
  });

  it('does not write anywhere, in the script itself', async () => {
    const script = await readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'preflight.ts'), 'utf8');
    for (const forbidden of ['writeFile', 'appendFile', 'mkdir(', 'rm(', 'unlink', 'rename(']) expect(script, forbidden).not.toContain(forbidden);
  });
});
