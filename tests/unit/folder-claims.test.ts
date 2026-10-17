import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRunner, parseRecording } from '../../src/creation/fakeRunner.js';
import { FolderClaims, claimRefusedMessage, evaluateFolderClaim, folderLabel, type FolderClaimContext } from '../../src/creation/folderClaims.js';
import { CreationManager } from '../../src/creation/manager.js';
import { readEvents, sessionEventsFile } from '../../src/events/index.js';
import { tempDir } from '../helpers.js';

const root = path.resolve('/work/projects');
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
      '{"do":"wait","ms":300}',
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
    await new Promise((resolve) => setTimeout(resolve, 50));
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

    await waitFor(() => (m.get(first.id).status === 'finished' ? true : undefined));
    const third = await m.create('A third garden');
    await waitFor(() => (m.get(third.id).status === 'finished' ? true : undefined));
    const thirdLines = (await readEvents(sessionEventsFile(sessionsDir, m.get(third.id).sessionId ?? ''))).events;
    // The first creation finished, so "garden" was free again: no refusal for the third.
    expect(thirdLines.some((event) => event.type === 'tool.denied')).toBe(false);
  });
});
