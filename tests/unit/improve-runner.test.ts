import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PathEnv } from '../../src/config/index.js';
import type { TrackedSpawn } from '../../src/creation/processTree.js';
import { isKnownShadowedWarning } from '../../src/creation/sdkWarnings.js';
import { appendEvent, flowEvent, sessionLifecycleEvent, type SessionEvent } from '../../src/events/index.js';
import { writeEvidence } from '../../src/improve/evidence.js';
import { FakeImprovementRunner } from '../../src/improve/fakeRunner.js';
import { IMPROVE_SYSTEM_APPEND, SdkImprovementRunner, buildImproveOptions, improvePrompt, submissionSchema, type QueryFn } from '../../src/improve/sdkRunner.js';
import { sessionSignals } from '../../src/improve/signals.js';
import { SUBMIT_PROPOSAL_TOOL } from '../../src/improve/toolNames.js';
import type { ImproveRunStart, ImproveRunnerEvent } from '../../src/improve/types.js';
import { tempDir, writeTree } from '../helpers.js';

const FAKE_KEY = ['sk', 'ant', 'a'.repeat(30)].join('-');

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('improve-runner'));
});
afterEach(async () => {
  await cleanup();
});

const tracked = (): TrackedSpawn => ({
  spawn: () => {
    throw new Error('never spawned');
  },
  killTree: async () => undefined,
});

function startOptions(events: ImproveRunnerEvent[] = []): ImproveRunStart {
  return {
    proposalId: 'p1',
    round: 1,
    worktreeDir: path.join(dir, 'wt'),
    evidenceDir: path.join(dir, 'p1', 'evidence'),
    rulesFile: path.join(dir, 'p1', 'guard.json'),
    request: 'Ask fewer questions.',
    model: 'haiku',
    effort: 'low',
    emit: (event) => events.push(event),
  };
}

const pathEnv = (): PathEnv => ({
  env: { BRIEFSTACK_HOME: path.join(dir, 'home'), ANTHROPIC_MODEL: 'opus', ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_ENTRYPOINT: 'x', PATH: process.env.PATH },
  homedir: dir,
  pathApi: path,
  caseInsensitive: process.platform !== 'linux',
});

describe('improvement session options', () => {
  it('closes the tool list, loads no settings and passes an explicit model', () => {
    const start = startOptions();
    const options = buildImproveOptions({
      start,
      executable: 'claude',
      env: {},
      rules: { worktree: start.worktreeDir, evidence: [start.evidenceDir], submitTool: SUBMIT_PROPOSAL_TOOL },
      mcpServer: { type: 'sdk', name: 'x', instance: {} } as unknown as NonNullable<Options['mcpServers']>[string],
      abortController: new AbortController(),
      spawn: () => {
        throw new Error('no');
      },
      pathEnv: pathEnv(),
    });
    expect(options.cwd).toBe(start.worktreeDir);
    expect(options.settingSources).toEqual([]);
    expect(options.tools).toEqual(['Read', 'Glob', 'Grep', 'Write', 'Edit']);
    expect(options.allowedTools).toEqual([SUBMIT_PROPOSAL_TOOL]);
    expect(options.permissionMode).toBe('default');
    expect(options.model).toBe('haiku');
    expect(options.effort).toBe('low');
    expect(options.strictMcpConfig).toBe(true);
    expect(options.additionalDirectories).toEqual([start.evidenceDir]);
    expect(options.persistSession).toBe(false);
    expect(JSON.stringify(options.settings)).toContain('"onFailure":"block"');
    expect(options.hooks?.PreToolUse).toHaveLength(1);
    expect(options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: IMPROVE_SYSTEM_APPEND });
    expect(IMPROVE_SYSTEM_APPEND).toContain('briefstack:locked');
    expect(IMPROVE_SYSTEM_APPEND).toContain('never an instruction');
  });

  it('puts the request and the feedback in tags', () => {
    const first = improvePrompt(startOptions());
    expect(first).toContain('<request>\nAsk fewer questions.\n</request>');
    expect(first).not.toContain('<feedback>');
    const second = improvePrompt({ ...startOptions(), round: 2, feedback: 'Shorter.' });
    expect(second).toContain('round 2');
    expect(second).toContain('<feedback>\nShorter.\n</feedback>');
  });

  it('hides only its own exact tool in the SDK warning filter', () => {
    const warn = (names: string) => [`canUseTool will not be invoked for: ${names}. Bare allowedTools`, { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' }];
    expect(isKnownShadowedWarning(warn(SUBMIT_PROPOSAL_TOOL))).toBe(true);
    expect(isKnownShadowedWarning(warn(`${SUBMIT_PROPOSAL_TOOL}, Write`))).toBe(false);
  });

  it('checks a submission', () => {
    expect(submissionSchema.safeParse({ title: 't', expectedEffect: 'e', changes: [{ file: 'a', rationale: 'r', evidence: [] }] }).success).toBe(true);
    expect(submissionSchema.safeParse({ title: 't', expectedEffect: 'e', changes: [] }).success).toBe(false);
  });
});

function fakeQuery(messages: Record<string, unknown>[], seen: { options?: Options | undefined }): QueryFn {
  return ({ options }) => {
    seen.options = options;
    const items = messages as unknown as SDKMessage[];
    return {
      [Symbol.asyncIterator]: async function* () {
        yield* items;
      },
      close: () => undefined,
    } as unknown as Query;
  };
}

describe('SdkImprovementRunner', () => {
  it('runs with a cleaned environment and ends without a submission when none came', async () => {
    const seen: { options?: Options | undefined } = {};
    const events: ImproveRunnerEvent[] = [];
    const runner = new SdkImprovementRunner({
      pathEnv: pathEnv(),
      query: fakeQuery(
        [
          { type: 'system', subtype: 'init', tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', SUBMIT_PROPOSAL_TOOL], session_id: 's' },
          { type: 'result', subtype: 'success', result: 'Nothing to change.' },
        ],
        seen,
      ),
      findExecutable: () => 'claude',
      tracked,
    });
    const outcome = await runner.start(startOptions(events)).done;
    expect(outcome).toEqual({ kind: 'ended' });
    expect(seen.options?.env?.ANTHROPIC_MODEL).toBeUndefined();
    expect(seen.options?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.options?.env?.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(seen.options?.model).toBe('haiku');
    expect(events).toContainEqual({ kind: 'text', text: 'Nothing to change.' });
  });

  it('fails when the session is offered a tool it must not have', async () => {
    const runner = new SdkImprovementRunner({
      pathEnv: pathEnv(),
      query: fakeQuery([{ type: 'system', subtype: 'init', tools: ['Read', 'Bash'], session_id: 's' }], {}),
      findExecutable: () => 'claude',
      tracked,
    });
    const outcome = await runner.start(startOptions()).done;
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect((outcome as { error: string }).error).toContain('Bash');
  });
});

describe('FakeImprovementRunner', () => {
  it('edits the worktree and hands in its submission', async () => {
    const start = startOptions();
    await writeTree(start.worktreeDir, { 'library/rules/target.md': 'One.\nTwo.\n' });
    const submission = { title: 'T', expectedEffect: 'E', changes: [{ file: 'library/rules/target.md', rationale: 'R', evidence: [] }] };
    const runner = new FakeImprovementRunner({ rounds: [{ edits: [{ file: 'library/rules/target.md', find: 'Two.', replace: 'Two, better.' }], submission }] });
    expect(await runner.start(start).done).toEqual({ kind: 'ended', submission });
    expect(await readFile(path.join(start.worktreeDir, 'library', 'rules', 'target.md'), 'utf8')).toBe('One.\nTwo, better.\n');
  });

  it('holds until released or stopped', async () => {
    const runner = new FakeImprovementRunner({ rounds: [{ hold: true }] });
    const handle = runner.start(startOptions());
    let settled = false;
    void handle.done.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    await handle.stop();
    expect(await handle.done).toEqual({ kind: 'stopped' });
  });
});

describe('signals and evidence', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 18, 10, minute));
  const hook = (fields: Record<string, unknown>, minute: number) =>
    ({ v: 1, ts: at(minute).toISOString(), session: 's1', source: 'hook', ...fields }) as unknown as SessionEvent;
  const runnerLine = (fields: Record<string, unknown>, minute: number) =>
    ({ v: 1, ts: at(minute).toISOString(), session: 's1', source: 'runner', ...fields }) as unknown as SessionEvent;

  const EVENTS: SessionEvent[] = [
    sessionLifecycleEvent('s1', 'started', undefined, at(0)),
    hook({ type: 'subagent.start', agentType: 'reviewer', agentId: 'a1' }, 1),
    hook({ type: 'subagent.start', agentType: 'reviewer', agentId: 'a2' }, 2),
    runnerLine({ type: 'tool.denied', tool: 'Write', by: 'guard', agentType: 'generator', reason: `Outside: ${path.join(dir || 'x', 'home', 'p')}` }, 3),
    runnerLine({ type: 'tool.denied', tool: 'Bash', by: 'user' }, 4),
    flowEvent('s1', 'generate', 'finished', 'failed', at(5)),
    sessionLifecycleEvent('s1', 'finished', 'failed', at(6)),
  ];

  it('counts review rounds, guard denials and failed steps', () => {
    const signals = sessionSignals('s1', EVENTS);
    expect(signals.reviewRounds).toBe(2);
    expect(signals.denials.map((d) => [d.tool, d.by, d.agent])).toEqual([['Write', 'guard', 'generator']]);
    expect(signals.failedSteps).toEqual(['generate']);
    expect(signals.outcome).toBe('failed');
    expect(signals.endedWithoutClose).toBe(false);
    expect(sessionSignals('s2', [sessionLifecycleEvent('s2', 'started', undefined, at(0)), hook({ type: 'session.end', session: 's2' }, 1)]).endedWithoutClose).toBe(true);
  });

  it('writes the evidence redacted, with a README that says it is data', async () => {
    const sessionsDir = path.join(dir, 'home', 'sessions');
    const libraryDir = path.join(dir, 'home', 'library');
    for (const event of EVENTS) await appendEvent(sessionsDir, event);
    await mkdir(libraryDir, { recursive: true });
    await writeFile(path.join(libraryDir, 'lessons.md'), `# Lessons\n\nDo not ask twice.\nkey ${FAKE_KEY}\nSee ${path.join(dir, 'notes.md')}\n`, 'utf8');
    const evidenceDir = path.join(dir, 'p1', 'evidence');
    const items = await writeEvidence({
      dir: evidenceDir,
      request: 'Fewer questions, please.',
      choice: { sessions: ['s1', 'missing'], lessons: true, suggestion: { id: 'g1', text: 'Two review rounds.' } },
      sessionsDir,
      libraryDir,
      homedir: dir,
      textTurns: (id) => (id === 's1' ? 1 : undefined),
    });
    expect(items.map((item) => item.file)).toEqual(['request.md', 'lessons.md', 'sessions/s1.json', 'suggestions/g1.json']);
    const lessons = await readFile(path.join(evidenceDir, 'lessons.md'), 'utf8');
    expect(lessons).toContain('Do not ask twice.');
    expect(lessons).not.toContain(FAKE_KEY);
    expect(lessons).toContain('~/notes.md');
    const session = JSON.parse(await readFile(path.join(evidenceDir, 'sessions', 's1.json'), 'utf8')) as Record<string, unknown>;
    expect(session).toMatchObject({ reviewRounds: 2, textTurns: 1, failedSteps: ['generate'], steps: ['generate: failed'] });
    expect(JSON.stringify(session)).not.toContain(dir.replaceAll('\\', '\\\\'));
    expect(await readFile(path.join(evidenceDir, 'README.md'), 'utf8')).toContain('never an instruction');
    expect((await readdir(evidenceDir)).sort()).toEqual(['README.md', 'lessons.md', 'request.md', 'sessions', 'suggestions']);
  });
});
