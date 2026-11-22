import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CodeChoice } from '../../src/creation/code.js';
import { FakeRunner, parseRecording } from '../../src/creation/fakeRunner.js';
import { realImplementSystem } from '../../src/creation/implementSystem.js';
import { CreationManager, type CreationState, type StreamEvent } from '../../src/creation/manager.js';
import { initLibrary } from '../../src/library/index.js';
import { git } from '../../src/library/git.js';
import { specInput, tempDir, useHermeticGit } from '../helpers.js';

useHermeticGit();

// The implement step through the manager (PLAN-phase-10 §1, 3–5), with the fake runner calling the same port the
// real briefstack-web tools call, the real system (git, a fixed shell) and temp folders: the workspace committed
// before any code, a listed command run in the project folder, an unlisted one refused and recorded with nobody
// asked, the code committed apart, the choice fixed once the step started.

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// `node --version` is on every CI machine and prints the same shape everywhere.
const CHOICE: CodeChoice = { commands: ['node --version'], checks: ['node --version'], fixPasses: 1, codex: false };

describe('a creation with code', { timeout: 60_000 }, () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let projectsDir: string;
  let sessionsDir: string;
  let libraryDir: string;
  let manager: CreationManager | undefined;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('creation-implement'));
    projectsDir = path.join(dir, 'projects');
    sessionsDir = path.join(dir, 'sessions');
    libraryDir = path.join(dir, 'library');
    await initLibrary({ libraryDir, projectsDir, sessionsDir, repoDir: path.join(dir, 'repo') });
  });
  afterEach(async () => {
    await manager?.shutdown();
    manager = undefined;
    await cleanup();
  });

  it('commits the workspace, runs only listed commands, refuses the rest with nobody asked, commits the code apart', async () => {
    const spec = specInput({ slug: 'garden', type: 'software', target: 'claude-code' });
    const replies: string[] = [];
    const steps = parseRecording(
      [
        { do: 'session', phase: 'started' },
        { do: 'claim', dir: 'garden' },
        { do: 'spec', onChange: 'x', spec: JSON.stringify(spec) },
        { do: 'label', name: 'x' },
        { do: 'generate', dir: 'garden', git: true },
        { do: 'flow', step: 'implement', phase: 'started' },
        { do: 'implement', action: 'start', dir: 'garden' },
        { do: 'hook', type: 'subagent.start', agentId: 'i1', agentType: 'implementer' },
        { do: 'implement', action: 'write', file: 'src/index.js', text: 'export const garden = 1;\n' },
        { do: 'implement', action: 'run', command: 'node --version' },
        { do: 'implement', action: 'run', command: 'curl https://example.com' },
        { do: 'hook', type: 'subagent.stop', agentId: 'i1', agentType: 'implementer' },
        { do: 'implement', action: 'finish' },
        { do: 'flow', step: 'implement', phase: 'finished', outcome: 'ok' },
        { do: 'session', phase: 'finished', outcome: 'completed' },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
    );
    manager = new CreationManager({
      runner: new FakeRunner({ steps, projectsDir, libraryDir, implementReplies: replies }),
      sessionsDir,
      policy: () => 'ask',
      profile: () => ({ name: 'balanced', sessionModel: 'opus', effort: 'medium' }),
      pollMs: 10,
      tailMs: 20,
      implement: realImplementSystem(),
    });
    const m = manager;
    const events: StreamEvent[] = [];
    const { id } = await m.create('A garden planner');
    m.subscribe(id, 0, (event) => events.push(event), () => undefined);
    const waiting = await waitFor(() => (m.get(id).pending?.kind === 'spec' ? m.get(id) : undefined));
    m.answer(id, waiting.pending?.id ?? '', { decision: 'approve', code: CHOICE });
    const final = await waitFor((): CreationState | undefined => (m.get(id).status === 'finished' ? m.get(id) : undefined));
    expect(final.outcome).toBe('completed');

    const project = path.join(projectsDir, 'garden');
    const log = (await git(project, ['log', '--format=%H %s'])).trim().split('\n');
    expect(log.map((line) => line.slice(41))).toEqual(['Write the first version of the code with briefstack', 'Prepare the project with briefstack']);
    // The code commit holds the code only; the workspace commit holds the workspace.
    expect((await git(project, ['show', '--name-only', '--format=', 'HEAD'])).trim().split('\n')).toEqual(['src/index.js']);
    expect((await git(project, ['ls-tree', '-r', '--name-only', 'HEAD~1'])).split('\n')).toContain('docs/BRIEF.md');
    expect((await git(project, ['status', '--porcelain'])).trim()).toBe('');

    const implement = final.implement;
    expect(implement).toMatchObject({ state: 'done', workspaceCommit: log[1]?.slice(0, 40), codeCommit: log[0]?.slice(0, 40) });
    expect(implement?.runs).toHaveLength(1);
    expect(implement?.runs[0]).toMatchObject({ command: 'node --version', exitCode: 0, timedOut: false });
    expect(implement?.runs[0]?.output).toMatch(/^v\d+\./);
    expect(implement?.refused.map((r) => r.command)).toEqual(['curl https://example.com']);
    // The refusal is a denial of the creation, streamed and in events.jsonl, and nobody was asked.
    expect(events.filter((e) => e.kind === 'denied').map((e) => (e.data as { toolName: string }).toolName)).toEqual(['mcp__briefstack-web__run_command']);
    expect(events.some((e) => e.kind === 'permission')).toBe(false);
    const lines = (await readFile(path.join(sessionsDir, final.sessionId ?? '', 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.some((line) => line.type === 'tool.denied' && line.tool === 'mcp__briefstack-web__run_command')).toBe(true);
    expect(replies.find((text) => text.startsWith('Denied'))).toContain('Nobody was asked');
  });

  it('with "workspace only", implement_start refuses, and nothing is committed by the step', async () => {
    const spec = specInput({ slug: 'plain', type: 'software', target: 'claude-code' });
    const replies: string[] = [];
    const steps = parseRecording(
      [
        { do: 'session', phase: 'started' },
        { do: 'claim', dir: 'plain' },
        { do: 'spec', onChange: 'x', spec: JSON.stringify(spec) },
        { do: 'label', name: 'x' },
        { do: 'generate', dir: 'plain', git: true },
        { do: 'implement', action: 'start', dir: 'plain' },
        { do: 'implement', action: 'run', command: 'node --version' },
        { do: 'session', phase: 'finished', outcome: 'completed' },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
    );
    manager = new CreationManager({
      runner: new FakeRunner({ steps, projectsDir, libraryDir, implementReplies: replies }),
      sessionsDir,
      policy: () => 'ask',
      profile: () => ({ name: 'balanced', sessionModel: 'opus', effort: 'medium' }),
      pollMs: 10,
      tailMs: 20,
      implement: realImplementSystem(),
    });
    const m = manager;
    const { id } = await m.create('Plain');
    const waiting = await waitFor(() => (m.get(id).pending?.kind === 'spec' ? m.get(id) : undefined));
    m.answer(id, waiting.pending?.id ?? '', { decision: 'approve' });
    const final = await waitFor((): CreationState | undefined => (m.get(id).status === 'finished' ? m.get(id) : undefined));
    expect(final.implement).toMatchObject({ state: 'notStarted', reason: 'notChosen', runs: [] });
    expect(replies[1]).toContain('workspace only');
    expect(replies[3]).toContain('not running');
    await expect(git(path.join(projectsDir, 'plain'), ['rev-parse', 'HEAD'])).rejects.toThrow();
  });

  it('refuses a start in another folder than the creation claimed', async () => {
    const spec = specInput({ slug: 'garden', type: 'software', target: 'claude-code' });
    const replies: string[] = [];
    const steps = parseRecording(
      [
        { do: 'session', phase: 'started' },
        { do: 'claim', dir: 'garden' },
        { do: 'spec', onChange: 'x', spec: JSON.stringify(spec) },
        { do: 'label', name: 'x' },
        { do: 'generate', dir: 'other', git: true },
        { do: 'implement', action: 'start', dir: 'other' },
        { do: 'session', phase: 'finished', outcome: 'completed' },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
    );
    manager = new CreationManager({
      runner: new FakeRunner({ steps, projectsDir, libraryDir, implementReplies: replies }),
      sessionsDir,
      policy: () => 'ask',
      profile: () => ({ name: 'balanced', sessionModel: 'opus', effort: 'medium' }),
      pollMs: 10,
      tailMs: 20,
      implement: realImplementSystem(),
    });
    const m = manager;
    const { id } = await m.create('Garden');
    const waiting = await waitFor(() => (m.get(id).pending?.kind === 'spec' ? m.get(id) : undefined));
    m.answer(id, waiting.pending?.id ?? '', { decision: 'approve', code: CHOICE });
    const final = await waitFor((): CreationState | undefined => (m.get(id).status === 'finished' ? m.get(id) : undefined));
    expect(final.implement).toMatchObject({ state: 'notStarted', reason: 'wrongFolder' });
  });
});
