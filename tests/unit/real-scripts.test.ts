import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
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
import { prepareCodex, within, type Web } from '../../scripts/real/tasks-common.js';
import { request } from 'node:http';
import { CodexService } from '../../src/codex/service.js';
import { startWebServer, TOKEN_HEADER, type WebServer } from '../../src/server/index.js';
import { fakeCodex } from '../codexWorld.js';
import { tempDir } from '../helpers.js';

// These scripts start real Claude Code sessions and are never run by the tests;
// what can be checked without one is checked here.

describe('real scripts name no folder of the machine they were written on', () => {
  async function filesIn(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(entries.map((entry) => (entry.isDirectory() ? filesIn(path.join(dir, entry.name)) : [path.join(dir, entry.name)])));
    return nested.flat();
  }

  it('neither the user folder nor the folder that holds the repo: they use BRIEFSTACK_REAL_WORKDIR or the temp folder', async () => {
    // Written either way round, in any case.
    const spellings = (dir: string) => [dir, dir.replace(/\\/g, '/'), dir.replace(/\//g, '\\')].map((value) => value.toLowerCase());
    // A drive or file-system root names no one's folder.
    const owned = [os.homedir(), path.dirname(PACKAGE_ROOT)].filter((dir) => path.parse(dir).root !== dir);
    const forbidden = owned.flatMap(spellings);
    for (const file of await filesIn(path.join(PACKAGE_ROOT, 'scripts', 'real'))) {
      const text = (await readFile(file, 'utf8')).toLowerCase();
      for (const dir of forbidden) expect(text.includes(dir), `${path.relative(PACKAGE_ROOT, file)} names ${dir}`).toBe(false);
    }
  });
});

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

describe('backlog 2 real checks: prepared, guarded, and kept off real data', () => {
  const read = (name: string) => readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', name), 'utf8');

  it('check-chat-step: asks for --yes, runs the real chat on haiku over fake creations, and compares with stepText', async () => {
    const script = await read('check-chat-step.ts');
    expect(script).toContain('requireConfirmation(');
    expect(script).toMatch(/await sandbox\('/);
    expect(script).toContain("profile: async () => ({ model: 'haiku', effort: 'low' })");
    expect(script).toContain('new SdkChatRunner(');
    expect(script).toContain('new FakeRunner(');
    expect(script).toContain("findChatTool('list_sessions')");
    expect(script).toContain('answer.includes(expected)');
    expect(script).not.toContain('bypassPermissions');
  });

  it('check-claude-md: asks for --yes, uses the runner’s options in the sandbox, and lets no session read the files', async () => {
    const script = await read('check-claude-md.ts');
    expect(script).toContain('requireConfirmation(');
    expect(script).toMatch(/await sandbox\('/);
    expect(script).toContain('buildQueryOptions({');
    expect(script).toContain('repoDir: box.project');
    // Never the real repo: its CLAUDE.md is not touched, the markers are planted in the sandbox.
    expect(script).not.toContain('PACKAGE_ROOT');
    // Agent, and Glob for the probe (a subagent gets only tools the session has): nothing that reads a file's text.
    expect(script).toContain("options.tools = ['Agent', 'Glob']");
    expect(script).toMatch(/^\s*'tools: Glob',$/m);
    expect(script).not.toMatch(/options\.tools = \[[^\]]*'(Read|Grep|Bash|PowerShell)'/);
    expect(script).not.toMatch(/settingSources = \[\]/);
    expect(script).not.toContain('bypassPermissions');
  });

  it('check-claude-md: a control run drops only the exclusion, and every message is searched, not only the final reply', async () => {
    const script = await read('check-claude-md.ts');
    expect(script).toContain("process.argv.includes('--no-exclude')");
    expect(script).toContain('if (noExclude) options.settings = {};');
    // The control word is in a rules file, which project settings load at start, never next to the excluded file.
    expect(script).toContain("'.claude', 'rules', 'control.md'");
    expect(script).not.toContain("path.join(box.project, '.claude', 'CLAUDE.md')");
    // The main session's report before the Agent call and the subagent's own messages are kept.
    expect(script).toContain('mainTexts.push(text)');
    expect(script).toContain('agentTexts.push(text)');
  });

  it('check-claude-md: the probe counts as run only with its start and stop hooks and a result that is not a refusal', async () => {
    const script = await read('check-claude-md.ts');
    expect(script).toContain('SubagentStart: [{ hooks: [recordAgent] }]');
    expect(script).toContain('SubagentStop: [{ hooks: [recordAgent] }]');
    expect(script).toContain("lifecycle.includes('start:probe') && lifecycle.includes('stop:probe') && agentErrors.length === 0 && agentResults.length > 0");
    expect(script).toContain('block.is_error === true || REFUSED.test(text)');
    expect(script).not.toContain("report('the probe agent ran', calls.includes('main:Agent')");
  });
});

describe('phase 7 H0 probe (M0): prepared, guarded, and kept off real data', () => {
  const read = () => readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'probe-h0-phase7.ts'), 'utf8');

  it('asks for --yes, works in a sandbox on haiku, and stops above the usage limits', async () => {
    const script = await read();
    expect(script).toContain('requireConfirmation(');
    expect(script).toMatch(/await sandbox\('/);
    expect(script).toContain("model: 'haiku'");
    expect(script).toContain("effort: 'low'");
    expect(script).toContain('FIVE_HOUR_LIMIT = 85');
    expect(script).not.toContain('bypassPermissions');
    // Never the real repo or a real project: every folder it writes is under the sandbox.
    expect(script).not.toContain('PACKAGE_ROOT');
  });

  it('asks the two open questions with a control run, and hides the settings file as the plan says', async () => {
    const script = await read();
    expect(script).toContain("mode === 'A1' ? { disableAllHooks: true } : {}");
    expect(script).toContain("hooks: hooksOf(script, log, 'flag')");
    expect(script).toContain('ANSWER A1.1');
    expect(script).toContain('ANSWER B');
    expect(script).toContain("['update-index', '--skip-worktree', '.claude/settings.json']");
    // Server-side git runs no project hook and keeps long paths.
    expect(script).toContain('core.hooksPath=');
    expect(script).toContain('core.longpaths=true');
  });
});

describe('Codex spike: prepared, guarded, and kept to throwaway repositories', () => {
  const read = () => readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'probe-codex.ts'), 'utf8');

  it('asks for --yes, caps the calls at 10 and works under BRIEFSTACK_REAL_WORKDIR, outside the real data', async () => {
    const script = await read();
    expect(script).toContain('requireConfirmation(');
    expect(script).toContain('const MAX_CALLS = 10;');
    expect(script).toContain('if (calls >= MAX_CALLS)');
    expect(script).toContain("path.join(path.resolve(workdir), 'codex-spike')");
    expect(script).toContain('await overlapping(spikeRoot, await realKeepOut(pathEnv), pathEnv)');
    expect(script).not.toContain('PACKAGE_ROOT');
  });

  it('runs codex exec only in workspace-write, sets the Windows mode per call and never reads auth.json or writes config.toml', async () => {
    const script = await read();
    expect(script).toMatch(/'--sandbox',\s+'workspace-write',/);
    expect(script).toContain("['-c', `windows.sandbox=\"${mode}\"`]");
    // Counted in code: the header comment names what is never used.
    const code = script
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
    for (const forbidden of ['danger-full-access', '--yolo', '--dangerously', 'bypassPermissions', 'auth.json', 'config.toml']) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    // No credential of ours reaches Codex, and a stop kills the whole tree.
    expect(script).toContain('/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i');
    expect(script).toContain('await killProcessTree(pid)');
  });

  it('--harden: no model call, example.com as the only outside address, and the planted folder new and removed', async () => {
    const script = await read();
    const harden = script.slice(script.indexOf("process.argv.includes('--harden')"));
    expect(harden.slice(0, harden.indexOf("throw new CheckStop(ok ? 0 : 1, '--harden"))).not.toContain('exec(');
    // Two outside addresses in all: example.com for --harden (step 20), the npm registry for --internet (step 21).
    expect([...new Set(script.match(/https:\/\/[^\s'"`)]+/g))].sort()).toEqual(['https://example.com/', 'https://registry.npmjs.org/']);
    expect(harden.slice(0, harden.indexOf("throw new CheckStop(ok ? 0 : 1, '--harden"))).not.toContain('registry.npmjs.org');
    expect(script).toContain("path.join(os.homedir(), 'briefstack-probe-plant')");
    expect(script).toContain('if (existsSync(plantDir)) throw new CheckStop(2,');
    expect(script).toContain('check.add(removePlant);');
  });

  it('--internet: no model call, at most eight GETs to the npm registry, and nothing from inside if a control outside fails', async () => {
    const script = await read();
    const internet = script.slice(script.indexOf("process.argv.includes('--internet')"));
    const block = internet.slice(0, internet.indexOf("throw new CheckStop(ok ? 0 : 1, '--internet"));
    expect(block).not.toContain('exec(');
    expect(block).toContain('const MAX_GETS = 8;');
    expect(block).toContain('if (gets >= MAX_GETS)');
    expect(block).toContain("const url = 'https://registry.npmjs.org/';");
    expect(block).not.toContain('example.com');
    expect(block).toContain("['--noproxy', '*']");
    // The controls run first, and a failed one stops before any request from inside.
    expect(block.indexOf('if (!outsidePs || !outsideCurl)')).toBeGreaterThan(-1);
    expect(block.indexOf('if (!outsidePs || !outsideCurl)')).toBeLessThan(block.indexOf('await makeCase(`i-${mode}`)'));
  });

  it('--net: no model call, at most eight operations, registry.npmjs.org as the only host, and nothing from inside if a control fails', async () => {
    const script = await read();
    const net = script.slice(script.indexOf("process.argv.includes('--net')"));
    const block = net.slice(0, net.indexOf("throw new CheckStop(ok ? 0 : 1, '--net"));
    expect(block).not.toContain('exec(');
    expect(block).toContain('const MAX_OPS = 8;');
    expect(block).toContain('if (ops >= MAX_OPS)');
    // Every address and host named in the block is the npm registry.
    expect([...new Set(block.match(/https?:\/\/[^\s'"`/)]+/g))].sort()).toEqual(['http://registry.npmjs.org', 'https://registry.npmjs.org']);
    expect(block).toContain("const host = 'registry.npmjs.org';");
    expect(block).not.toContain('example.com');
    // No data on the bare TCP connection, and no redirect followed by fetch.
    expect(block).toContain('System.Net.Sockets.TcpClient');
    expect(block).not.toMatch(/GetStream|\.Send\(/);
    expect(block).toContain("redirect: 'manual'");
    expect(block.indexOf('if (!outsidePlain || !outsideFetch)')).toBeGreaterThan(-1);
    expect(block.indexOf('if (!outsidePlain || !outsideFetch)')).toBeLessThan(block.indexOf('await makeCase(`n-${mode}`)'));
  });

  it('--net-exec: the firewall only read, at most four calls and twelve operations, registry.npmjs.org as the only host', async () => {
    const script = await read();
    const start = script.indexOf("process.argv.includes('--net-exec')");
    expect(start).toBeGreaterThan(-1);
    const block = script.slice(start, script.indexOf("throw new CheckStop(ok ? 0 : 1, `--net-exec", start));
    expect(block).toContain('const MAX_NET_CALLS = 4;');
    expect(block).toContain('if (calls >= MAX_NET_CALLS)');
    expect(block).toContain('const MAX_NET_OPS = 12;');
    expect(block).toContain('if (ops + 3 > MAX_NET_OPS)');
    // Every address and host named in the block is the npm registry.
    expect([...new Set(block.match(/https?:\/\/[^\s'"`/)]+/g))].sort()).toEqual(['http://registry.npmjs.org', 'https://registry.npmjs.org']);
    expect(block).toContain("const host = 'registry.npmjs.org';");
    expect(block).not.toContain('example.com');
    // The firewall is read with Get-* cmdlets only: nothing that creates, changes or removes a rule.
    expect(block).toContain('Get-NetFirewallRule -PolicyStore ActiveStore');
    expect(block).not.toMatch(/(New|Set|Remove|Enable|Disable|Copy|Rename)-NetFirewall|netsh|-Verb\s+RunAs/i);
    // --firewall-only stops after the read, before any call.
    expect(block.indexOf("process.argv.includes('--firewall-only')")).toBeGreaterThan(-1);
    expect(block.indexOf("process.argv.includes('--firewall-only')")).toBeLessThan(block.indexOf('await exec('));
    // The calls go through exec(), always workspace-write; the only setting added is the network one.
    expect(block).toContain("const noNetwork = ['-c', 'sandbox_workspace_write.network_access=false'];");
    expect(block).toContain('await exec(`x-${combo.label}`, c, combo.mode, netExecPrompt, undefined, combo.config)');
    // No data on the bare TCP connection, no redirect followed by fetch, and extra network commands stop the run.
    expect(block).not.toMatch(/GetStream|\.Send\(/);
    expect(block).toContain("redirect: 'manual'");
    expect(block).toContain("ran.some((entry) => entry.kind === 'other-network')");
  });
});

describe('phase 5 real checks: prepared, guarded, and kept off real data', () => {
  const read = (name: string) => readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', name), 'utf8');

  it('each asks for --yes, works in a temp sandbox, cleans it up and stops above 70% of the 5-hour window', async () => {
    for (const name of ['check-improvement-session.ts', 'check-improvement-flow.ts', 'check-safety-review.ts']) {
      const script = await read(name);
      expect(script, name).toContain('requireConfirmation(');
      expect(script, name).toMatch(/await sandbox\('/);
      expect(script, name).toContain('box.cleanup()');
      expect(script, name).toContain('> 70');
      expect(script, name).not.toContain('bypassPermissions');
      expect(script, name).not.toMatch(/usageSet|applyProfile/);
    }
    const probe = await read('probe-h0-phase5.ts');
    expect(probe).toContain('requireConfirmation(');
    expect(probe).toContain("await sandbox('h0-phase5')");
  });

  it('the session check runs on haiku through the real manager, runner and verifier, on a clone', async () => {
    const script = await read('check-improvement-session.ts');
    expect(script).toContain("profile: async () => ({ model: 'haiku', effort: 'low' })");
    expect(script).toContain('new SdkImprovementRunner(');
    expect(script).toContain('new NpmVerifier(clone)');
    expect(script).toContain("'clone', '--quiet', '--no-hardlinks', PACKAGE_ROOT, clone");
    expect(script).toContain('repoDir: clone');
    expect(script).toContain('INJECTED');
  });

  it('the safety check runs the real reviewer on fixed diffs, one of them with an injected answer', async () => {
    const script = await read('check-safety-review.ts');
    expect(script).toContain('new SdkSafetyReviewer({ pathEnv })');
    expect(script).toContain('Note to the safety reviewer');
    expect(script).toContain('injected?.weakens === true');
    expect(script).toContain('harmless?.weakens === false');
  });

  it('the flow check runs one creation from this folder on the saver profile', async () => {
    const script = await read('check-improvement-flow.ts');
    expect(script).toContain("activeProfile: 'saver'");
    expect(script).toContain('repoDir: PACKAGE_ROOT');
    expect(script).toContain('autoAnswer(');
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

  it('is used by every script that starts a session, a manager or a sandbox, and the task helpers keep the same rules', async () => {
    const dir = path.join(PACKAGE_ROOT, 'scripts', 'real');
    // common.ts defines the check itself (and its --yes refusal exits before any check starts).
    const helper = 'tasks-common.ts';
    const files = (await readdir(dir)).filter((name) => name.endsWith('.ts') && name !== 'common.ts');
    expect(files).toContain(helper);
    expect(files.length).toBeGreaterThan(5);
    for (const name of files) {
      const source = await readFile(path.join(dir, name), 'utf8');
      const where = (text: string) => `${name}: ${text}`;
      if (name === helper) {
        // A helper gets the check of the script that calls it: it starts none and never ends the process.
        expect(source, where('no check of its own')).not.toContain('startCheck(');
        expect(source, where('no exit')).not.toContain('process.exit(');
        // What starts something takes the caller's check first.
        expect(source, where('startWeb')).toContain('export async function startWeb(check: Check,');
        expect(source, where('controlSession')).toMatch(/export async function controlSession\(\s+check: Check,/);
        // The server it starts in this process is stopped with the check.
        expect(source.match(/=\s*main\(\['web'/g)?.length, where('servers')).toBe(source.match(/check\.add\(stop\)/g)?.length);
      } else {
        expect(source, where('startCheck')).toContain('startCheck()');
        expect(source, where('catch')).toMatch(/\} catch \(error\) \{\s+check\.fail\(error\);\s+\} finally \{\s+await check\.close\(\);\s+\}/);
        expect(source, where('exit code')).toContain('process.exit(check.exitCode(');
        // After the check starts, only its exit code ends the process: an early exit would skip the closes.
        const body = source.slice(source.indexOf('startCheck()'));
        expect(body.match(/process\.exit\(/g)?.length, where('one exit')).toBe(1);
      }
      // Every query is registered, and so is every tapped session, manager and sandbox. Counted in code: whole-line comments are left out.
      const code = source
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .join('\n');
      const count = (pattern: RegExp) => code.match(pattern)?.length ?? 0;
      expect(count(/(?<![.\w])query\(/g), where('queries')).toBe(count(/check\.query\(query\(/g));
      // A tapped query opened here is registered; one handed to the task runner is closed with the server.
      expect(count(/tappedQuery\(tap\)\(/g), where('tapped sessions')).toBe(count(/check\.query\(tappedQuery\(tap\)\(/g));
      expect(count(/await sandbox\(/g), where('sandbox')).toBe(count(/check\.add\(\(\) => box\.cleanup\(\)\)/g));
      expect(count(/createWebCreations\(|new CreationManager\(|ChatManager\.open\(|ImprovementManager\.open\(/g), where('managers')).toBe(count(/check\.add\(\(\) => \w+\.shutdown\(\)\)/g));
    }
  });
});

describe('phase 7 real checks: no wait without a deadline, and what they cannot control is said', () => {
  const read = (name: string) => readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', name), 'utf8');

  it('within: the answer when it comes in time; past the deadline an error, which fails the check', async () => {
    expect(await within(Promise.resolve('read'), 1000, 'the reading')).toBe('read');
    await expect(within(Promise.reject(new Error('closed')), 1000, 'the reading')).rejects.toThrow('closed');
    const never = new Promise<string>(() => undefined);
    await expect(within(never, 20, "the task session's context reading")).rejects.toThrow("the task session's context reading: no answer within 0 s");
    const check = startCheck(
      { on: () => undefined, off: () => undefined, exit: () => undefined },
      () => undefined,
    );
    await within(never, 20, 'x').catch((error: unknown) => check.fail(error));
    await check.close();
    expect(check.exitCode(true)).toBe(1);
  });

  it('every context reading is awaited with a deadline', async () => {
    const common = await read('tasks-common.ts');
    expect(common).toContain("await within(reading, CONTEXT_READING_MS, \"the control session's context reading\")");
    expect(common).not.toMatch(/await tap\.contextUsage\?\.get\(/);
    const skills = await read('check-task-skills.ts');
    expect(skills).toContain("await within(Promise.all([...(tap.contextUsage?.values() ?? [])]), CONTEXT_READING_MS, \"the task session's context reading\")");
    expect(skills).toContain("await within(reading, CONTEXT_READING_MS, \"the task session's context reading\")");
    expect(skills).not.toMatch(/await tap\.contextUsage\?\.get\(/);
    expect(skills).not.toMatch(/await Promise\.all\(\[\.\.\.\(tap\.contextUsage/);
  });

  it('check 5, (c): the control counts only bundled skills (source built-in)', async () => {
    const skills = await read('check-task-skills.ts');
    expect(skills).toContain("skill.source === 'built-in' && foreign(skill.name)");
    expect(skills).toContain('const controlForeign = bundledForeign(control.contextSkills) ?? [];');
  });

  it('checks 3 and 4 say what they cannot control; startWeb takes no runner', async () => {
    expect(await read('check-task-hooks.ts')).toContain('NOT CONTROLLED: .claude/settings.local.json.');
    const allowAll = await read('check-task-allow-all.ts');
    expect(allowAll).toContain('NOT CONTROLLED: that the allow rules would let a shell command run without the task layers.');
    expect(allowAll).toContain('NOT CONTROLLED: .claude/settings.local.json.');
    expect(await read('tasks-common.ts')).not.toMatch(/runner\?: TaskRunner|TaskRunner/);
  });
});

describe('phase 8 real check (check-codex-task): prepared, guarded, and stops before Claude when Codex is not ready', { timeout: 60_000 }, () => {
  const read = () => readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'check-codex-task.ts'), 'utf8');

  it('asks for --yes, works in a temp sandbox, checks Codex before the usage reading and the task, and says what it cannot control', async () => {
    const script = await read();
    expect(script).toContain('requireConfirmation(');
    expect(script).toMatch(/await sandbox\('codex-task'\)/);
    expect(script).toContain('check.add(() => box.cleanup())');
    expect(script).not.toContain('bypassPermissions');
    // Codex first: nothing is spent on Claude before its check passed.
    const prepared = script.indexOf('await prepareCodex(web)');
    expect(prepared).toBeGreaterThan(0);
    expect(prepared).toBeLessThan(script.indexOf("await usageGate(box, executable, 'before')"));
    expect(prepared).toBeLessThan(script.indexOf('await startTask('));
    // A task that Claude did itself is a failure, with that fact; one round only, no retry.
    expect(script).toContain('Claude did not write src/slug.js itself');
    expect(script.match(/await startTask\(/g)?.length).toBe(1);
    expect(script).toContain('CODEX_TOOL_ID');
    expect(script).toContain("notControlled('the warning as the page renders it when the switch is turned on'");
  });

  it('without --yes it exits with 2 and starts nothing', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join('scripts', 'real', 'check-codex-task.ts')], { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (err += chunk));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(2);
    expect(err).toContain('Run it again with --yes');
    expect(err).toContain('Codex usage');
  });

  describe('prepareCodex, against a real server over the fake Codex', () => {
    let dir: string;
    let cleanup: () => Promise<void>;
    let server: WebServer | undefined;
    let log: string;

    beforeEach(async () => {
      ({ dir, cleanup } = await tempDir('codex-prepare'));
      log = path.join(dir, 'calls.jsonl');
      await writeFile(log, '', 'utf8');
      await mkdir(path.join(dir, 'ui'), { recursive: true });
      await writeFile(path.join(dir, 'ui', 'index.html'), '<html><head><!-- importmap --></head></html>', 'utf8');
    });
    afterEach(async () => {
      await server?.close();
      server = undefined;
      await cleanup();
    });

    async function web(platform: NodeJS.Platform, scenario?: string, found = true): Promise<{ call: Web['call']; home: string }> {
      const home = path.join(dir, 'home');
      const pathEnv: PathEnv = { env: { ...process.env, BRIEFSTACK_HOME: home }, homedir: dir, pathApi: path, caseInsensitive: process.platform !== 'linux' };
      const codex = new CodexService({ pathEnv, platform, locate: () => (found ? fakeCodex(log, scenario) : undefined) });
      server = await startWebServer({ port: 0, uiDir: path.join(dir, 'ui'), token: 't'.repeat(43), lang: 'en', pathEnv, codex });
      const port = server.port;
      const call: Web['call'] = (method, route, body) =>
        new Promise((resolve, reject) => {
          const req = request(
            { host: '127.0.0.1', port, path: route, method, headers: { host: `127.0.0.1:${port}`, [TOKEN_HEADER]: 't'.repeat(43), origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } },
            (res) => {
              let text = '';
              res.setEncoding('utf8');
              res.on('data', (chunk: string) => (text += chunk));
              res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, json: () => JSON.parse(text) as unknown }));
            },
          );
          req.on('error', reject);
          req.end(body === undefined ? undefined : JSON.stringify(body));
        });
      return { call, home };
    }

    it('turns Codex on (unelevated on Windows, 5 calls) and passes when the check does', async () => {
      const { call, home } = await web('win32');
      const view = await prepareCodex({ call }, 'win32');
      expect(view).toMatchObject({ enabled: true, mode: 'unelevated', maxCalls: 5, available: true, last: { ok: true } });
      expect(JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'))).toMatchObject({ codexEnabled: true, codexMode: 'unelevated', codexMaxCalls: 5 });
    });

    it('elsewhere it does not set the mode', async () => {
      const { call, home } = await web('linux');
      await prepareCodex({ call }, 'linux');
      expect(JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'))).not.toHaveProperty('codexMode');
    });

    it('stops with the exact reason when Codex is not signed in, its sandbox fails, or it is not found', async () => {
      for (const [scenario, found, reason] of [
        ['loggedOut', true, 'Codex is not signed in (codex login status: "Not logged in"); run codex login'],
        ['noSandbox', true, "Codex's sandbox did not run a command"],
        [undefined, false, 'Codex CLI was not found on the PATH'],
      ] as const) {
        const { call } = await web('win32', scenario, found);
        const error = await prepareCodex({ call }, 'win32').catch((caught: unknown) => caught);
        expect(error, String(scenario)).toBeInstanceOf(CheckStop);
        expect((error as CheckStop).code).toBe(2);
        expect((error as CheckStop).message).toContain('STOP before any session:');
        expect((error as CheckStop).message).toContain(reason);
        await server?.close();
        server = undefined;
      }
    });
  });
});

describe('phase 8 real check (check-codex-cancel): prepared, guarded, Codex checked before Claude, cancel by the page\'s route', { timeout: 60_000 }, () => {
  const read = () => readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'check-codex-cancel.ts'), 'utf8');

  it('asks for --yes, works in a temp sandbox, checks Codex before the usage reading and the task, and starts one task only', async () => {
    const script = await read();
    expect(script).toContain('requireConfirmation(');
    expect(script).toMatch(/await sandbox\('codex-cancel'\)/);
    expect(script).toContain('check.add(() => box.cleanup())');
    expect(script).not.toContain('bypassPermissions');
    const prepared = script.indexOf('await prepareCodex(web)');
    expect(prepared).toBeGreaterThan(0);
    expect(prepared).toBeLessThan(script.indexOf("await usageGate(box, executable, 'before')"));
    expect(prepared).toBeLessThan(script.indexOf('await startTask('));
    // One round, no retry; a Claude that does the work itself is a failure with that fact.
    expect(script.match(/await startTask\(/g)?.length).toBe(1);
    expect(script).toContain('Claude did not write src/hold.js itself');
    expect(script).toContain('CODEX_TOOL_ID');
  });

  it('cancels with the route the page\'s button uses, only once Codex is at work, and reads the outcome with data', async () => {
    const script = await read();
    const page = await readFile(path.join(PACKAGE_ROOT, 'src', 'ui', 'tasks.tsx'), 'utf8');
    expect(page).toContain("send('POST', `/api/tasks/${task.id}/cancel`)");
    expect(script).toContain("web.call('POST', `/api/tasks/${id}/cancel`)");
    // The cancel waits for the task's own signal and a new codex process for the worktree.
    const working = script.indexOf('task.codexWorking === true');
    expect(working).toBeGreaterThan(0);
    expect(working).toBeLessThan(script.indexOf("web.call('POST', `/api/tasks/${id}/cancel`)"));
    // A call that ended before the cancel is a failure with that fact.
    expect(script).toContain('the Codex call ended before the cancel');
    expect(script).toContain("rounds[0].codex has one call, cancelled");
    expect(script).toContain('uiMessages.es.taskCodexNoUsage');
    // Processes are polled until gone, against the ones that ran before, and listed when left.
    expect(script).toContain('!before.has(entry.pid)');
    expect(script).toContain('still running:');
    expect(script).toContain("notControlled('the row as the page renders it'");
  });

  it('without --yes it exits with 2 and starts nothing', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join('scripts', 'real', 'check-codex-cancel.ts')], { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (err += chunk));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(2);
    expect(err).toContain('Run it again with --yes');
    expect(err).toContain('Codex usage');
  });
});

describe('phase 9 real check (check-build): prepared, guarded, kept to a temp home, applying as the page does', { timeout: 60_000 }, () => {
  const read = () => readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'check-build.ts'), 'utf8');

  it('asks for --yes, works in a temp sandbox on the saver profile, with the real planner and the real plan reading tapped', async () => {
    const script = await read();
    expect(script).toContain('requireConfirmation(');
    expect(script).toMatch(/await sandbox\('build'\)/);
    expect(script).toContain('check.add(() => box.cleanup())');
    expect(script).not.toContain('bypassPermissions');
    // startWeb sets the saver profile in the temp home; the build's planner and plan reading are the real ones.
    expect(await readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'tasks-common.ts'), 'utf8')).toContain("activeProfile: 'saver'");
    // The planner session is tapped too (review of M6): its init's tools are printed and judged.
    expect(script).toContain('buildPlanner: new SdkBuildPlanner({ pathEnv, query: tappedQuery(plannerTap) })');
    expect(script).toContain('plannerReading(plannerTap)');
    expect(script).toContain('buildUsageReader({ pathEnv, repoDir: PACKAGE_ROOT })');
    // The processes of the sandbox are counted once the server stopped (review of M6).
    expect(script.indexOf('await processesLeft(box, [COMMAND])')).toBeGreaterThan(script.indexOf('await web.stop()'));
    // The usage gate runs before the planner session starts.
    expect(script.indexOf("await usageGate(box, executable, 'before')")).toBeLessThan(script.indexOf('/api/projects/${project.slug}/builds'));
  });

  it('checks what only a real session shows: StructuredOutput reaching the planner, and resets_at said, not judged', async () => {
    const script = await read();
    expect(script).toContain('the planner answered with a queue (StructuredOutput reached it; the schema was accepted)');
    expect(script).toContain("notControlled('resets_at for this login");
    // The sessions' own messages: every shell call against the approved list, and no Codex offered (review of M6, I-2).
    expect(script).toContain('tap.calls.filter((call) => SHELL_TOOLS.includes(call.name))');
    expect(script).toContain('every shell command outside the approved list came back refused (none ran)');
    expect(script).toContain('!init.tools.includes(CODEX_TOOL_ID)');
    // Only a finished build is applied: a paused one keeps its resume timer.
    expect(script).toContain("if (done.state === 'finished' && applied.length >= 1) {");
    // One approved command, the same as the check, at most three tasks, one fix round, and a deadline on every wait.
    expect(script).toContain("const COMMAND = 'node --test';");
    expect(script).toContain('commands: [COMMAND], checks: [COMMAND], fixRounds: 1');
    expect(script).toContain('Math.min(3, plan.plan.tasks.length)');
    expect(script.match(/await waitBuild\(web, id, .+?, \d+ \* 60_000\)/g)?.length).toBe(2);
    expect(script.match(/await waitBuild\(/g)?.length).toBe(2);
  });

  it('applies with the confirmation and the head the diff showed, as the page sends them', async () => {
    const script = await read();
    const page = await readFile(path.join(PACKAGE_ROOT, 'src', 'ui', 'builds.tsx'), 'utf8');
    expect(page).toContain("name === 'apply' ? { confirm: true, head }");
    expect(script).toContain("web.call('POST', `/api/builds/${id}/apply`, { confirm: true, head: shown.head })");
    expect(script.indexOf("web.call('GET', `/api/builds/${id}/diff`)")).toBeLessThan(script.indexOf('/apply`'));
  });

  it('without --yes it exits with 2 and starts nothing', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join('scripts', 'real', 'check-build.ts')], { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (err += chunk));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(2);
    expect(err).toContain('Run it again with --yes');
    expect(err).toContain('planner session');
  });
});

describe('phase 9 second real check (check-build-deny): a denied command, a fix round and a waiting task, from a fixed queue', { timeout: 60_000 }, () => {
  const read = () => readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'check-build-deny.ts'), 'utf8');

  it('asks for --yes, works in a temp sandbox, taps the planner and the task sessions, and replaces the queue with its own', async () => {
    const script = await read();
    expect(script).toContain('requireConfirmation(');
    expect(script).toMatch(/await sandbox\('build-deny'\)/);
    expect(script).toContain('check.add(() => box.cleanup())');
    expect(script).not.toContain('bypassPermissions');
    expect(script).toContain('buildPlanner: new SdkBuildPlanner({ pathEnv, query: tappedQuery(plannerTap) })');
    expect(script.indexOf("await usageGate(box, executable, 'before')")).toBeLessThan(script.indexOf('/api/projects/${project.slug}/builds'));
    // The planner must answer, then its queue is replaced by the fixed one; one approved command, not the one task 1 tries.
    expect(script).toContain("verdict('the planner answered with a queue', plan.state === 'planned'");
    expect(script).toContain('const startBody = { tasks: QUEUE, limit: QUEUE.length, commands: [COMMAND], checks: [CHECK], fixRounds: 1');
    expect(script).toContain("const COMMAND = 'node --test';");
    expect(script).toContain("const OFF_LIST = 'node --version';");
    // Every wait has a deadline.
    expect(script.match(/await waitBuild\(web, id, .+?, \d+ \* 60_000/g)?.length).toBe(2);
  });

  it('judges the denial by what happened, and fails when the session never tried the command', async () => {
    const script = await read();
    expect(script).toContain('the session never called it');
    expect(script).toContain("if (tried.length >= 1) {");
    expect(script).toContain('UNATTENDED_DENIED');
    expect(script).toContain("1. it is in the build's denied list");
    // Nobody asked: pending while it ran, the task's stream, and the denial recorded by policy.
    expect(script).toContain('pendingSeen.set(item.taskId');
    expect(script).toContain('web.read(`/api/tasks/${t1.taskId}/stream?from=0`, 3000)');
    expect(script).toContain("event.type === 'tool.denied' && event.toolUseId === call.id && event.by === 'policy'");
  });

  it('task 1 must be applied once its fix round ended without the denied command: the rule is read round by round (IDEAS 9 (b))', async () => {
    const script = await read();
    const name = '1. task 1 was applied once its fix round ended without the command (round by round)';
    expect(script).toContain(`verdict('${name}', t1?.state === 'applied' && t1.commit !== undefined && t1.rounds === 2, applied1)`);
    // Any command off the list in the fix round is the model's doing (review of step 37 part C, I1); the build is still
    // judged then: task 1 waiting for the denial, with no commit (I2).
    expect(script).toContain("const lastSession1 = rounds1.at(-1)?.sessionId;");
    expect(script).toContain('shellCalls.filter((call) => call.sessionId === lastSession1 && !isApprovedCommand(commandOf(call.input), [COMMAND]))');
    expect(script).toContain(`notControlled('${name}'`);
    expect(script).toContain("verdict('1. a fix round with a denied command leaves task 1 waiting, not applied (round by round)', t1?.state === 'waiting' && t1.reason === 'denied' && t1.rounds === 2 && t1.commit === undefined, applied1)");
    expect(script).toContain('In a fix round, do not call the command again and run no other command');
    // Inside the block that runs only when the session tried the command, after the denied list is judged.
    const block = script.slice(script.indexOf('if (tried.length >= 1) {'), script.indexOf('// ---- 2. The deterministic fix round ----'));
    expect(block).toContain(name);
    expect(block.indexOf("1. it is in the build's denied list")).toBeLessThan(block.indexOf(name));
  });

  it('its check is deterministic: state only in .check-state/, which git ignores', async () => {
    const script = await read();
    expect(script).toContain("'.gitignore': 'node_modules/\\n.check-state/\\n'");
    expect(script).toContain("const CHECK = 'node scripts/check.js';");
    expect(script).toContain('2. its check passed on a later run than its first');
    // A command the model runs in task 2 is its own verdict, not hidden in the fix round's (review of step 33, I1).
    expect(script).toContain('2. the session of task 2 ran no command');
    expect(script).toContain("3. task 4, which depends on it, was skipped without a session");
    // The approved command and the check are valid items of a build's lists.
    const { approvedListProblems } = await import('../../src/builds/commands.js');
    expect(approvedListProblems(['node --test'], 'commands')).toEqual([]);
    expect(approvedListProblems(['node scripts/check.js'], 'checks')).toEqual([]);
  });

  it('the check script fails first with notes/fix.txt, passes on its second run, and fails for good with notes/never.txt', async () => {
    const script = await read();
    const start = script.indexOf('const CHECK_SCRIPT = [');
    const body = script.slice(start, script.indexOf("].join('\\n');", start));
    // Rebuild the file's text from the array of lines and run it in temp folders.
    const lines = [...body.matchAll(/^\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'),$/gm)].map((match) => (match[1]?.startsWith('"') ? (JSON.parse(match[1]) as string) : (match[1] ?? '').slice(1, -1).replace(/\\'/g, "'")));
    const text = `${lines.join('\n')}\n`;
    const { dir, cleanup } = await tempDir('build-check-script');
    try {
      await writeFile(path.join(dir, 'check.js'), text, 'utf8');
      const run = () => spawnSync(process.execPath, ['check.js'], { cwd: dir, encoding: 'utf8' });
      expect(run().status).toBe(0);
      await mkdir(path.join(dir, 'notes'));
      await writeFile(path.join(dir, 'notes', 'fix.txt'), 'fix', 'utf8');
      const first = run();
      expect(first.status).toBe(1);
      const second = run();
      expect(second.status).toBe(0);
      expect(second.stdout).toContain('CHECK PASSES on run 3');
      await writeFile(path.join(dir, 'notes', 'never.txt'), 'never', 'utf8');
      expect(run().status).toBe(1);
      await rm(path.join(dir, 'notes', 'never.txt'));
      expect(run().status).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('without --yes it exits with 2 and starts nothing', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join('scripts', 'real', 'check-build-deny.ts')], { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (err += chunk));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(2);
    expect(err).toContain('Run it again with --yes');
    expect(err).toContain('six short task sessions');
  });
});

describe('phase 11 real check (check-build-parallel): two cards at once, a deterministic conflict redone and joined, the apply', { timeout: 60_000 }, () => {
  const read = () => readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'check-build-parallel.ts'), 'utf8');

  it('asks for --yes, works in a temp sandbox, taps the planner, and starts its own board with two slots', async () => {
    const script = await read();
    expect(script).toContain('requireConfirmation(');
    expect(script).toMatch(/await sandbox\('build-parallel'\)/);
    expect(script).toContain('check.add(() => box.cleanup())');
    expect(script).not.toContain('bypassPermissions');
    expect(script).toContain('buildPlanner: new SdkBuildPlanner({ pathEnv, query: tappedQuery(plannerTap) })');
    expect(script.indexOf("await usageGate(box, executable, 'before')")).toBeLessThan(script.indexOf('/api/projects/${project.slug}/builds'));
    expect(script).toContain('const startBody = { tasks: BOARD, limit: BOARD.length, commands: [COMMAND], checks: [CHECK], fixRounds: 1, thresholds: { fiveHour: 90, week: 95 }, slots: SLOTS, confirm: true };');
    expect(script).toContain('const SLOTS = 2;');
    // Every wait has a deadline.
    expect(script.match(/await waitBuild\(web, id, .+?, \d+ \* 60_000/g)?.length).toBe(2);
  });

  it('its board makes the conflict deterministic: cards 1 and 2 share no area and both create the same file', async () => {
    const script = await read();
    expect(script).toContain("{ title: 'Add the line one', instruction: shared('one')");
    expect(script).toContain("{ title: 'Add the line two', instruction: shared('two')");
    expect(script).toContain("area: ['notes/one/']");
    expect(script).toContain("area: ['notes/two/']");
    const { areasOverlap } = await import('../../src/builds/types.js');
    expect(areasOverlap(['notes/one/'], ['notes/two/'])).toBe(false);
    // Judged from the build itself: both running at once, one redone for a conflict, both applied, the file with both lines.
    expect(script).toContain('1. two independent cards ran at the same time, each with its own task');
    expect(script).toContain("2. exactly one of cards 1 and 2 collided when joined and was redone once");
    expect(script).toContain("the redone card's session did not keep the other line (the model, not the build)");
    expect(script).toContain('4. the build was applied');
    // The approved command and the check are valid items of a build's lists.
    const { approvedListProblems } = await import('../../src/builds/commands.js');
    expect(approvedListProblems(['node --test'], 'commands')).toEqual([]);
    expect(approvedListProblems(['node scripts/check.js'], 'checks')).toEqual([]);
  });

  it('the check script fails only on conflict markers', async () => {
    const script = await read();
    const start = script.indexOf('const CHECK_SCRIPT = [');
    const body = script.slice(start, script.indexOf("].join('\\n');", start));
    const lines = [...body.matchAll(/^\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'),$/gm)].map((match) => (match[1]?.startsWith('"') ? (JSON.parse(match[1]) as string) : (match[1] ?? '').slice(1, -1).replace(/\\'/g, "'")));
    const text = `${lines.join('\n')}\n`;
    const { dir, cleanup } = await tempDir('build-parallel-check');
    try {
      await writeFile(path.join(dir, 'check.js'), text, 'utf8');
      const run = () => spawnSync(process.execPath, ['check.js'], { cwd: dir, encoding: 'utf8' });
      await mkdir(path.join(dir, 'shared'));
      await writeFile(path.join(dir, 'shared', 'NOTES.md'), 'one\ntwo\n', 'utf8');
      expect(run().status).toBe(0);
      await writeFile(path.join(dir, 'shared', 'NOTES.md'), '<<<<<<< ours\none\n=======\ntwo\n>>>>>>> theirs\n', 'utf8');
      expect(run().status).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('without --yes it exits with 2 and starts nothing', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join('scripts', 'real', 'check-build-parallel.ts')], { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (err += chunk));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(2);
    expect(err).toContain('Run it again with --yes');
    expect(err).toContain('five short task sessions');
  });
});

describe('phase 9 second real check: the check\'s state survives a task\'s rounds and never reaches a commit', { timeout: 60_000 }, () => {
  it('commitRound leaves .check-state/ out of the commit, and restoreToHead keeps it', async () => {
    const { commitRound, restoreToHead } = await import('../../src/tasks/git.js');
    const { dir, cleanup } = await tempDir('check-state');
    try {
      const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=', ...args], { cwd: dir, encoding: 'utf8' });
      expect(git('init', '--quiet', '-b', 'main').status).toBe(0);
      await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n.check-state/\n', 'utf8');
      expect(git('add', '-A').status).toBe(0);
      expect(git('commit', '--quiet', '--no-verify', '-m', 'base').status).toBe(0);
      await mkdir(path.join(dir, '.check-state'));
      await writeFile(path.join(dir, '.check-state', 'runs'), '1', 'utf8');
      await writeFile(path.join(dir, 'a.txt'), 'a', 'utf8');
      const commit = await commitRound(dir, 'round 1');
      expect(commit).toBeDefined();
      expect(git('show', '--name-only', '--format=', 'HEAD').stdout.trim()).toBe('a.txt');
      await writeFile(path.join(dir, 'stray.txt'), 'x', 'utf8');
      await restoreToHead(dir);
      expect(await readFile(path.join(dir, '.check-state', 'runs'), 'utf8')).toBe('1');
      await expect(stat(path.join(dir, 'stray.txt'))).rejects.toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it('processesVerdict: NOT CONTROLLED when the listing failed, PASS with none, FAIL with some', async () => {
    const { processesVerdict } = await import('../../scripts/real/tasks-common.js');
    expect(processesVerdict(undefined).verdict).toBe('NOT CONTROLLED');
    expect(processesVerdict([])).toEqual({ verdict: 'PASS', detail: 'none' });
    expect(processesVerdict([{ pid: 7, command: 'node scripts/check.js' }]).verdict).toBe('FAIL');
  });
});

describe('phase 9 real checks: the shared helpers have deadlines', () => {
  it('web.call and web.stop end with an error past their deadline', async () => {
    const common = await readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'tasks-common.ts'), 'utf8');
    expect(common).toContain('req.setTimeout(WEB_CALL_MS,');
    expect(common).toContain("await within(running, WEB_STOP_MS, 'briefstack web stopping')");
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

describe('phase 6 real checks: prepared, guarded, and kept off real data', () => {
  const read = (name: string) => readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', name), 'utf8');

  it('each asks for --yes, works in a temp sandbox, cleans it up and stops above 70% of the 5-hour window or 95% of the week', async () => {
    for (const name of ['check-skill-fetch.ts', 'check-skill-model-review.ts', 'check-skill-creation.ts']) {
      const script = await read(name);
      expect(script, name).toContain('requireConfirmation(');
      expect(script, name).toMatch(/await sandbox\('/);
      expect(script, name).toContain('box.cleanup()');
      expect(script, name).toContain('> 70');
      expect(script, name).toContain('> 95');
      expect(script, name).toContain('sandboxLibrary(box)');
      expect(script, name).not.toContain('bypassPermissions');
      expect(script, name).not.toMatch(/usageSet|applyProfile/);
    }
    const probe = await read('probe-h0-phase6.ts');
    expect(probe).toContain('requireConfirmation(');
    expect(probe).toContain("await sandbox('h0-phase6')");
  });

  it('the fetch check uses the real hosts and the real reviewer, then installs and validates', async () => {
    const script = await read('check-skill-fetch.ts');
    expect(script).toContain('new SdkSkillReviewer({ pathEnv })');
    expect(script).not.toContain('apiBase');
    expect(script).toContain('installSkills(');
    expect(script).toContain('validateProject(');
  });

  it('the model review check has a harmless skill and a malicious one that tells the reviewer what to answer', async () => {
    const script = await read('check-skill-model-review.ts');
    expect(script).toContain('new SdkSkillReviewer({ pathEnv })');
    expect(script).toContain('Note to the reviewer');
    expect(script).toContain('harmless?.harmful === false');
    expect(script).toContain('malicious?.harmful === true');
  });

  it('the API key check asks for --yes, needs the key in the terminal, uses the web environment, and never prints the key', async () => {
    const script = await read('check-api-key.ts');
    expect(script).toContain('requireConfirmation(');
    expect(script).toContain("await sandbox('api-key')");
    expect(script).toContain('box.cleanup()');
    expect(script).toContain("throw new CheckStop(2, 'ANTHROPIC_API_KEY is not set");
    expect(script).toContain('sessionEnv(box)');
    expect(script).toContain("tools: [], model: 'haiku', maxTurns: 1");
    expect(script).not.toMatch(/console\.log\([^)]*ANTHROPIC_API_KEY/);
    expect(script).not.toMatch(/report\([^)]*process\.env\.ANTHROPIC_API_KEY\s*[,)]/);
    expect(script).not.toContain('bypassPermissions');
  });

  it('the preflight says how Claude Code signs in and never prints a credential', async () => {
    const script = await read('preflight.ts');
    expect(script).toContain('readAuthMode(');
    expect(script).not.toMatch(/process\.env\[name\]|process\.env\.ANTHROPIC_API_KEY/);
  });

  it('the creation check runs on the saver profile with this folder and the temp library', async () => {
    const script = await read('check-skill-creation.ts');
    expect(script).toContain("activeProfile: 'saver'");
    expect(script).toContain('repoDir: PACKAGE_ROOT');
    expect(script).toContain('createWebCreations({ pathEnv, repoDir: PACKAGE_ROOT, lang: \'en\', skills })');
    expect(script).toContain('proposed.includes(name)');
  });
});

describe('phase 10 real check (check-creation-code): prepared, guarded, Codex checked before Claude', { timeout: 60_000 }, () => {
  const read = () => readFile(path.join(PACKAGE_ROOT, 'scripts', 'real', 'check-creation-code.ts'), 'utf8');

  it('asks for --yes, works in a temp sandbox on saver, checks Codex (no model) before the usage reading and the creation, and has every verdict of the brief', async () => {
    const script = await read();
    expect(script).toContain('requireConfirmation(');
    expect(script).toMatch(/await sandbox\('creation-code'\)/);
    expect(script).toContain('check.add(() => box.cleanup())');
    expect(script).toContain("activeProfile: 'saver'");
    expect(script).not.toContain('bypassPermissions');
    // Codex first: nothing is spent on Claude before its check passed with the no-shell part.
    const checked = script.indexOf('await codex.check()');
    expect(checked).toBeGreaterThan(0);
    expect(checked).toBeLessThan(script.indexOf('await readPlanUsage(box, executable)'));
    expect(checked).toBeLessThan(script.indexOf('await manager.create(IDEA)'));
    expect(script.match(/await manager\.create\(/g)?.length).toBe(1);
    // The verdicts of BRIEF-phase-10 §5: two commits, a listed command, an off-list command denied with no dialog, Codex
    // without its shell, the checks; and the two things only a real session shows (the subagent's tools, its writes).
    for (const verdict of [
      'two commits: the workspace, then the code apart',
      'a listed command ran in the project',
      'was denied',
      'nobody was asked during the implement step',
      'Codex was called without its shell and ran no command',
      'the checks ran after the implementer',
      'the implementer called briefstack’s tools',
      'the code commit holds what the implementer wrote',
    ]) {
      expect(script, verdict).toContain(verdict);
    }
    // The model not trying something is said as such, never retried.
    expect(script).toContain('(the model, not briefstack)');
    // Review of M6: verdicts that pass only on facts that prove them.
    expect(script).toContain("call.outcome === 'completed' && call.usage !== undefined"); // I1: a Codex call that worked
    expect(script).toContain('codeFiles.includes(CODEX_FILE)'); // I1: its file committed
    expect(script).toContain("refused.some((command) => command.includes('npm'))"); // I2: run_command's own refusal
    expect(script).not.toContain('guardDenials.length > 0'); // I2: not any denial
    expect(script).toContain('codeFiles.filter((file) => file !== CODEX_FILE)'); // I3: a file of the implementer's own
    expect(script).toContain('await filesOutside(box.dir, allowed)'); // I3: nowhere else
    expect(script).toContain('usageWarnWeek'); // I4: the step's gate above the script's start limits
    expect(script).toContain('spec → cancel'); // I4: no code and Codex offered, nothing more spent
  });

  it('without --yes it exits with 2 and starts nothing', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join('scripts', 'real', 'check-creation-code.ts')], { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (err += chunk));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(2);
    expect(err).toContain('Run it again with --yes');
    expect(err).toContain('Codex usage');
  });
});
