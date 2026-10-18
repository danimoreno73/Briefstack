import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPathInside, resolveHome, type PathEnv } from '../../src/config/index.js';
import { cleanEnvironment } from '../../src/creation/sdkRunner.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import type { Pending } from '../../src/creation/manager.js';
import {
  GIT_STATUS_ARGS,
  CheckStop,
  autoAnswer,
  effortRecorder,
  filesOutside,
  hardKill,
  processesMentioning,
  mentionedPaths,
  onlyThisCommand,
  parseInterviewerTarget,
  sandbox,
  startCheck,
  workRootCandidates,
} from '../../scripts/real/common.js';
import { tempDir } from '../helpers.js';

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

describe('sandbox: a work folder outside the protected folders, and the temp home for every child', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('real-sandbox'));
  });
  afterEach(() => cleanup());

  // A stand-in for the user's environment: its own home, library, projects folder and %LOCALAPPDATA%.
  const userEnv = (): PathEnv => ({
    env: { BRIEFSTACK_HOME: path.join(dir, 'real-home'), LOCALAPPDATA: path.join(dir, 'local') },
    homedir: path.join(dir, 'user'),
    pathApi: path,
    caseInsensitive: process.platform !== 'linux',
  });

  it('skips a candidate inside %LOCALAPPDATA% or the real projects folder, and points BRIEFSTACK_HOME at the sandbox', async () => {
    const pathEnv = userEnv();
    await mkdir(path.join(dir, 'real-home'), { recursive: true });
    await writeFile(path.join(dir, 'real-home', 'config.json'), JSON.stringify({ projectsDir: path.join(dir, 'real-projects') }), 'utf8');
    const box = await sandbox('t', {
      pathEnv,
      candidates: [path.join(dir, 'local', 'Temp'), path.join(dir, 'real-projects', 'x'), 'relative', path.join(dir, 'work')],
    });
    expect(isPathInside(box.dir, path.join(dir, 'work'), pathEnv)).toBe(true);
    expect(pathEnv.env.BRIEFSTACK_HOME).toBe(box.home);
    for (const folder of [box.home, box.project, box.projects, box.sessions]) expect((await stat(folder)).isDirectory()).toBe(true);
    // The temp home is what children get from the environment cleaning.
    expect(cleanEnvironment(pathEnv.env, resolveHome(pathEnv)).env.BRIEFSTACK_HOME).toBe(box.home);
    expect(await readdir(path.join(dir, 'local'), { recursive: true }).catch(() => [])).toEqual([]);
    await box.cleanup();
    await expect(stat(box.dir)).rejects.toThrow();
  });

  it('stops before creating anything when every candidate is protected', async () => {
    const pathEnv = userEnv();
    await expect(sandbox('t', { pathEnv, candidates: [path.join(dir, 'local', 'Temp'), path.join(dir, 'user', '.claude', 'x'), dir] })).rejects.toThrow(
      /No work folder outside the protected folders/,
    );
    expect(pathEnv.env.BRIEFSTACK_HOME).toBe(path.join(dir, 'real-home'));
    await expect(stat(path.join(dir, 'local'))).rejects.toThrow();
  });

  it('on Windows the default candidates leave the system temp folder for one in the user folder', () => {
    const pathEnv: PathEnv = { env: {}, homedir: 'C:\\Users\\ana', pathApi: path.win32, caseInsensitive: true };
    expect(workRootCandidates(pathEnv, 'C:\\Users\\ana\\AppData\\Local\\Temp')).toEqual(['C:\\Users\\ana\\AppData\\Local\\Temp', 'C:\\Users\\ana\\.briefstack-real']);
    expect(workRootCandidates({ ...pathEnv, env: { BRIEFSTACK_REAL_WORKDIR: 'D:\\scratch' } })).toEqual(['D:\\scratch']);
  });
});

describe('autoAnswer: the scripts never answer with a folder outside the sandbox', () => {
  const win = { pathApi: path.win32, caseInsensitive: true };
  const posix = { pathApi: path.posix, caseInsensitive: false };
  const root = 'C:\\work\\briefstack-real-x\\projects';
  const question = (text: string, labels: string[]): Pending => ({
    id: 'p1',
    kind: 'question',
    payload: { questions: [{ question: text, header: '', multiSelect: false, options: labels.map((label) => ({ label, description: '' })) }] },
  });

  it('finds drive, UNC, home and POSIX paths, and not slashes inside words, numbers or URLs', () => {
    expect(mentionedPaths('Create it in C:/Users/ana/briefstack-projects/packing (Recommended).')).toEqual(['C:/Users/ana/briefstack-projects/packing']);
    expect(mentionedPaths('at \\\\server\\share\\p, or ~/p, or /home/ana/p.')).toEqual(['\\\\server\\share\\p', '~/p', '/home/ana/p']);
    expect(mentionedPaths('Markdown and/or text, 1/2 page, see https://example.com/a, a / b')).toEqual([]);
  });

  it('cancels when no option is a folder inside the sandbox, as in the failed run', () => {
    const asked = question('Where should the project be created?', ['C:/Users/ana/briefstack-projects/packing-checklist', 'C:/Users/ana/packing-checklist']);
    expect(autoAnswer(asked, root, { style: win })).toMatchObject({ kind: 'cancel' });
  });

  it('picks the first option inside the sandbox, even when it is not the first one', () => {
    const asked = question('Where?', ['C:/Users/ana/briefstack-projects/packing', `${root}\\packing`, 'Somewhere else']);
    expect(autoAnswer(asked, root, { style: win })).toEqual({ kind: 'answer', answer: { 'Where?': `${root}\\packing` } });
    // Case and slashes do not matter on Windows.
    const mixed = question('Where?', ['c:/WORK/briefstack-real-x/projects/packing']);
    expect(autoAnswer(mixed, root, { style: win })).toMatchObject({ kind: 'answer' });
  });

  it('takes the first option of a question that names no folder, and cancels a yes/no about a folder outside', () => {
    expect(autoAnswer(question('Which format?', ['Markdown', 'Plain text']), root, { style: win })).toEqual({ kind: 'answer', answer: { 'Which format?': 'Markdown' } });
    expect(autoAnswer(question('Create it in C:/Users/ana/p?', ['Yes', 'No']), root, { style: win })).toMatchObject({ kind: 'cancel' });
    expect(autoAnswer(question('Create it in ~/p?', ['Yes', 'No']), '/tmp/box/projects', { style: posix })).toMatchObject({ kind: 'cancel' });
  });

  it('approves a spec only when its summary names no folder outside, grants only inside, and denies permissions', () => {
    const spec: Pending = { id: 'p2', kind: 'spec', payload: { specFile: 's', summaryFile: 'm' } };
    expect(autoAnswer(spec, root, { style: win, summary: `Folder: ${root}\\packing` })).toEqual({ kind: 'answer', answer: { decision: 'approve' } });
    expect(autoAnswer(spec, root, { style: win, summary: 'Folder: D:/projects/packing' })).toMatchObject({ kind: 'cancel' });
    expect(autoAnswer(spec, root, { style: win, summary: null })).toMatchObject({ kind: 'cancel' });
    const grant = (dir: string): Pending => ({ id: 'p3', kind: 'grant', payload: { dir } });
    expect(autoAnswer(grant(`${root}\\packing`), root, { style: win })).toEqual({ kind: 'answer', answer: true });
    expect(autoAnswer(grant('C:\\Users\\ana\\briefstack-projects\\packing'), root, { style: win })).toEqual({ kind: 'answer', answer: false });
    expect(autoAnswer({ id: 'p4', kind: 'permission', payload: { toolName: 'Bash', summary: 'x' } }, root, { style: win })).toEqual({ kind: 'answer', answer: 'deny' });
  });

  it('is what the two-creations check answers with, and a cancel cancels that creation', async () => {
    const script = await readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'check-two-creations.ts'), 'utf8');
    expect(script).toContain('autoAnswer(pending, box.projects, { summary })');
    expect(script).toContain('manager.cancel(state.id)');
    expect(script).not.toContain('q.options[0]');
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

describe('every real script closes what it started, whatever happens', () => {
  type Listener = (error: unknown) => void;
  const fakeProcess = () => {
    const listeners = new Map<string, Listener[]>();
    const exits: number[] = [];
    return {
      exits,
      emit: (event: string, error: unknown) => {
        for (const listener of listeners.get(event) ?? []) listener(error);
      },
      count: () => [...listeners.values()].reduce((sum, list) => sum + list.length, 0),
      on: (event: string, listener: Listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
      off: (event: string, listener: Listener) =>
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((entry) => entry !== listener),
        ),
      exit: (code: number) => exits.push(code),
    };
  };

  it('on an error, runs every close once, last added first, even when one throws, and fails', async () => {
    const proc = fakeProcess();
    const lines: string[] = [];
    const check = startCheck(proc, (line) => lines.push(line));
    const order: string[] = [];
    check.add(() => order.push('sandbox'));
    check.add(async () => {
      order.push('manager');
      throw new Error('stuck');
    });
    const tracked = { killTree: async () => void order.push('tree') };
    check.query({ close: () => order.push('query') }, tracked);
    check.fail(new Error('creation.noReply'));
    await Promise.all([check.close(), check.close()]);
    expect(order).toEqual(['query', 'tree', 'manager', 'sandbox']);
    expect(lines.join('\n')).toContain('creation.noReply');
    expect(lines.join('\n')).toContain('stuck');
    expect(check.exitCode(true)).toBe(1);
    expect(proc.count()).toBe(0);
  });

  it('passes only when nothing failed; a CheckStop sets its own code', async () => {
    const quiet = startCheck(fakeProcess(), () => undefined);
    await quiet.close();
    expect(quiet.exitCode(true)).toBe(0);
    expect(quiet.exitCode(false)).toBe(1);
    const stopped = startCheck(fakeProcess(), () => undefined);
    stopped.fail(new CheckStop(2, 'not starting'));
    expect(stopped.exitCode(true)).toBe(2);
  });

  it('closes everything and exits with 1 on an error nothing awaited', async () => {
    const proc = fakeProcess();
    const check = startCheck(proc, () => undefined);
    const closed: string[] = [];
    check.add(() => closed.push('manager'));
    proc.emit('unhandledRejection', new Error('late'));
    await check.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toEqual(['manager']);
    expect(proc.exits).toEqual([1]);
  });

  it('is used by every script that starts a session, a manager or a sandbox', async () => {
    const dir = path.join(PACKAGE_ROOT, 'scripts', 'real');
    const scripts = (await readdir(dir)).filter((name) => name.endsWith('.ts') && name !== 'common.ts');
    expect(scripts.length).toBeGreaterThan(5);
    for (const name of scripts) {
      const source = await readFile(path.join(dir, name), 'utf8');
      const where = (text: string) => `${name}: ${text}`;
      expect(source, where('startCheck')).toContain('startCheck()');
      expect(source, where('catch')).toMatch(/\} catch \(error\) \{\s+check\.fail\(error\);\s+\} finally \{\s+await check\.close\(\);\s+\}/);
      expect(source, where('exit code')).toContain('process.exit(check.exitCode(');
      // After the check starts, only its exit code ends the process: an early exit would skip the closes.
      const body = source.slice(source.indexOf('startCheck()'));
      expect(body.match(/process\.exit\(/g)?.length, where('one exit')).toBe(1);
      // Every query is registered, and so is every manager and sandbox.
      expect(source.match(/(?<![.\w])query\(/g)?.length ?? 0, where('queries')).toBe(source.match(/check\.query\(query\(/g)?.length ?? 0);
      const count = (pattern: RegExp) => source.match(pattern)?.length ?? 0;
      expect(count(/await sandbox\(/g), where('sandbox')).toBe(count(/check\.add\(\(\) => box\.cleanup\(\)\)/g));
      expect(count(/createWebCreations\(|new CreationManager\(|ChatManager\.open\(/g), where('managers')).toBe(count(/check\.add\(\(\) => \w+\.shutdown\(\)\)/g));
    }
  });
});

describe('check-two-creations: acts on fresh state only', () => {
  it('reads each creation just before acting on it and skips finished ones', async () => {
    const script = await readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'check-two-creations.ts'), 'utf8');
    expect(script).toMatch(/for \(const id of ids\) \{\s+const state = manager\.get\(id\);\s+if \(state\.status === 'finished'\) continue;/);
    expect(script).not.toContain('for (const state of states())');
  });
});

describe('check-server-crash: kills a server while a creation waits on it', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('real-crash'));
  });
  afterEach(() => cleanup());

  it('lists the files outside the allowed folders', async () => {
    await writeFile(path.join(dir, 'top.txt'), 'x', 'utf8');
    for (const folder of ['projects/app', 'home/sessions', 'outside/deep']) await mkdir(path.join(dir, folder), { recursive: true });
    await writeFile(path.join(dir, 'projects', 'app', 'a.md'), 'x', 'utf8');
    await writeFile(path.join(dir, 'home', 'sessions', 'e.jsonl'), 'x', 'utf8');
    await writeFile(path.join(dir, 'outside', 'deep', 'idea.txt'), 'x', 'utf8');
    expect(await filesOutside(dir, [path.join(dir, 'projects'), path.join(dir, 'home')])).toEqual(['outside/deep/idea.txt', 'top.txt']);
  });

  it('finds a process by a folder named on its command line, with either slash', async () => {
    const marker = path.join(dir, 'marker-folder');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker.replaceAll('\\', '/')], { stdio: 'ignore' });
    // Listened for from the start: the exit may come before the kill call returns.
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      let found: { pid: number }[] = [];
      for (let i = 0; i < 10 && found.length === 0; i += 1) {
        found = await processesMentioning(marker);
        if (found.length === 0) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(found.map((entry) => entry.pid)).toContain(child.pid);
    } finally {
      await hardKill(child.pid ?? 0);
    }
    await exited;
    expect((await processesMentioning(marker)).map((entry) => entry.pid)).not.toContain(child.pid);
  }, 120_000);

  it('kills the server without its children, watches, restarts, and checks processes, run files, sessions and writes', async () => {
    const script = await readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'check-server-crash.ts'), 'utf8');
    const common = await readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'common.ts'), 'utf8');
    // A hard kill: only that pid, never the tree.
    expect(common).toContain("await run('taskkill', ['/PID', String(pid), '/F']);");
    expect(common).toContain("process.kill(pid, 'SIGKILL');");
    expect(script).toContain('await hardKill(server.pid)');
    expect(script).toContain("'src', 'cli.ts'), 'web', '--port', '0'");
    expect(script).toContain("'fixtures', 'crash-throw.ts'");
    expect(script).toContain("await sandbox('server-crash')");
    expect(script).toContain("activeProfile: 'saver'");
    for (const expected of [
      'A: the command-hook guard ran in the session',
      'A: after the restart no process mentions the work folder',
      'A: the run folder is gone',
      'A: the session is closed as interrupted',
      'B: no process mentions the work folder, before any restart',
      'nothing was written in the work folder outside the projects folder and the temp home',
      'the repo git status did not change',
    ]) {
      expect(script).toContain(expected);
    }
    expect(script).not.toContain('bypassPermissions');
    const fixture = await readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'fixtures', 'crash-throw.ts'), 'utf8');
    expect(fixture).toContain("throw new Error('crash on purpose, with a tool call waiting')");
    expect(fixture).toContain('process.env.BRIEFSTACK_HOME === undefined');
  });
});
