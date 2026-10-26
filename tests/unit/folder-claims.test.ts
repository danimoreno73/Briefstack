import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRunner, parseRecording } from '../../src/creation/fakeRunner.js';
import { FolderClaims, claimRefusedMessage, evaluateFolderClaim, folderClaimHook, folderLabel, type FolderClaimContext } from '../../src/creation/folderClaims.js';
import { CreationManager } from '../../src/creation/manager.js';
import { appendEvent, flowEvent, readEvents, sessionEventsFile, sessionLifecycleEvent } from '../../src/events/index.js';
import { recordSessionFolder } from '../../src/events/sessionFolder.js';
import { tempDir } from '../helpers.js';

const root = path.resolve('/work/projects');
const TERMINAL = 'terminal-session-1';
const at = (...parts: string[]) => path.join(root, ...parts);
const slash = (value: string) => value.replaceAll('\\', '/');

describe('FolderClaims', () => {
  it('refuses a folder another creation holds, inside it or around it, and frees it on release', () => {
    const claims = new FolderClaims();
    expect(claims.claim('a', at('garden'), 'A garden planner')).toEqual({ ok: true });
    expect(claims.claim('b', at('garden'), 'A recipe box')).toEqual({ ok: false, holder: 'A garden planner' });
    expect(claims.claim('b', at('garden', 'sub'), 'A recipe box')).toEqual({ ok: false, holder: 'A garden planner' });
    expect(claims.claim('b', root, 'A recipe box')).toEqual({ ok: false, holder: 'A garden planner' });
    expect(claims.claim('b', at('garden-two'), 'A recipe box')).toEqual({ ok: true });
    // The owner may change its mind; the old folder is free again.
    expect(claims.claim('a', at('orchard'), 'A garden planner')).toEqual({ ok: true });
    expect(claims.of('a')).toBe(at('orchard'));
    expect(claims.claim('c', at('garden'), 'Third')).toEqual({ ok: true });
    expect(claims.heldByOther('b', at('garden', 'README.md'))).toBe('Third');
    expect(claims.heldByOther('c', at('garden', 'README.md'))).toBeUndefined();
    claims.release('c');
    expect(claims.heldByOther('b', at('garden', 'README.md'))).toBeUndefined();
  });

  it('compares paths the way the platform does', () => {
    const claims = new FolderClaims();
    claims.claim('a', at('Garden'), 'A');
    const other = claims.claim('b', at('garden'), 'B');
    expect(other.ok).toBe(process.platform !== 'win32' && process.platform !== 'darwin');
  });

  it('keeps only the start of the idea, with secrets hidden', () => {
    const claims = new FolderClaims();
    claims.claim('a', at('x'), `${'long idea '.repeat(20)}`);
    const refused = claims.claim('b', at('x'), 'B');
    expect(refused.ok === false && refused.holder.length).toBeLessThanOrEqual(60);
  });

  it('counts the folders held outside this server as taken by every creation, until a refresh drops them', () => {
    const claims = new FolderClaims();
    claims.setOutside([{ dir: at('garden'), label: 'session t1 started elsewhere' }]);
    expect(claims.claim('a', at('garden'), 'A')).toEqual({ ok: false, holder: 'session t1 started elsewhere' });
    expect(claims.claim('a', at('garden', 'sub'), 'A')).toEqual({ ok: false, holder: 'session t1 started elsewhere' });
    expect(claims.claim('a', root, 'A')).toEqual({ ok: false, holder: 'session t1 started elsewhere' });
    expect(claims.heldByOther('a', at('garden', 'README.md'))).toBe('session t1 started elsewhere');
    expect(claims.claim('a', at('orchard'), 'A')).toEqual({ ok: true });
    // The same folder written another way on a case-insensitive system.
    expect(claims.claim('b', at('Garden'), 'B').ok).toBe(process.platform === 'linux');
    claims.setOutside([]);
    expect(claims.claim('c', at('garden'), 'C')).toEqual({ ok: true });
    expect(claims.heldByOther('a', at('garden', 'README.md'))).toBe('C');
  });
});

describe('folderLabel', () => {
  it('names a folder against the projects folder, and never gives an absolute path', () => {
    expect(folderLabel(at('garden'), root)).toBe('the folder "garden" in the projects folder');
    expect(folderLabel(at('a', 'b'), root)).toBe('the folder "a/b" in the projects folder');
    expect(folderLabel(root, root)).toBe('the projects folder itself');
    expect(folderLabel(path.resolve('/elsewhere/x'), root)).toBe('that folder (outside the projects folder)');
    expect(folderLabel(at('garden'), undefined)).toBe('that folder (outside the projects folder)');
    expect(claimRefusedMessage(path.resolve('/elsewhere/x'), 'Idea', root)).not.toContain('elsewhere');
  });
});

describe('evaluateFolderClaim', () => {
  let claimed: string[];
  let held: string | undefined;
  let refuse: boolean;
  const ctx = (): FolderClaimContext => ({
    isOwnSession: (id) => id === 's1',
    claim: (dir) => (claimed.push(dir), refuse ? { ok: false, holder: 'Other idea' } : { ok: true }),
    heldByOther: () => held,
  });
  const run = (tool: string, input: Record<string, unknown>, session = 's1') =>
    evaluateFolderClaim(ctx(), { session_id: session, tool_name: tool, tool_input: input });
  const cli = (args: string) => ({ command: `npm run --silent briefstack -- ${args}` });
  beforeEach(() => {
    claimed = [];
    held = undefined;
    refuse = false;
  });

  it('claims the folder of paths check and scaffold, and refuses it when taken', () => {
    expect(run('Bash', cli(`paths check "${slash(at('garden'))}" --json`))).toEqual({ verdict: 'pass' });
    expect(run('PowerShell', cli(`scaffold "${slash(at('s.json'))}" "${slash(at('garden'))}" --allow-non-empty`))).toEqual({ verdict: 'pass' });
    expect(claimed).toEqual([slash(at('garden')), slash(at('garden'))]);
    refuse = true;
    expect(run('Bash', cli(`paths check "${slash(at('garden'))}" --json`))).toMatchObject({
      verdict: 'deny',
      reason: expect.stringContaining('Another creation in progress ("Other idea")'),
    });
  });

  it('claims the folder of paths check with --session SESSION, wherever the option is', () => {
    expect(run('Bash', cli(`paths check "${slash(at('garden'))}" --json --session s1`))).toEqual({ verdict: 'pass' });
    expect(run('Bash', cli(`paths check --session s1 "${slash(at('orchard'))}" --json`))).toEqual({ verdict: 'pass' });
    expect(claimed).toEqual([slash(at('garden')), slash(at('orchard'))]);
  });

  it('the hook reads the folders held outside the server before a call that can claim or write, and not for others', async () => {
    let refreshes = 0;
    const hook = folderClaimHook({ ...ctx(), refresh: async () => void (refreshes += 1) });
    const call = (tool: string, input: Record<string, unknown>, session = 's1') =>
      hook({ hook_event_name: 'PreToolUse', session_id: session, transcript_path: '', cwd: '', tool_name: tool, tool_input: input, tool_use_id: 't' } as never, 't', {
        signal: new AbortController().signal,
      });
    await call('Bash', cli(`paths check "${slash(at('garden'))}" --json`));
    await call('Write', { file_path: at('garden', 'a.md') });
    expect(refreshes).toBe(2);
    await call('Read', { file_path: at('garden', 'a.md') });
    await call('Write', { file_path: at('garden', 'a.md') }, 'someone-else');
    expect(refreshes).toBe(2);
    // A failed read does not fail the call: the last list stays.
    const failing = folderClaimHook({ ...ctx(), refresh: () => Promise.reject(new Error('disk')) });
    await expect(failing({ hook_event_name: 'PreToolUse', session_id: 's1', transcript_path: '', cwd: '', tool_name: 'Write', tool_input: { file_path: at('x', 'a.md') }, tool_use_id: 't' } as never, 't', { signal: new AbortController().signal })).resolves.toEqual({});
  });

  it('refuses a commit or a write into a folder another creation holds', () => {
    held = 'Other idea';
    expect(run('Bash', cli(`commit "${slash(at('garden'))}"`))).toMatchObject({ verdict: 'deny' });
    expect(run('Write', { file_path: at('garden', 'a.md') })).toMatchObject({ verdict: 'deny' });
    expect(run('NotebookEdit', { notebook_path: at('garden', 'a.ipynb') })).toMatchObject({ verdict: 'deny' });
    held = undefined;
    expect(run('Write', { file_path: at('garden', 'a.md') })).toEqual({ verdict: 'pass' });
  });

  it('leaves alone other sessions, other commands, relative paths and what the guard refuses', () => {
    held = 'Other idea';
    refuse = true;
    expect(run('Write', { file_path: at('garden', 'a.md') }, 'someone-else')).toEqual({ verdict: 'pass' });
    expect(run('Bash', cli('paths --json'))).toEqual({ verdict: 'pass' });
    expect(run('Bash', cli('paths check "garden" --json'))).toEqual({ verdict: 'pass' });
    expect(run('Bash', { command: 'rm -rf /' })).toEqual({ verdict: 'pass' });
    expect(run('Read', { file_path: at('garden', 'a.md') })).toEqual({ verdict: 'pass' });
    expect(claimed).toEqual([]);
  });
});

describe('two creations and one folder (manager over the fake runner)', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let manager: CreationManager | undefined;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('folder-claims'));
  });
  afterEach(async () => {
    await manager?.shutdown();
    manager = undefined;
    await cleanup();
  });

  const waitFor = async <T>(probe: () => T | undefined, timeoutMs = 5000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = probe();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  it('the second is refused before it writes, goes on at its label, and the folder is free once the first ends', async () => {
    const sessionsDir = path.join(dir, 'sessions');
    const recording = [
      '{"do":"session","phase":"started"}',
      '{"do":"claim","dir":"garden","onRefused":"refused"}',
      // The first holds the folder until the test answers, not for a fixed time a slow machine can outlast.
      '{"do":"question","questions":[{"question":"Go on?","header":"","options":[{"label":"Yes","description":""}],"multiSelect":false}]}',
      '{"do":"session","phase":"finished","outcome":"completed"}',
      '{"do":"label","name":"refused"}',
      '{"do":"claim","dir":"garden-2"}',
      '{"do":"session","phase":"finished","outcome":"completed"}',
    ].join('\n');
    manager = new CreationManager({
      runner: new FakeRunner({ steps: parseRecording(recording), projectsDir: path.join(dir, 'projects') }),
      sessionsDir,
      policy: () => 'ask',
      profile: () => ({ name: 'balanced', sessionModel: 'sonnet' }),
      pollMs: 10,
      tailMs: 20,
    });
    const m = manager;
    const first = await m.create('A garden planner');
    const question = await waitFor(() => m.get(first.id).pending);
    const second = await m.create('A second garden');
    const done = await waitFor(() => (m.get(second.id).status === 'finished' ? m.get(second.id) : undefined));
    const lines = (await readEvents(sessionEventsFile(sessionsDir, done.sessionId ?? ''))).events;
    const denial = lines.find((event) => event.type === 'tool.denied');
    expect(denial).toMatchObject({ source: 'runner', by: 'guard', tool: 'Bash', reason: expect.stringContaining('"A garden planner"') });
    // The folder is named against the projects folder, never with its absolute path.
    expect(denial).toMatchObject({ reason: expect.stringContaining('the folder "garden" in the projects folder') });
    expect(JSON.stringify(denial)).not.toContain('[outside allowed folders]');
    // The stream the page reads says the same.
    const streamed: string[] = [];
    m.subscribe(second.id, 0, (event) => {
      if (event.kind === 'denied') streamed.push(event.data.reason ?? '');
    });
    expect(streamed).toEqual([expect.stringContaining('the folder "garden" in the projects folder')]);
    expect(streamed.join()).not.toMatch(/[A-Za-z]:[\\/]|\/tmp\/|\/home\//);
    // The reason names the folder only relative to nothing: no absolute path is kept in the file.
    expect(JSON.stringify(denial)).not.toContain(slash(dir));
    expect(m.get(first.id).status).not.toBe('finished');

    m.answer(first.id, question.id, { 'Go on?': 'Yes' });
    await waitFor(() => (m.get(first.id).status === 'finished' ? true : undefined));
    const third = await m.create('A third garden');
    // It takes "garden" and holds it at the same question.
    m.answer(third.id, (await waitFor(() => m.get(third.id).pending)).id, { 'Go on?': 'Yes' });
    await waitFor(() => (m.get(third.id).status === 'finished' ? true : undefined));
    const thirdLines = (await readEvents(sessionEventsFile(sessionsDir, m.get(third.id).sessionId ?? ''))).events;
    // The first creation finished, so "garden" was free again: no refusal for the third.
    expect(thirdLines.some((event) => event.type === 'tool.denied')).toBe(false);
  });

  it('a creation here is refused the folder of a terminal creation in progress, and gets it once that one finished', async () => {
    const sessionsDir = path.join(dir, 'sessions');
    const projectsDir = path.join(dir, 'projects');
    // A creation started from the terminal: its events and the folder its `paths check --session` recorded.
    await appendEvent(sessionsDir, sessionLifecycleEvent(TERMINAL, 'started'));
    await appendEvent(sessionsDir, flowEvent(TERMINAL, 'interview', 'started'));
    await recordSessionFolder(sessionsDir, TERMINAL, path.join(projectsDir, 'garden'));
    const recording = [
      '{"do":"session","phase":"started"}',
      '{"do":"claim","dir":"garden","onRefused":"refused"}',
      '{"do":"session","phase":"finished","outcome":"completed"}',
      '{"do":"label","name":"refused"}',
      '{"do":"claim","dir":"garden-2"}',
      '{"do":"session","phase":"finished","outcome":"completed"}',
    ].join('\n');
    // The clock moves past the one-second reuse of a read between the two creations.
    let offset = 0;
    manager = new CreationManager({
      runner: new FakeRunner({ steps: parseRecording(recording), projectsDir }),
      sessionsDir,
      policy: () => 'ask',
      profile: () => ({ name: 'balanced', sessionModel: 'sonnet' }),
      now: () => new Date(Date.now() + offset),
      pollMs: 10,
      tailMs: 20,
    });
    const m = manager;
    const denials = async (id: string) => {
      const state = await waitFor(() => (m.get(id).status === 'finished' ? m.get(id) : undefined));
      return (await readEvents(sessionEventsFile(sessionsDir, state.sessionId ?? ''))).events.filter((event) => event.type === 'tool.denied');
    };

    const first = await m.create('A garden planner');
    expect(await denials(first.id)).toEqual([
      expect.objectContaining({ by: 'guard', reason: expect.stringContaining(`("session ${TERMINAL} started elsewhere")`) }),
    ]);
    // Never an absolute path in the reason.
    expect(JSON.stringify(await denials(first.id))).not.toContain(slash(dir));

    await appendEvent(sessionsDir, sessionLifecycleEvent(TERMINAL, 'finished', 'completed'));
    offset = 2000;
    const second = await m.create('A second garden');
    expect(await denials(second.id)).toEqual([]);
  });

  it('a session it runs itself never blocks its own creation, even with a recorded folder', async () => {
    const sessionsDir = path.join(dir, 'sessions');
    const projectsDir = path.join(dir, 'projects');
    // The flow records its folder too (the skill passes --session in both flows), then claims it.
    const runner = new FakeRunner({
      steps: parseRecording(
        [
          '{"do":"session","phase":"started"}',
          // Held here until the test has recorded the folder.
          '{"do":"question","questions":[{"question":"Go on?","header":"","options":[{"label":"Yes","description":""}],"multiSelect":false}]}',
          '{"do":"claim","dir":"garden"}',
          '{"do":"session","phase":"finished","outcome":"completed"}',
        ].join('\n'),
      ),
      projectsDir,
    });
    manager = new CreationManager({ runner, sessionsDir, policy: () => 'ask', profile: () => ({ name: 'balanced', sessionModel: 'sonnet' }), pollMs: 10, tailMs: 20 });
    const m = manager;
    const created = await m.create('A garden planner');
    const question = await waitFor(() => m.get(created.id).pending);
    const sessionId = m.get(created.id).sessionId;
    if (sessionId === undefined) throw new Error('no session id');
    await recordSessionFolder(sessionsDir, sessionId, path.join(projectsDir, 'garden'));
    m.answer(created.id, question.id, { 'Go on?': 'Yes' });
    const state = await waitFor(() => (m.get(created.id).status === 'finished' ? m.get(created.id) : undefined));
    const lines = (await readEvents(sessionEventsFile(sessionsDir, state.sessionId ?? ''))).events;
    expect(lines.some((event) => event.type === 'tool.denied')).toBe(false);
  });
});
