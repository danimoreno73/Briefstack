import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkEnvironment, cleanCommandOutput, commandEnv, currentStatusOf, realImplementSystem, revertHookDefinitions, revertProtectedChanges, runCommandLine, snapshotProtectedFiles } from '../../src/creation/implementSystem.js';
import { approvedParts, MAX_KEPT_ENTRIES } from '../../src/creation/implement.js';
import { tempDir } from '../helpers.js';

// The implement step's real system (review of M2, I4): what runs an approved command, its environment, its output,
// and the folder checks. Every command here is `node -e` with plain characters, so it reads the same in cmd and sh.

const NODE = 'node';

describe('runCommandLine', { timeout: 30_000 }, () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await tempDir('implement-system')));
  afterEach(() => cleanup());

  it('runs an approved item with double quotes in the project folder, with its exit code and output', async () => {
    const ran = await runCommandLine(dir, `${NODE} -e "console.log(process.cwd().length > 0 ? 'here' : 'none'); process.exit(3)"`.replace('process.exit(3)', 'process.exitCode=3'), { signal: new AbortController().signal });
    expect(ran.exitCode).toBe(3);
    expect(ran.output.trim()).toBe('here');
    expect(ran.timedOut).toBe(false);
  });

  it('ends the process tree at the deadline, and on an abort', async () => {
    const long = `${NODE} -e "setTimeout(function(){},60000)"`;
    const timed = await runCommandLine(dir, long, { signal: new AbortController().signal, timeoutMs: 300 });
    expect(timed).toMatchObject({ timedOut: true, exitCode: null });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    const aborted = await runCommandLine(dir, long, { signal: abort.signal });
    expect(aborted).toMatchObject({ timedOut: false, exitCode: null });
  });

  it('runs a command with the network but no credentials, and a check offline', async () => {
    const env = commandEnv({ PATH: 'p', ANTHROPIC_API_KEY: 'k', GH_TOKEN: 't', BRIEFSTACK_HOME: 'h', CLAUDE_CODE_X: 'c', CODEX_HOME: 'x', GIT_DIR: 'g', GIT_CONFIG_GLOBAL: 'g', HTTPS_PROXY: 'keep' });
    expect(env).toEqual({ PATH: 'p', HTTPS_PROXY: 'keep', NoDefaultCurrentDirectoryInExePath: '1' });
    const offline = checkEnvironment({ PATH: 'p', ANTHROPIC_API_KEY: 'k', BRIEFSTACK_HOME: 'h', GIT_WORK_TREE: 'w', GH_TOKEN: 't', GITHUB_TOKEN: 't', NPM_TOKEN: 't', OPENAI_API_KEY: 'k', AWS_SECRET_ACCESS_KEY: 's', CLAUDE_X: 'c' });
    expect(offline.PATH).toBe('p');
    expect(offline.HTTPS_PROXY).toBeDefined();
    expect(offline.HTTPS_PROXY).not.toBe('keep');
    // Review of M3, I2: no credential reaches a check.
    for (const name of ['ANTHROPIC_API_KEY', 'BRIEFSTACK_HOME', 'GIT_WORK_TREE', 'GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'CLAUDE_X']) expect(offline[name], name).toBeUndefined();
  });
});

describe('cleanCommandOutput', () => {
  it('shows the project as ".", hides other paths and secrets, and never keeps half a line', () => {
    const dir = path.join(path.parse(process.cwd()).root, 'work', 'garden');
    const secret = ['sk', 'ant', 'b'.repeat(40)].join('-');
    expect(cleanCommandOutput(`${path.join(dir, 'src', 'a.js')} ok\nkey ${secret}\n`, dir)).not.toContain(secret);
    expect(cleanCommandOutput(`${path.join(dir, 'src', 'a.js')} ok\n`, dir)).toContain(`.${path.sep}src`);
    // A secret on a line cut at the start of the kept part: the whole line goes, not only its prefix.
    const long = `${secret}${'x'.repeat(16 * 1024)}\nlast line\n`;
    expect(cleanCommandOutput(long, dir)).toBe('last line\n');
  });
});

describe('currentStatusOf (M5)', () => {
  it('takes the brief\'s "Current status" up to the next heading, hides secrets and paths, and none when absent', () => {
    const dir = path.join(path.parse(process.cwd()).root, 'work', 'garden');
    const secret = ['sk', 'ant', 'c'.repeat(40)].join('-');
    const brief = `# Garden\n\n## Done when\n\n- x\n\n## Current status\n\nDone: beds.\nLeft: watering.\nkey ${secret}\n\n### Detail\nkept\n\n## Setup\n\nnot this\n`;
    const status = currentStatusOf(brief, dir) ?? '';
    expect(status).toContain('Done: beds.');
    expect(status).toContain('### Detail');
    expect(status).not.toContain('not this');
    expect(status).not.toContain(secret);
    expect(currentStatusOf('# x\n\n## Setup\n', dir)).toBeUndefined();
    expect(currentStatusOf('## Current status\n\n\n## Setup\n', dir)).toBeUndefined();
  });

  it('a long first line is cut at a blank, never down to only "[cut]" (review of M6, m6)', () => {
    const dir = path.join(path.parse(process.cwd()).root, 'work', 'garden');
    const status = currentStatusOf(`## Current status\n\n${'word '.repeat(2000)}\n`, dir) ?? '';
    expect(status.endsWith('[cut]')).toBe(true);
    expect(status.length).toBeGreaterThan(1000);
    expect(status.replace('\n[cut]', '').trim().split(' ').every((w) => w === 'word')).toBe(true);
  });
});

describe('approvedParts', () => {
  const list = ['npm install', 'npm test'];
  it('takes an item, or a chain of && of items; never ; or ||', () => {
    expect(approvedParts('npm test', list)).toEqual(['npm test']);
    expect(approvedParts('npm install && npm test', list)).toEqual(['npm install', 'npm test']);
    expect(approvedParts('npm install ; npm test', list)).toBeUndefined();
    expect(approvedParts('npm install || npm test', list)).toBeUndefined();
    expect(approvedParts('npm install && npm publish', list)).toBeUndefined();
    expect(approvedParts('npm test | tee out', list)).toBeUndefined();
    expect(MAX_KEPT_ENTRIES).toBe(50);
  });
});

describe('the folder checks', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await tempDir('implement-folder')));
  afterEach(() => cleanup());

  it('same folder after links; a relative path or another folder is not', async () => {
    const system = realImplementSystem();
    const project = path.join(dir, 'garden');
    await mkdir(project, { recursive: true });
    expect(await system.sameFolder(project, project)).toBe(true);
    expect(await system.sameFolder(path.join(project, '.'), project)).toBe(true);
    expect(await system.sameFolder('garden', project)).toBe(false);
    expect(await system.sameFolder(path.join(dir, 'other'), project)).toBe(false);
    expect(await system.sameFolder(path.join(project, 'src'), project)).toBe(false);
    const link = path.join(dir, 'link');
    try {
      await symlink(project, link, 'junction');
      expect(await system.sameFolder(link, project)).toBe(true);
    } catch {
      // No right to make links here: the rest still holds.
    }
  });

  it('a project needs .briefstack/profile.json', async () => {
    const system = realImplementSystem();
    expect(await system.isProject(dir)).toBe(false);
    await mkdir(path.join(dir, '.briefstack'), { recursive: true });
    await writeFile(path.join(dir, '.briefstack', 'profile.json'), '{}', 'utf8');
    expect(await system.isProject(dir)).toBe(true);
  });

  it('puts back protected files changed since the workspace commit, whoever changed them (review of M4, I1)', async () => {
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(path.join(dir, '.claude', 'settings.json'), '{}\n', 'utf8');
    await writeFile(path.join(dir, 'README.md'), 'x\n', 'utf8');
    const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    run(['init', '-q']);
    run(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '-A']);
    run(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'workspace']);
    await writeFile(path.join(dir, '.claude', 'settings.json'), '{"hooks":{}}\n', 'utf8');
    await mkdir(path.join(dir, '.claude', 'hooks'), { recursive: true });
    await writeFile(path.join(dir, '.claude', 'hooks', 'run.sh'), 'echo\n', 'utf8');
    await writeFile(path.join(dir, '.mcp.json'), '{}\n', 'utf8');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'a.js'), 'ok\n', 'utf8');
    const reverted = await revertProtectedChanges(dir);
    expect(reverted.sort()).toEqual(['.claude/hooks/run.sh', '.claude/settings.json', '.mcp.json']);
    // As git checks it out (core.autocrlf may turn \n into \r\n on Windows).
    expect((await readFile(path.join(dir, '.claude', 'settings.json'), 'utf8')).replaceAll('\r\n', '\n')).toBe('{}\n');
    await expect(stat(path.join(dir, '.mcp.json'))).rejects.toThrow();
    expect(await readFile(path.join(dir, 'src', 'a.js'), 'utf8')).toBe('ok\n');
  });

  it('protected files git ignores go back as the snapshot had them; a new one goes; other names are never touched (review of M5, B1, m3)', async () => {
    const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    await writeFile(path.join(dir, '.gitignore'), '.claude/settings.local.json\n.mcp.json\nnode_modules/\n', 'utf8');
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(path.join(dir, '.claude', 'settings.local.json'), '{"mine":true}\n', 'utf8');
    run(['init', '-q']);
    run(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '-A']);
    run(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'workspace']);
    const snapshot = await snapshotProtectedFiles(dir);
    expect([...snapshot.keys()]).toEqual(['.claude/settings.local.json']);
    // Codex (no guard) writes hooks into the ignored settings file and an ignored .mcp.json; a file named like a short form is fine.
    await writeFile(path.join(dir, '.claude', 'settings.local.json'), '{"hooks":{"PreToolUse":[]}}\n', 'utf8');
    await writeFile(path.join(dir, '.mcp.json'), '{}\n', 'utf8');
    await writeFile(path.join(dir, 'notes~1.md'), 'mine\n', 'utf8');
    const reverted = await revertProtectedChanges(dir, snapshot);
    expect(reverted.sort()).toEqual(['.claude/settings.local.json', '.mcp.json']);
    expect(await readFile(path.join(dir, '.claude', 'settings.local.json'), 'utf8')).toBe('{"mine":true}\n');
    await expect(stat(path.join(dir, '.mcp.json'))).rejects.toThrow();
    expect(await readFile(path.join(dir, 'notes~1.md'), 'utf8')).toBe('mine\n');
    // A snapshot file that went is written back.
    await rm(path.join(dir, '.claude', 'settings.local.json'));
    expect(await revertProtectedChanges(dir, snapshot)).toEqual(['.claude/settings.local.json']);
    expect(await readFile(path.join(dir, '.claude', 'settings.local.json'), 'utf8')).toBe('{"mine":true}\n');
  });

  it('a link in place of a protected file or its folder never leads the write-back out of the project (review of M6, m1)', async () => {
    const project = path.join(dir, 'garden');
    const outside = path.join(dir, 'outside');
    await mkdir(path.join(project, '.claude'), { recursive: true });
    await mkdir(outside, { recursive: true });
    const run = (args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8' });
    await writeFile(path.join(project, '.gitignore'), '.claude/settings.local.json\n', 'utf8');
    await writeFile(path.join(project, '.claude', 'settings.local.json'), '{"mine":true}\n', 'utf8');
    run(['init', '-q']);
    run(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '-A']);
    run(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'workspace']);
    const snapshot = await snapshotProtectedFiles(project);
    const target = path.join(outside, 'settings.local.json');
    await writeFile(target, 'theirs\n', 'utf8');
    // The file itself a link to a file outside (needs the right to make file links on Windows).
    await rm(path.join(project, '.claude', 'settings.local.json'));
    try {
      await symlink(target, path.join(project, '.claude', 'settings.local.json'), 'file');
      await revertProtectedChanges(project, snapshot);
      expect(await readFile(path.join(project, '.claude', 'settings.local.json'), 'utf8')).toBe('{"mine":true}\n');
    } catch {
      // No right to make file links here: the folder case below still runs.
    }
    expect(await readFile(target, 'utf8')).toBe('theirs\n');
    // The folder a link (a junction on Windows) to a folder outside: refused, nothing written there.
    await rm(path.join(project, '.claude'), { recursive: true, force: true });
    await rm(target, { force: true });
    await writeFile(target, 'theirs\n', 'utf8');
    await symlink(outside, path.join(project, '.claude'), 'junction');
    await revertProtectedChanges(project, snapshot).catch(() => undefined);
    expect(await readFile(target, 'utf8')).toBe('theirs\n');
  });

  it('skills, commands and agents that declare hooks go back as the workspace had them; others stay (decision 1 of 2026-11-24)', async () => {
    const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    const hooked = (name: string) => `---\nname: ${name}\ndescription: x\nhooks:\n  PreToolUse: []\n---\n\nBody.\n`;
    const plain = (name: string) => `---\nname: ${name}\ndescription: x\n---\n\nBody.\n`;
    const put = async (file: string, text: string) => {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), text, 'utf8');
    };
    // The workspace: a tracked skill, an ignored folder of agents with one already there (hooks and all: not the step's).
    await put('.gitignore', '.claude/agents/local/\n');
    await put('.claude/skills/plan/SKILL.md', plain('plan'));
    await put('.claude/agents/local/mine.md', hooked('mine'));
    run(['init', '-q']);
    run(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '-A']);
    run(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'workspace']);
    const snapshot = await snapshotProtectedFiles(dir);
    expect([...snapshot.keys()]).toEqual(['.claude/agents/local/mine.md']);
    // The step: hooks added to the tracked skill, a new agent and a new command with hooks, one in the ignored folder,
    // a frontmatter that cannot be read, a new skill without hooks, and the code.
    await put('.claude/skills/plan/SKILL.md', hooked('plan'));
    await put('.claude/agents/helper.md', hooked('helper'));
    await put('sub/.Claude/Commands/go.md', hooked('go'));
    await put('.claude/agents/local/new.md', hooked('new'));
    await put('.claude/agents/broken.md', '---\nname: [unclosed\n---\n');
    await put('.claude/skills/fine/SKILL.md', plain('fine'));
    await put('src/a.js', 'ok\n');
    const reverted = await revertHookDefinitions(dir, snapshot);
    expect(reverted.sort()).toEqual(['.claude/agents/broken.md', '.claude/agents/helper.md', '.claude/agents/local/new.md', '.claude/skills/plan/SKILL.md', 'sub/.Claude/Commands/go.md']);
    expect((await readFile(path.join(dir, '.claude', 'skills', 'plan', 'SKILL.md'), 'utf8')).replaceAll('\r\n', '\n')).toBe(plain('plan'));
    for (const gone of ['.claude/agents/helper.md', 'sub/.Claude/Commands/go.md', '.claude/agents/local/new.md', '.claude/agents/broken.md']) await expect(stat(path.join(dir, gone)), gone).rejects.toThrow();
    expect(await readFile(path.join(dir, '.claude', 'agents', 'local', 'mine.md'), 'utf8')).toBe(hooked('mine'));
    expect(await readFile(path.join(dir, '.claude', 'skills', 'fine', 'SKILL.md'), 'utf8')).toBe(plain('fine'));
    expect(await readFile(path.join(dir, 'src', 'a.js'), 'utf8')).toBe('ok\n');
    // The ignored one that was there, changed: written back as it was; the protected put-back never writes it.
    await put('.claude/agents/local/mine.md', hooked('changed'));
    expect(await revertProtectedChanges(dir, snapshot)).toEqual([]);
    expect(await revertHookDefinitions(dir, snapshot)).toEqual(['.claude/agents/local/mine.md']);
    expect(await readFile(path.join(dir, '.claude', 'agents', 'local', 'mine.md'), 'utf8')).toBe(hooked('mine'));
    expect(await revertHookDefinitions(dir, snapshot)).toEqual([]);
  });

  it('a commit in a folder that is no longer a project is a warning, not an error', async () => {
    expect(await realImplementSystem().commit(dir, 'x')).toEqual({ committed: false, nothingToCommit: false, warning: 'notABriefstackProject' });
  });
});
