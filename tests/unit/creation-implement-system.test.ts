import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkEnvironment, cleanCommandOutput, commandEnv, realImplementSystem, runCommandLine } from '../../src/creation/implementSystem.js';
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

  it('a commit in a folder that is no longer a project is a warning, not an error', async () => {
    expect(await realImplementSystem().commit(dir, 'x')).toEqual({ committed: false, nothingToCommit: false, warning: 'notABriefstackProject' });
  });
});
