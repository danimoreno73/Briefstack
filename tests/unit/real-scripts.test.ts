import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { GIT_STATUS_ARGS, effortRecorder, onlyThisCommand, parseInterviewerTarget } from '../../scripts/real/common.js';

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

describe('phase 4 real checks: prepared, guarded, and kept off real data', () => {
  const read = (name: string) => readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', name), 'utf8');

  it('each asks for --yes, works in a temp sandbox and cleans it up', async () => {
    for (const name of ['check-chat-read.ts', 'check-chat-start-creation.ts', 'check-two-creations.ts', 'probe-h0-phase4.ts']) {
      const script = await read(name);
      expect(script, name).toContain('requireConfirmation(');
      expect(script, name).toMatch(/await sandbox\('/);
      expect(script, name).toContain('box.cleanup()');
      expect(script, name).not.toContain('bypassPermissions');
    }
  });

  it('the chat checks run on haiku through the real chat code, and the creation behind the second one is fake', async () => {
    for (const name of ['check-chat-read.ts', 'check-chat-start-creation.ts']) {
      const script = await read(name);
      expect(script).toContain("profile: async () => ({ model: 'haiku', effort: 'low' })");
      expect(script).toContain('new SdkChatRunner(');
      expect(script).toContain('ChatManager.open(');
    }
    const start = await read('check-chat-start-creation.ts');
    expect(start).toContain('new FakeRunner(');
    expect(start).toContain("chat.confirm(first, 'decline')");
    expect(start).toContain("chat.confirm(second, 'confirm')");
  });

  it('the two-creations check never rewrites the agent files and stops above 70% of the 5-hour window', async () => {
    const script = await read('check-two-creations.ts');
    expect(script).not.toMatch(/usageSet|applyProfile/);
    expect(script).toContain('usage set saver');
    expect(script).toContain('> 70');
    expect(script).toContain("activeProfile: 'saver'");
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

describe('check-subagent: a report through the runner options', () => {
  it('uses the runner options and environment, does not ask for the foreground, and checks the report and the waiting', async () => {
    const script = await readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'check-subagent.ts'), 'utf8');
    expect(script).toContain('buildQueryOptions(');
    expect(script).toContain('env: sessionEnv(box)');
    expect(script).toContain("model: 'haiku'");
    expect(script).not.toContain('run_in_background');
    for (const name of [
      'the Agent call ran in the foreground and the word reached the main session',
      'the main session answered with the word',
      'the guard denied nothing',
      'the main session ran no shell command',
    ]) {
      expect(script).toMatch(new RegExp(`ok =\\s*report\\(\\s*'${name}'`));
    }
  });
});

describe('check-web-tools: approve_spec through the runner options', () => {
  it('uses the runner options and the real briefstack-web server, and checks the tools, the call and the answer', async () => {
    const script = await readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'check-web-tools.ts'), 'utf8');
    expect(script).toContain('buildQueryOptions(');
    expect(script).toContain('env: sessionEnv(box)');
    expect(script).toContain('mcpServers: { [WEB_SERVER_NAME]: webTools }');
    expect(script).toContain("sessionModel: 'haiku'");
    // It writes only inside its own sandbox.
    expect(script).toContain("path.join(box.sessions, 'check')");
    for (const name of [
      'the init message lists both browser tools',
      'approve_spec reached the runner side with the two files',
      'the decision came back to the main session',
      'the guard denied nothing',
      'approve_spec needed no permission prompt',
    ]) {
      expect(script).toMatch(new RegExp(`ok =\\s*report\\(\\s*'${name}'`));
    }
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

describe('check-interviewer-target: runs only the interviewer on two fixed ideas', () => {
  it('reads the last TARGET line of a report', () => {
    expect(parseInterviewerTarget('known: …\nTARGET: claude-app | RULE: library/rules/target.md')).toEqual({
      target: 'claude-app',
      rule: 'library/rules/target.md',
    });
    expect(parseInterviewerTarget('TARGET: claude-app | RULE: x\n`TARGET: claude-code | RULE: none`\n')).toEqual({
      target: 'claude-code',
      rule: 'none',
    });
    expect(parseInterviewerTarget('TARGET: both | RULE: x')).toBeUndefined();
    expect(parseInterviewerTarget('The target is claude-code.')).toBeUndefined();
  });

  it('uses the interviewer prompt and model, read-only tools, an empty context, and checks target and rule', async () => {
    const script = await readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'check-interviewer-target.ts'), 'utf8');
    expect(script).toContain("path.join(PACKAGE_ROOT, '.claude', 'agents', 'interviewer.md')");
    expect(script).toContain('systemPrompt: body');
    expect(script).toContain("tools: ['Read', 'Grep', 'Glob']");
    expect(script).toContain('settingSources: []');
    expect(script).toContain('cwd: box.project');
    expect(script).toContain('Library context: none');
    expect(script).toContain("expected: 'claude-code'");
    expect(script).toContain("expected: 'claude-app'");
    expect(script).not.toContain('bypassPermissions');
    expect(script).toContain('ok = report(`${expected}: recommended target`');
    expect(script).toContain('ok = report(`${expected}: cites the rule`');
  });
});
