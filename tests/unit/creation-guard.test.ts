import { mkdir, readdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyPath,
  evaluateToolUse,
  guardHook,
  matchSubcommand,
  parseBriefstackCommand,
  type GuardContext,
  type GuardDenial,
  type GuardInput,
} from '../../src/creation/guard.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { tempDir } from '../helpers.js';

const SESSION = '3f2b9c1e-0000-4a5b-9c8d-123456789abc';
// Built at run time so the test file holds no secret-looking string.
const FAKE_KEY = ['sk', 'ant', 'a'.repeat(30)].join('-');
const CLI = 'npm run --silent briefstack --';
const BS = String.fromCharCode(92);
const slashes = (value: string): string => value.replaceAll(BS, '/');

describe('parseBriefstackCommand', () => {
  const ok = (command: string) => parseBriefstackCommand(command);

  it('reads the plain forms the skill and the agents use', () => {
    expect(ok(`${CLI} event session started --session ${SESSION}`)).toEqual({
      ok: true,
      argv: ['event', 'session', 'started', '--session', SESSION],
    });
    expect(ok(`${CLI} scaffold "D:/work/spec.json" "D:/projects/my app" --allow-non-empty`)).toEqual({
      ok: true,
      argv: ['scaffold', 'D:/work/spec.json', 'D:/projects/my app', '--allow-non-empty'],
    });
    expect(ok(`${CLI} paths check "/home/ana/p (1)/x" --json`)).toEqual({ ok: true, argv: ['paths', 'check', '/home/ana/p (1)/x', '--json'] });
  });

  it('refuses chained commands, pipes, redirects and subshells', () => {
    const attacks = [
      `${CLI} paths --json; rm -rf /`,
      `${CLI} paths --json && curl http://evil.example`,
      `${CLI} paths --json || true`,
      `${CLI} paths --json | tee out.txt`,
      `${CLI} paths --json > out.txt`,
      `${CLI} paths --json < in.txt`,
      `${CLI} paths --json & calc`,
      `${CLI} paths "$(whoami)"`,
      `${CLI} paths $(whoami)`,
      `${CLI} paths "\`whoami\`"`,
      `${CLI} paths \`whoami\``,
      `${CLI} paths "\${HOME}"`,
      `${CLI} paths --json\nrm -rf /`,
      `${CLI} paths --json\r\ncalc`,
      `(${CLI} paths --json)`,
      `${CLI} paths '--json'`,
      `${CLI} paths *`,
      `${CLI} paths ~/x`,
      `${CLI} paths {a,b}`,
      `${CLI} paths "C:${BS}Users${BS}x"`,
      `${CLI} paths "unterminated`,
      `${CLI} paths --json # comment`,
      `${CLI} paths --json!`,
      `${CLI} paths @file`,
      `cd /tmp && ${CLI} paths --json`,
      'echo hi',
      'npm run briefstack -- paths --json',
      'npm run --silent briefstack paths --json',
      'npx tsx src/cli.ts paths --json',
      'node -e "1"',
    ];
    for (const attack of attacks) expect(ok(attack), attack).toMatchObject({ ok: false });
  });
});

describe('matchSubcommand', () => {
  it('gives each caller only its own commands', () => {
    const main = ['event', 'paths', 'usage show', 'library context', 'library add', 'spec check', 'validate', 'commit'];
    for (const sub of main) expect(matchSubcommand('main', sub.split(' ')), sub).toEqual(sub.split(' '));
    for (const sub of ['scaffold', 'usage set', 'init', 'web', 'library list', 'library show']) {
      expect(matchSubcommand('main', sub.split(' ')), sub).toBeUndefined();
    }
    expect(matchSubcommand('generator', ['scaffold'])).toEqual(['scaffold']);
    expect(matchSubcommand('generator', ['validate'])).toEqual(['validate']);
    expect(matchSubcommand('generator', ['commit'])).toBeUndefined();
    expect(matchSubcommand('generator', ['event'])).toBeUndefined();
    expect(matchSubcommand('reviewer', ['validate'])).toEqual(['validate']);
    expect(matchSubcommand('reviewer', ['scaffold'])).toBeUndefined();
    expect(matchSubcommand('other', ['validate'])).toBeUndefined();
  });
});

describe('classifyPath', () => {
  it('refuses relative and drive-less paths in both path styles', () => {
    expect(classifyPath(['C:', 'Users', 'Ana', 'p'].join(BS), { pathApi: path.win32 })).toBe('ok');
    expect(classifyPath(['', '', 'server', 'share', 'p'].join(BS), { pathApi: path.win32 })).toBe('ok');
    expect(classifyPath('/c/Users/Ana/p', { pathApi: path.win32 })).toBe('not-fully-absolute');
    expect(classifyPath(['', 'Users', 'Ana', 'p'].join(BS), { pathApi: path.win32 })).toBe('not-fully-absolute');
    expect(classifyPath('D:p', { pathApi: path.win32 })).toBe('relative');
    expect(classifyPath(['p', 'x'].join(BS), { pathApi: path.win32 })).toBe('relative');
    expect(classifyPath('/home/ana/p', { pathApi: path.posix })).toBe('ok');
    expect(classifyPath('./p', { pathApi: path.posix })).toBe('relative');
    expect(classifyPath('../p', { pathApi: path.posix })).toBe('relative');
  });
});

describe('evaluateToolUse', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let projectsDir: string;
  let sessionsDir: string;
  let outside: string;
  let granted: string[];
  let cancelled: boolean;
  let ctx: GuardContext;

  const input = (tool: string, toolInput: unknown, who: Partial<GuardInput> = {}): GuardInput => ({
    session_id: SESSION,
    tool_name: tool,
    tool_input: toolInput,
    ...who,
  });
  const verdictOf = async (tool: string, toolInput: unknown, who: Partial<GuardInput> = {}) =>
    (await evaluateToolUse(ctx, input(tool, toolInput, who))).verdict;
  const shell = (command: string, who: Partial<GuardInput> = {}) => verdictOf('Bash', { command }, who);
  const generator = { agent_id: 'a1', agent_type: 'generator' };
  const reviewer = { agent_id: 'a2', agent_type: 'reviewer' };

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('guard'));
    projectsDir = path.join(dir, 'projects');
    sessionsDir = path.join(dir, 'sessions');
    outside = path.join(dir, 'elsewhere');
    await mkdir(path.join(projectsDir, 'app'), { recursive: true });
    await mkdir(path.join(sessionsDir, SESSION), { recursive: true });
    await mkdir(outside, { recursive: true });
    granted = [];
    cancelled = false;
    ctx = {
      isOwnSession: (id) => id === SESSION,
      sessionDir: (id) => path.join(sessionsDir, id),
      projectsDir,
      grantedDirs: () => granted,
      cancelled: () => cancelled,
    };
  });
  afterEach(() => cleanup());

  describe('writes', () => {
    it('allows the projects folder, the session folder and granted folders only', async () => {
      expect(await verdictOf('Write', { file_path: path.join(projectsDir, 'app', 'CLAUDE.md') })).toBe('allow');
      expect(await verdictOf('Edit', { file_path: path.join(projectsDir, 'new-folder', 'deep', 'a.md') })).toBe('allow');
      expect(await verdictOf('Write', { file_path: path.join(sessionsDir, SESSION, 'spec.json') })).toBe('allow');
      expect(await verdictOf('Write', { file_path: path.join(outside, 'a.md') })).toBe('deny');
      granted.push(outside);
      expect(await verdictOf('Write', { file_path: path.join(outside, 'a.md') })).toBe('allow');
      expect(await verdictOf('NotebookEdit', { notebook_path: path.join(outside, 'n.ipynb') })).toBe('allow');
    });

    it('denies the repo, the library folder next to it and other sessions', async () => {
      expect(await verdictOf('Write', { file_path: path.join(PACKAGE_ROOT, 'src', 'cli.ts') })).toBe('deny');
      expect(await verdictOf('Write', { file_path: path.join(dir, 'library', 'INDEX.md') })).toBe('deny');
      expect(await verdictOf('Write', { file_path: path.join(sessionsDir, 'other-session', 'x') })).toBe('deny');
      expect(await verdictOf('Write', { file_path: path.join(sessionsDir, 'x') })).toBe('deny');
    });

    it('is not fooled by .., relative paths or a name that only starts like an allowed folder', async () => {
      expect(await verdictOf('Write', { file_path: path.join(projectsDir, '..', 'elsewhere', 'a.md') })).toBe('deny');
      expect(await verdictOf('Write', { file_path: `${projectsDir}${path.sep}..${path.sep}..${path.sep}x` })).toBe('deny');
      expect(await verdictOf('Write', { file_path: 'CLAUDE.md' })).toBe('deny');
      expect(await verdictOf('Write', { file_path: './projects/a.md' })).toBe('deny');
      expect(await verdictOf('Write', { file_path: '../a.md' })).toBe('deny');
      expect(await verdictOf('Write', { file_path: `${projectsDir}-evil${path.sep}a.md` })).toBe('deny');
      expect(await verdictOf('Write', {})).toBe('deny');
      expect(await verdictOf('Write', { file_path: '' })).toBe('deny');
    });

    it('resolves symlinks: a link inside the projects folder that points out does not let a write out', async () => {
      const link = path.join(projectsDir, 'link-out');
      await symlink(outside, link, 'junction');
      expect(await verdictOf('Write', { file_path: path.join(link, 'a.md') })).toBe('deny');
      expect(await verdictOf('Write', { file_path: path.join(link, 'deeper', 'a.md') })).toBe('deny');
      // And a link from outside into the projects folder is still the projects folder.
      const inward = path.join(outside, 'link-in');
      await symlink(path.join(projectsDir, 'app'), inward, 'junction');
      expect(await verdictOf('Write', { file_path: path.join(inward, 'a.md') })).toBe('allow');
    });

    it('denies a drive-less Windows form on Windows', async () => {
      if (process.platform !== 'win32') return;
      const withoutDrive = slashes(path.join(projectsDir, 'a.md')).slice(2);
      expect(await verdictOf('Write', { file_path: `/c${withoutDrive}` })).toBe('deny');
      expect(await verdictOf('Write', { file_path: withoutDrive })).toBe('deny');
    });
  });

  describe('shell', () => {
    it('lets the main session run its CLI commands and nothing else', async () => {
      for (const command of [
        `event step started --session ${SESSION}`,
        'paths --json',
        `paths check "${slashes(outside)}" --json`,
        'usage show --json',
        `library context --idea "${slashes(dir)}/idea.md"`,
        'library add projects my-app --from "x.md" --session abc',
        'spec check "x.json"',
        'validate "x" --json',
        'commit "x"',
      ]) {
        const verdict = command.startsWith('commit') ? await shell(`${CLI} commit "${slashes(path.join(projectsDir, 'app'))}"`) : await shell(`${CLI} ${command}`);
        expect(verdict, command).toBe('allow');
      }
      for (const command of ['usage set max', 'init', 'web', 'library list', 'library show profile style', 'scaffold "a" "b"']) {
        expect(await shell(`${CLI} ${command}`), command).toBe('deny');
      }
    });

    it('works the same through PowerShell', async () => {
      expect(await verdictOf('PowerShell', { command: `${CLI} paths --json` })).toBe('allow');
      expect(await verdictOf('PowerShell', { command: `${CLI} paths --json; Get-Content x` })).toBe('deny');
      expect(await verdictOf('PowerShell', { command: 'Get-ChildItem' })).toBe('deny');
    });

    it('lets the generator run scaffold and validate, the reviewer only validate', async () => {
      const out = slashes(path.join(projectsDir, 'app'));
      expect(await shell(`${CLI} scaffold "${slashes(dir)}/spec.json" "${out}"`, generator)).toBe('allow');
      expect(await shell(`${CLI} validate "${out}" --json`, generator)).toBe('allow');
      expect(await shell(`${CLI} commit "${out}"`, generator)).toBe('deny');
      expect(await shell(`${CLI} event step started --session ${SESSION}`, generator)).toBe('deny');
      expect(await shell(`${CLI} validate "${out}" --json`, reviewer)).toBe('allow');
      expect(await shell(`${CLI} scaffold "a" "${out}"`, reviewer)).toBe('deny');
      expect(await shell('find . -type d', reviewer)).toBe('deny');
    });

    it('gives the other agents no shell at all', async () => {
      for (const agent_type of ['interviewer', 'researcher', 'architect', 'general-purpose', '']) {
        expect(await shell(`${CLI} paths --json`, { agent_id: 'a9', agent_type }), agent_type).toBe('deny');
      }
    });

    it('checks where scaffold and commit would write', async () => {
      const inside = slashes(path.join(projectsDir, 'app'));
      const out = slashes(outside);
      expect(await shell(`${CLI} scaffold "x.json" "${out}"`, generator)).toBe('deny');
      expect(await shell(`${CLI} scaffold "x.json" "${inside}/../../elsewhere/app"`, generator)).toBe('deny');
      expect(await shell(`${CLI} scaffold "x.json" "relative/app"`, generator)).toBe('deny');
      expect(await shell(`${CLI} scaffold "x.json" "${inside}/../new"`, generator)).toBe('allow');
      expect(await shell(`${CLI} commit "${out}"`)).toBe('deny');
      expect(await shell(`${CLI} commit "${inside}"`)).toBe('allow');
      granted.push(outside);
      expect(await shell(`${CLI} commit "${out}"`)).toBe('allow');
      const link = path.join(projectsDir, 'link-out');
      await symlink(outside, link, 'junction');
      granted.length = 0;
      expect(await shell(`${CLI} scaffold "x.json" "${slashes(link)}/app"`, generator)).toBe('deny');
    });

    it('tells the model to use forward slashes when a path has backslashes', async () => {
      const reasonOf = async (command: string, who: Partial<GuardInput> = {}) =>
        ((await evaluateToolUse(ctx, input('Bash', { command }, who))) as { reason: string }).reason;
      const quoted = `${CLI} validate "C:${BS}Users${BS}Ana${BS}projects${BS}app" --json`;
      const bare = `${CLI} validate C:${BS}Users${BS}Ana${BS}app`;
      for (const command of [quoted, bare]) {
        const reason = await reasonOf(command, reviewer);
        expect(reason, command).toContain('forward slashes');
        expect(reason, command).toContain('C:/Users/you/projects/app');
        expect(reason, command).toContain('backslash');
      }
      // The same hint for the generator's scaffold, and none when the cause is something else.
      expect(await reasonOf(`${CLI} scaffold "C:${BS}x.json" "C:${BS}out"`, generator)).toContain('forward slashes');
      expect(await reasonOf(`${CLI} paths --json && ls`)).not.toContain('backslash');
    });

    it('gives a reason the model can act on', async () => {
      const verdict = await evaluateToolUse(ctx, input('Bash', { command: `${CLI} paths --json && ls` }));
      expect(verdict).toMatchObject({ verdict: 'deny' });
      expect((verdict as { reason: string }).reason).toContain('npm run --silent briefstack');
    });
  });

  it('allows web access for the researcher only', async () => {
    const researcher = { agent_id: 'a3', agent_type: 'researcher' };
    expect(await verdictOf('WebSearch', { query: 'x' }, researcher)).toBe('allow');
    expect(await verdictOf('WebFetch', { url: 'https://example.com' }, researcher)).toBe('allow');
    expect(await verdictOf('WebFetch', { url: 'https://example.com' })).toBe('pass');
    expect(await verdictOf('WebFetch', { url: 'https://example.com' }, generator)).toBe('pass');
  });

  it('leaves other tools to the permission mode', async () => {
    for (const tool of ['Read', 'Glob', 'Grep', 'Agent', 'AskUserQuestion', 'mcp__briefstack-web__approve_spec']) {
      expect(await verdictOf(tool, {}), tool).toBe('pass');
    }
  });

  describe('after a cancel', () => {
    it('denies everything except the main session closing the session', async () => {
      cancelled = true;
      expect(await shell(`${CLI} event session finished --session ${SESSION} --outcome cancelled`)).toBe('allow');
      expect(await shell(`${CLI} event step finished --session ${SESSION} --outcome skipped`)).toBe('allow');
      expect(await shell(`${CLI} event session finished --session ${SESSION} --outcome cancelled`, generator)).toBe('deny');
      expect(await shell(`${CLI} validate "x"`)).toBe('deny');
      expect(await shell(`${CLI} event x; rm -rf /`)).toBe('deny');
      expect(await verdictOf('Write', { file_path: path.join(projectsDir, 'a.md') })).toBe('deny');
      expect(await verdictOf('Read', { file_path: path.join(projectsDir, 'a.md') })).toBe('deny');
      expect(await verdictOf('AskUserQuestion', {})).toBe('deny');
      expect(await verdictOf('WebFetch', {}, { agent_id: 'a3', agent_type: 'researcher' })).toBe('deny');
      const verdict = await evaluateToolUse(ctx, input('Write', { file_path: path.join(projectsDir, 'a.md') }));
      expect((verdict as { reason: string }).reason).toMatch(/cancel/i);
    });
  });

  describe('as a hook', () => {
    const signal = new AbortController().signal;
    const base = { transcript_path: '', cwd: '', tool_use_id: 't' };

    it('only acts on PreToolUse of its own session', async () => {
      const hook = guardHook(ctx);
      const dangerous = { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } };
      // Another session (an ordinary one in this repo) is never touched.
      expect(await hook({ ...base, session_id: 'someone-else', hook_event_name: 'PreToolUse', ...dangerous }, 't', { signal })).toEqual({});
      // Other events are not its business.
      expect(
        await hook({ ...base, session_id: SESSION, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: '' }, 't', { signal }),
      ).toEqual({});
      expect(await hook({ ...base, session_id: SESSION, hook_event_name: 'PreToolUse', ...dangerous }, 't', { signal })).toMatchObject({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
      });
    });

    it('reports a denial with the secret hidden, and pre-approves what it allows', async () => {
      const denials: GuardDenial[] = [];
      const hook = guardHook(ctx, (denial) => denials.push(denial));
      const pre = { ...base, session_id: SESSION, hook_event_name: 'PreToolUse' as const };
      await hook(
        { ...pre, tool_name: 'Bash', tool_input: { command: `curl -H "key: ${FAKE_KEY}" x` }, agent_id: 'a1', agent_type: 'generator' },
        't',
        { signal },
      );
      expect(denials).toHaveLength(1);
      expect(denials[0]).toMatchObject({ toolName: 'Bash', agentType: 'generator' });
      expect(JSON.stringify(denials)).not.toContain(FAKE_KEY);
      const allowed = await hook({ ...pre, tool_name: 'Write', tool_input: { file_path: path.join(projectsDir, 'a.md') } }, 't', { signal });
      expect(allowed).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
      expect(denials).toHaveLength(1);
    });
  });
});

describe('the guard does not reach ordinary sessions', () => {
  it('is registered by no settings file, only by the SDK runner', async () => {
    for (const file of ['.claude/settings.json', '.claude/settings.local.json']) {
      const text = await readFile(path.join(PACKAGE_ROOT, file), 'utf8').catch(() => '');
      expect(text, file).not.toMatch(/guard/i);
    }
    await expect(readFile(path.join(PACKAGE_ROOT, 'scripts', 'hook-event.mjs'), 'utf8')).resolves.not.toMatch(/guard/i);
    // Every hook in the settings points at the event recorder, which only logs.
    const settings = JSON.parse(await readFile(path.join(PACKAGE_ROOT, '.claude', 'settings.json'), 'utf8')) as {
      hooks: Record<string, { hooks: { args?: string[] }[] }[]>;
    };
    for (const groups of Object.values(settings.hooks)) {
      for (const group of groups) for (const hook of group.hooks) expect(hook.args?.join(' ')).toContain('hook-event.mjs');
    }
  });

  it('is built only in sdkRunner.ts', async () => {
    const users: string[] = [];
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith('.ts') && /\bguardHook\s*\(/.test(await readFile(full, 'utf8'))) {
          users.push(slashes(path.relative(PACKAGE_ROOT, full)));
        }
      }
    };
    await walk(path.join(PACKAGE_ROOT, 'src'));
    expect(users.sort()).toEqual(['src/creation/guard.ts', 'src/creation/sdkRunner.ts']);
  });
});
