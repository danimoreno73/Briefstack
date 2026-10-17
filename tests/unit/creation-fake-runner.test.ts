import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRunner, loadRecording, parseRecording } from '../../src/creation/fakeRunner.js';
import type {
  ClaimResult,
  PermissionDecision,
  QuestionRequest,
  QuestionResult,
  RunnerEvent,
  RunnerIO,
  SpecApprovalRequest,
  SpecDecision,
} from '../../src/creation/types.js';
import { readEvents, sessionEventsFile, summarizeSession, type SessionEvent } from '../../src/events/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { tempDir } from '../helpers.js';

const RECORDINGS = path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'recordings');
const SESSION = 'fake-session-1';

/** An io that answers from queues and logs what it was asked. */
function scriptedIO(
  script: {
    questions?: QuestionResult[];
    permissions?: PermissionDecision[];
    specs?: SpecDecision[];
    grants?: boolean[];
    claims?: ClaimResult[];
  } = {},
) {
  const asked: string[] = [];
  const emitted: RunnerEvent[] = [];
  const specs: SpecApprovalRequest[] = [];
  const io: RunnerIO = {
    askQuestions: async (request: QuestionRequest) => {
      asked.push(`question:${request.questions.length}`);
      const answers = Object.fromEntries(request.questions.map((q) => [q.question, q.options[0]?.label ?? '']));
      return script.questions?.shift() ?? { decision: 'answer', answers };
    },
    requestPermission: async (request) => {
      asked.push(`permission:${request.toolName}:${request.agentType ?? ''}`);
      return script.permissions?.shift() ?? 'allow';
    },
    approveSpec: async (request) => {
      asked.push('spec');
      specs.push(request);
      return script.specs?.shift() ?? { decision: 'approve' };
    },
    grantDirectory: async () => {
      asked.push('grant');
      return script.grants?.shift() ?? true;
    },
    claimFolder: (dir) => (asked.push(`claim:${dir}`), script.claims?.shift() ?? { ok: true }),
    folderHeldByOther: () => undefined,
    emit: (event) => emitted.push(event),
  };
  return { io, asked, emitted, specs };
}

const steps = (events: readonly SessionEvent[]) =>
  events.map((e) => ('step' in e ? `${e.step}:${e.type.slice(5)}${e.outcome ? `:${e.outcome}` : ''}` : e.type));

describe('FakeRunner', () => {
  let sessionsDir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    const temp = await tempDir('fake-runner');
    sessionsDir = path.join(temp.dir, 'sessions');
    cleanup = temp.cleanup;
  });
  afterEach(() => cleanup());

  const start = async (recording: string, io: RunnerIO, extra: { ignoreCancel?: boolean } = {}) => {
    const runner = await FakeRunner.fromFile(path.join(RECORDINGS, recording), { sessionId: () => SESSION, ...extra });
    return runner.start({ creationId: 'c1', idea: 'x', profile: { name: 'balanced', sessionModel: 'sonnet' }, sessionsDir, policy: 'ask', io });
  };
  const events = async () => (await readEvents(sessionEventsFile(sessionsDir, SESSION))).events;

  it('replays the full recording into events.jsonl as the skill and hooks would', async () => {
    const { io, asked, emitted, specs } = scriptedIO();
    const handle = await start('full.jsonl', io);
    expect(await handle.sessionId).toBe(SESSION);
    expect(await handle.done).toEqual({ kind: 'ended' });
    expect(asked).toEqual(['question:2', 'question:1', 'spec', 'permission:Bash:generator']);
    expect(emitted).toEqual([{ kind: 'status', status: 'running' }]);
    const all = await events();
    expect(all.every((e) => e.session === SESSION)).toBe(true);
    expect(steps(all).filter((s) => !s.startsWith('subagent') && !s.startsWith('tool'))).toEqual([
      'session.started',
      'idea:started',
      'idea:finished:ok',
      'gap-analysis:started',
      'gap-analysis:finished:ok',
      'interview:started',
      'interview:finished:ok',
      'research:started',
      'research:finished:skipped',
      'spec:started',
      'spec:finished:ok',
      'generate:started',
      'generate:finished:ok',
      'validate-review:started',
      'validate-review:finished:ok',
      'learn:started',
      'learn:finished:ok',
      'handoff:started',
      'handoff:finished:ok',
      'session.finished',
    ]);
    expect(all.find((e) => e.type === 'subagent.start')).toMatchObject({ agentType: 'interviewer', agentId: 'a1' });
    expect(summarizeSession(all)).toMatchObject({ status: 'finished', outcome: 'completed' });
    // The spec files are in the session folder.
    expect(specs[0]?.summaryFile).toBe(path.join(sessionsDir, SESSION, 'spec-summary.md'));
    expect(await readFile(specs[0]?.summaryFile ?? '', 'utf8')).toContain('# Garden planner');
  });

  it('ends a turn with a message, waits for the free-text reply, keeps it and goes on', async () => {
    const { io, emitted } = scriptedIO();
    const received: string[] = [];
    const runner = new FakeRunner({
      steps: parseRecording(['{"do":"session","phase":"started"}', '{"do":"turnEnd","message":"Which name?"}', '{"do":"session","phase":"finished"}'].join('\n')),
      sessionId: () => SESSION,
      received,
    });
    const handle = runner.start({ creationId: 'c1', idea: 'x', profile: { name: 'balanced', sessionModel: 'sonnet' }, sessionsDir, policy: 'ask', io });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(emitted.at(-1)).toEqual({ kind: 'status', status: 'turnEnded', message: 'Which name?' });
    handle.sendMessage('Seedling');
    expect(await handle.done).toEqual({ kind: 'ended' });
    expect(received).toEqual(['Seedling']);
    expect(emitted.at(-1)).toEqual({ kind: 'status', status: 'running' });
  });

  it('claims folders and writes library notes as the flow would', async () => {
    const { io, asked, emitted } = scriptedIO({ claims: [{ ok: false, holder: 'Other idea' }] });
    const projectsDir = path.join(sessionsDir, '..', 'projects');
    const runner = new FakeRunner({
      steps: parseRecording(
        [
          '{"do":"session","phase":"started"}',
          '{"do":"claim","dir":"garden","onRefused":"taken"}',
          '{"do":"session","phase":"finished"}',
          '{"do":"label","name":"taken"}',
          '{"do":"claim","dir":"garden-2"}',
          '{"do":"session","phase":"finished"}',
        ].join('\n'),
      ),
      sessionId: () => SESSION,
      projectsDir,
    });
    const handle = runner.start({ creationId: 'c1', idea: 'x', profile: { name: 'balanced', sessionModel: 'sonnet' }, sessionsDir, policy: 'ask', io });
    expect(await handle.done).toEqual({ kind: 'ended' });
    expect(asked).toEqual([`claim:${path.join(projectsDir, 'garden')}`, `claim:${path.join(projectsDir, 'garden-2')}`]);
    expect(emitted).toContainEqual(expect.objectContaining({ kind: 'denial', toolName: 'Bash', reason: expect.stringContaining('"Other idea"') }));
  });

  it('refuses a recording whose library step has no library', async () => {
    const { io } = scriptedIO();
    const runner = new FakeRunner({ steps: parseRecording('{"do":"library","section":"lessons","text":"x"}'), sessionId: () => SESSION });
    const handle = runner.start({ creationId: 'c1', idea: 'x', profile: { name: 'balanced', sessionModel: 'sonnet' }, sessionsDir, policy: 'ask', io });
    expect(await handle.done).toMatchObject({ kind: 'failed', error: expect.stringContaining('libraryDir') });
  });

  it('goes back to the architect on a change at the spec', async () => {
    const { io, asked } = scriptedIO({ specs: [{ decision: 'change', text: 'Add a sequel' }, { decision: 'approve' }] });
    const handle = await start('change-at-spec.jsonl', io);
    expect(await handle.done).toEqual({ kind: 'ended' });
    expect(asked).toEqual(['question:1', 'spec', 'spec']);
    const architects = (await events()).filter((e) => e.type === 'subagent.start');
    expect(architects).toHaveLength(2);
  });

  it('closes the open step as skipped and the session as cancelled when a question is cancelled', async () => {
    const { io } = scriptedIO({ questions: [{ decision: 'cancel' }] });
    const handle = await start('full.jsonl', io);
    await handle.done;
    const all = steps(await events());
    expect(all.slice(-2)).toEqual(['interview:finished:skipped', 'session.finished']);
    expect(summarizeSession(await events())).toMatchObject({ status: 'finished', outcome: 'cancelled' });
  });

  it('closes as cancelled when the spec is cancelled', async () => {
    const { io } = scriptedIO({ specs: [{ decision: 'cancel' }] });
    const handle = await start('full.jsonl', io);
    await handle.done;
    expect(steps(await events()).slice(-2)).toEqual(['spec:finished:skipped', 'session.finished']);
  });

  it('honours requestCancel at the next line', async () => {
    const holder: { handle?: Awaited<ReturnType<typeof start>> } = {};
    const { io } = scriptedIO();
    const cancelling: RunnerIO = {
      ...io,
      askQuestions: async (request) => {
        holder.handle?.requestCancel();
        return io.askQuestions(request);
      },
    };
    holder.handle = await start('full.jsonl', cancelling);
    await holder.handle.done;
    const all = await events();
    expect(steps(all).slice(-2)).toEqual(['interview:finished:skipped', 'session.finished']);
    expect(summarizeSession(all).outcome).toBe('cancelled');
  });

  it('cuts a wait short on cancel, and on stop without writing anything', async () => {
    const recording = [
      '{"do":"session","phase":"started"}',
      '{"do":"flow","step":"idea","phase":"started"}',
      '{"do":"wait","ms":60000}',
      '{"do":"session","phase":"finished","outcome":"completed"}',
    ].join('\n');
    const run = (ignoreCancel: boolean) =>
      new FakeRunner({ steps: parseRecording(recording), sessionId: () => SESSION, ignoreCancel }).start({
        creationId: 'c',
        idea: 'x',
        profile: { name: 'saver', sessionModel: 'sonnet' },
        sessionsDir,
        policy: 'ask',
        io: scriptedIO().io,
      });

    // The wait has started once `idea started` is on disk.
    const inWait = async () => {
      while ((await events()).length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    };

    const cancelled = run(false);
    await inWait();
    cancelled.requestCancel();
    expect(await cancelled.done).toEqual({ kind: 'ended' });
    expect(steps(await events()).slice(-2)).toEqual(['idea:finished:skipped', 'session.finished']);

    await cleanup();
    const stubborn = run(true);
    await inWait();
    stubborn.requestCancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stubborn.stop();
    expect(await stubborn.done).toEqual({ kind: 'stopped' });
    expect(steps(await events())).toEqual(['session.started', 'idea:started']);
  });

  it('stops while waiting for the user', async () => {
    const { io } = scriptedIO();
    let asked: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => (asked = resolve));
    const handle = await start('full.jsonl', {
      ...io,
      askQuestions: () => {
        asked();
        return new Promise<QuestionResult>(() => undefined);
      },
    });
    await waiting;
    await handle.stop();
    expect(await handle.done).toEqual({ kind: 'stopped' });
    expect(steps(await events()).at(-1)).toBe('interview:started');
  });

  it('follows onDeny and resolves a relative grant folder against the session folder', async () => {
    const recording = parseRecording(
      [
        '{"do":"grant","dir":"out","onDeny":"denied"}',
        '{"do":"permission","toolName":"Write","summary":"x","onDeny":"denied"}',
        '{"do":"exit"}',
        '{"do":"label","name":"denied"}',
        '{"do":"session","phase":"finished","outcome":"failed"}',
      ].join('\n'),
    );
    const dirs: string[] = [];
    const { io } = scriptedIO({ permissions: ['deny'] });
    const handle = new FakeRunner({ steps: recording, sessionId: () => SESSION }).start({
      creationId: 'c',
      idea: 'x',
      profile: { name: 'max', sessionModel: 'sonnet' },
      sessionsDir,
      policy: 'ask',
      io: { ...io, grantDirectory: async ({ dir }) => (dirs.push(dir), true) },
    });
    await handle.done;
    expect(dirs).toEqual([path.join(sessionsDir, SESSION, 'out')]);
    expect(steps(await events())).toEqual(['session.finished']);
  });

  it('refuses bad recordings with the line number', async () => {
    expect(() => parseRecording('{"do":"flow","step":"nope","phase":"started"}')).toThrow(/line 1/);
    expect(() => parseRecording('# comment\n\n{not json')).toThrow(/line 3/);
    expect(() => parseRecording('{"do":"goto","label":"missing"}')).toThrow(/unknown label "missing"/);
    expect(() => parseRecording('{"do":"question","questions":[]}')).toThrow(/line 1/);
    expect((await loadRecording(path.join(RECORDINGS, 'full.jsonl'))).length).toBeGreaterThan(30);
  });
});
