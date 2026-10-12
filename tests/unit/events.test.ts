import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli.js';
import { resolveHome } from '../../src/config/config.js';
import {
  EVENTS_FILE,
  appendEvent,
  flowEvent,
  readEvents,
  sessionEventsFile,
  sessionLifecycleEvent,
  summarizeSession,
  type SessionEvent,
} from '../../src/events/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { briefstackHome as hookHome, isFullyAbsolute as hookIsFullyAbsolute } from '../../scripts/hook-event.mjs';
import { tempDir } from '../helpers.js';

const execFileAsync = promisify(execFile);
const HOOK_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'hook-event.mjs');
const SESSION = '3f2b9c1e-0000-4a5b-9c8d-123456789abc';

/** Runs the hook script the way Claude Code does: payload on stdin. */
async function runHook(payload: string, env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [HOOK_SCRIPT],
      { env: { ...process.env, ...env } },
      (error, _stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stderr }),
    );
    child.stdin?.end(payload);
  });
}

describe('events', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let sessionsDir: string;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('events'));
    sessionsDir = path.join(dir, 'home', 'sessions');
  });
  afterEach(() => cleanup());

  it('appends flow events as JSON lines and reads them back', async () => {
    const t1 = new Date('2026-10-12T10:00:00Z');
    const t2 = new Date('2026-10-12T10:05:00Z');
    const file = await appendEvent(sessionsDir, flowEvent(SESSION, 'interview', 'started', undefined, t1));
    await appendEvent(sessionsDir, flowEvent(SESSION, 'interview', 'finished', 'ok', t2));
    expect(file).toBe(path.join(sessionsDir, SESSION, EVENTS_FILE));

    const text = await readFile(file, 'utf8');
    expect(text.split('\n')).toHaveLength(3);
    expect(await readEvents(file)).toEqual({
      events: [
        { v: 1, ts: t1.toISOString(), session: SESSION, source: 'flow', type: 'step.started', step: 'interview' },
        { v: 1, ts: t2.toISOString(), session: SESSION, source: 'flow', type: 'step.finished', step: 'interview', outcome: 'ok' },
      ],
      badLines: [],
    });
  });

  it('never rewrites earlier lines', async () => {
    const file = await appendEvent(sessionsDir, flowEvent(SESSION, 'idea', 'started'));
    const before = await readFile(file, 'utf8');
    await appendEvent(sessionsDir, flowEvent(SESSION, 'idea', 'finished'));
    expect((await readFile(file, 'utf8')).startsWith(before)).toBe(true);
  });

  it('reports bad lines without failing', async () => {
    const file = sessionEventsFile(sessionsDir, SESSION);
    await appendEvent(sessionsDir, flowEvent(SESSION, 'spec', 'started'));
    await writeFile(file, `${await readFile(file, 'utf8')}not json\n{"v":1}\n`, 'utf8');
    const result = await readEvents(file);
    expect(result.events).toHaveLength(1);
    expect(result.badLines).toEqual([2, 3]);
    expect(await readEvents(path.join(dir, 'missing.jsonl'))).toEqual({ events: [], badLines: [] });
  });

  it('refuses session ids that could leave the sessions folder', () => {
    for (const bad of ['', '../x', 'a/b', 'a\\b', '.hidden', 'a..b', 'C:x']) {
      expect(() => sessionEventsFile(sessionsDir, bad), bad).toThrow(
        expect.objectContaining({ code: 'events.invalidSession' }),
      );
    }
  });
});

describe('hook script', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let env: Record<string, string>;
  let eventsFile: string;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('hook'));
    env = { BRIEFSTACK_HOME: path.join(dir, 'home') };
    eventsFile = path.join(dir, 'home', 'sessions', SESSION, EVENTS_FILE);
    // As /new-project does with `briefstack event session started`.
    await mkdir(path.dirname(eventsFile), { recursive: true });
  });
  afterEach(() => cleanup());

  it('without a session folder writes nothing and exits 0', async () => {
    const home = path.join(dir, 'other-home');
    for (const name of ['SubagentStart', 'PreToolUse', 'PostToolUse', 'SubagentStop']) {
      const result = await runHook(payload({ hook_event_name: name, tool_name: 'Read', agent_type: 'x' }), {
        BRIEFSTACK_HOME: home,
      });
      expect(result).toEqual({ code: 0, stderr: '' });
    }
    // Not even the home folder is created.
    await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  const payload = (fields: Record<string, unknown>) =>
    JSON.stringify({ session_id: SESSION, transcript_path: 'x', cwd: dir, ...fields });

  it('writes events the TypeScript reader accepts, without tool inputs', async () => {
    const secret = 'do-not-record-this-value';
    const payloads = [
      payload({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'interviewer' }),
      payload({ hook_event_name: 'PreToolUse', agent_id: 'a1', agent_type: 'interviewer', tool_name: 'Read', tool_input: { file_path: secret } }),
      payload({ hook_event_name: 'PostToolUse', agent_id: 'a1', agent_type: 'interviewer', tool_name: 'Read', tool_response: secret }),
      payload({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' }),
      payload({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'interviewer', last_assistant_message: secret }),
    ];
    for (const item of payloads) expect((await runHook(item, env)).code).toBe(0);

    const text = await readFile(eventsFile, 'utf8');
    expect(text).not.toContain(secret);
    const { events, badLines } = await readEvents(eventsFile);
    expect(badLines).toEqual([]);
    expect(events.map((event) => [event.type, 'tool' in event ? event.tool : undefined])).toEqual([
      ['subagent.start', undefined],
      ['tool.pre', 'Read'],
      ['tool.post', 'Read'],
      ['tool.failure', 'Bash'],
      ['subagent.stop', undefined],
    ]);
    expect(events[0]).toMatchObject({ source: 'hook', session: SESSION, agentId: 'a1', agentType: 'interviewer' });
  });

  it('ignores other events and bad input, always exiting 0', async () => {
    const cases = [
      payload({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' }),
      payload({ hook_event_name: 'PreToolUse', session_id: '../escape', tool_name: 'Read' }),
      'not json',
      '',
    ];
    for (const item of cases) {
      const result = await runHook(item, env);
      expect(result).toEqual({ code: 0, stderr: '' });
    }
    await expect(readFile(eventsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes nothing when BRIEFSTACK_HOME is relative, like the CLI refuses it', async () => {
    const result = await runHook(payload({ hook_event_name: 'PreToolUse', tool_name: 'Read' }), {
      BRIEFSTACK_HOME: 'relative-home',
    });
    expect(result.code).toBe(0);
    await expect(readFile(path.join(dir, 'relative-home'), 'utf8')).rejects.toBeDefined();
  });

  it('resolves the briefstack home like the CLI', async () => {
    const homeEnv = { env: { BRIEFSTACK_HOME: env.BRIEFSTACK_HOME }, homedir: dir, pathApi: path, caseInsensitive: false };
    expect(path.join(resolveHome(homeEnv), 'sessions', SESSION, EVENTS_FILE)).toBe(eventsFile);
    await runHook(payload({ hook_event_name: 'SubagentStart', agent_type: 'x' }), env);
    expect((await readEvents(eventsFile)).events).toHaveLength(1);
  });
});

describe('cli event', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('cli-event'));
  });
  afterEach(() => cleanup());

  function capture(env: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIO = {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      cwd: dir,
      repoDir: path.join(dir, 'repo'),
      pathEnv: {
        env: { BRIEFSTACK_HOME: path.join(dir, 'home'), BRIEFSTACK_LANG: 'en', ...env },
        homedir: path.join(dir, 'user'),
        pathApi: path,
        caseInsensitive: process.platform !== 'linux',
      },
    };
    return { io, out, err };
  }

  it('records a step silently', async () => {
    const run = capture();
    expect(await main(['event', 'research', 'finished', '--session', SESSION, '--outcome', 'skipped'], run.io)).toBe(0);
    expect(run.out).toEqual([]);
    expect(run.err).toEqual([]);
    const { events } = await readEvents(path.join(dir, 'home', 'sessions', SESSION, EVENTS_FILE));
    expect(events).toEqual([expect.objectContaining({ type: 'step.finished', step: 'research', outcome: 'skipped' })]);
  });

  it('rejects bad steps, phases, outcomes and sessions', async () => {
    const run = capture({ BRIEFSTACK_LANG: 'es' });
    expect(await main(['event', 'coding', 'started', '--session', SESSION], run.io)).toBe(2);
    expect(await main(['event', 'spec', 'paused', '--session', SESSION], run.io)).toBe(2);
    expect(await main(['event', 'spec', 'started', '--session', SESSION, '--outcome', 'great'], run.io)).toBe(2);
    expect(await main(['event', 'spec', 'started'], run.io)).toBe(2);
    expect(await main(['event', 'spec', 'started', '--session', '../x'], run.io)).toBe(1);
    expect(run.err[0]).toContain('Paso del flujo desconocido "coding"');
    expect(run.err.at(-1)).toContain('no es un id de sesión válido');
  });
});

describe('hook script home resolution (pure, writes nothing)', () => {
  const styles = [
    { name: 'win32', pathApi: path.win32, home: 'C:\\Users\\someone' },
    { name: 'posix', pathApi: path.posix, home: '/home/someone' },
  ] as const;

  it.each(styles)('matches the CLI for every kind of value ($name)', ({ pathApi, home }) => {
    const values = [
      undefined,
      '',
      '~',
      '~/bs',
      '~\\bs',
      'relative',
      '/c/Users/someone/bs',
      '\\data\\bs',
      'C:\\data\\bs',
      'D:/data/bs',
      '\\\\server\\share\\bs',
      '/srv/bs',
    ];
    for (const value of values) {
      const env = value === undefined ? {} : { BRIEFSTACK_HOME: value };
      let cli: string | undefined;
      try {
        cli = resolveHome({ env, homedir: home, pathApi, caseInsensitive: false });
      } catch {
        cli = undefined;
      }
      expect(hookHome(env, home, pathApi), String(value)).toBe(cli);
    }
  });

  it('refuses a Git Bash /c/... path on Windows instead of using C:\\c\\...', () => {
    expect(hookHome({ BRIEFSTACK_HOME: '/c/Users/someone/bs' }, 'C:\\Users\\someone', path.win32)).toBeUndefined();
    expect(hookIsFullyAbsolute('/c/Users/someone/bs', path.win32)).toBe(false);
    expect(hookHome({ BRIEFSTACK_HOME: '/c/Users/someone/bs' }, '/home/someone', path.posix)).toBe('/c/Users/someone/bs');
  });
});

describe('hook script syntax', () => {
  it('parses with the current Node', async () => {
    await expect(execFileAsync(process.execPath, ['--check', HOOK_SCRIPT])).resolves.toBeDefined();
  });
});

describe('summarizeSession', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 12, 10, minutes));
  const opened: SessionEvent[] = [
    sessionLifecycleEvent(SESSION, 'started', undefined, at(0)),
    flowEvent(SESSION, 'idea', 'started', undefined, at(0)),
    flowEvent(SESSION, 'idea', 'finished', 'ok', at(1)),
    flowEvent(SESSION, 'interview', 'started', undefined, at(2)),
  ];

  it('is finished when the closing event is there', () => {
    const events = [...opened, sessionLifecycleEvent(SESSION, 'finished', 'cancelled', at(5))];
    expect(summarizeSession(events, { now: at(59) })).toEqual({
      status: 'finished',
      outcome: 'cancelled',
      startedAt: at(0).toISOString(),
      lastEventAt: at(5).toISOString(),
      lastStep: { step: 'interview', phase: 'started' },
    });
    expect(summarizeSession([...opened, sessionLifecycleEvent(SESSION, 'finished', undefined, at(5))]).outcome).toBe(
      'completed',
    );
  });

  it('is in progress while events are recent, interrupted once they go stale', () => {
    expect(summarizeSession(opened, { now: at(30) }).status).toBe('in-progress');
    expect(summarizeSession(opened, { now: new Date(at(2).getTime() + 121 * 60_000) }).status).toBe('interrupted');
    expect(summarizeSession(opened, { now: at(30), staleAfterMinutes: 10 }).status).toBe('interrupted');
  });

  it('counts hook events as activity', () => {
    const hook: SessionEvent = { v: 1, ts: at(50).toISOString(), session: SESSION, source: 'hook', type: 'tool.pre', tool: 'Read' };
    const summary = summarizeSession([...opened, hook], { now: at(59), staleAfterMinutes: 10 });
    expect(summary).toMatchObject({ status: 'in-progress', lastEventAt: at(50).toISOString() });
  });

  it('treats a session with no events as interrupted', () => {
    expect(summarizeSession([], { now: at(0) }).status).toBe('interrupted');
  });
});

describe('cli event session', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('cli-session'));
  });
  afterEach(() => cleanup());

  const io = (): CliIO => ({
    out: () => undefined,
    err: () => undefined,
    cwd: dir,
    repoDir: path.join(dir, 'repo'),
    pathEnv: {
      env: { BRIEFSTACK_HOME: path.join(dir, 'home'), BRIEFSTACK_LANG: 'en' },
      homedir: path.join(dir, 'user'),
      pathApi: path,
      caseInsensitive: process.platform !== 'linux',
    },
  });

  it('opens the session so hooks record, and closes it', async () => {
    const env = { BRIEFSTACK_HOME: path.join(dir, 'home') };
    const file = path.join(dir, 'home', 'sessions', SESSION, EVENTS_FILE);
    const hookPayload = JSON.stringify({ session_id: SESSION, hook_event_name: 'PreToolUse', tool_name: 'Read' });

    await runHook(hookPayload, env);
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });

    expect(await main(['event', 'session', 'started', '--session', SESSION], io())).toBe(0);
    await runHook(hookPayload, env);
    expect(await main(['event', 'session', 'finished', '--session', SESSION, '--outcome', 'completed'], io())).toBe(0);

    const { events } = await readEvents(file);
    expect(events.map((event) => event.type)).toEqual(['session.started', 'tool.pre', 'session.finished']);
    expect(summarizeSession(events).status).toBe('finished');
  });

  it('checks session outcomes separately from step outcomes', async () => {
    expect(await main(['event', 'session', 'finished', '--session', SESSION, '--outcome', 'skipped'], io())).toBe(2);
    expect(await main(['event', 'spec', 'finished', '--session', SESSION, '--outcome', 'cancelled'], io())).toBe(2);
  });
});

describe('repo hook configuration', () => {
  it('runs the hook script in exec form (no shell) for the recorded events', async () => {
    const settings = JSON.parse(await readFile(path.join(PACKAGE_ROOT, '.claude', 'settings.json'), 'utf8')) as {
      hooks: Record<string, { hooks: { type: string; command: string; args?: string[]; shell?: string }[] }[]>;
    };
    expect(Object.keys(settings.hooks).sort()).toEqual(
      ['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SubagentStart', 'SubagentStop'].sort(),
    );
    for (const groups of Object.values(settings.hooks)) {
      expect(groups).toEqual([
        { hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/scripts/hook-event.mjs'] }] },
      ]);
    }
  });
});
