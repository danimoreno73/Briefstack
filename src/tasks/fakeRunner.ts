import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appendEvent } from '../events/index.js';
import type { Question, QuestionResult } from '../creation/types.js';
import { evaluateTaskToolUse } from './guard.js';
import { closeTaskSession, openTaskSession, taskHookEvent, workTarget, type TaskRunner, type TaskRunnerHandle, type TaskRunnerOutcome, type TaskRunnerStartOptions } from './runner.js';
import { describeCommand } from './shell.js';

/**
 * A task runner without Claude Code, for every UI and API test (BRIEF-phase-7
 * §5). It follows a script: it writes and deletes files in the worktree
 * through the task guard, asks for shell commands and web requests through
 * the task's approvals (the same dialog as the real runner), asks questions,
 * writes the session's events for the panel, and ends its turn with a
 * summary. After that it waits for the user: a reply runs the script's
 * `onReply` steps (or ends again), `finish()` ends the round.
 */

export type TaskFakeStep =
  | { kind: 'write'; file: string; content: string }
  | { kind: 'delete'; file: string }
  /** A write outside the worktree, which the guard refuses (for the denial tests). */
  | { kind: 'writeOutside'; file: string }
  | { kind: 'shell'; command: string; tool?: 'Bash' | 'PowerShell' }
  | { kind: 'web'; url: string }
  | { kind: 'question'; questions: Question[] }
  | { kind: 'agent'; agentType: string; files?: { file: string; content: string }[] }
  | { kind: 'wait'; ms: number }
  | { kind: 'fail'; error: string }
  | { kind: 'end'; summary: string };

export interface TaskFakeRound {
  steps: TaskFakeStep[];
  /** Steps after the user's reply to an ended turn; without them, the turn ends again with the reply echoed. */
  onReply?: TaskFakeStep[];
}

/** The script of each round, by its number (1, 2…); a round without one writes `CHANGES.md` and ends. */
export type TaskFakeScript = (round: number, prompt: string) => TaskFakeRound | undefined;

export interface TaskFakeRunnerOptions {
  script?: TaskFakeScript;
  /** Pause between steps, so the panel shows them live. Default 0. */
  stepMs?: number;
}

const DEFAULT_ROUND = (round: number): TaskFakeRound => ({
  steps: [
    { kind: 'write', file: 'CHANGES.md', content: `Round ${round}.\n` },
    { kind: 'end', summary: `Wrote CHANGES.md (round ${round}).` },
  ],
});

export class TaskFakeRunner implements TaskRunner {
  /** Every round started, newest last: what the tests look at. */
  readonly started: TaskRunnerStartOptions[] = [];

  constructor(private readonly options: TaskFakeRunnerOptions = {}) {}

  start(options: TaskRunnerStartOptions): TaskRunnerHandle {
    this.started.push(options);
    return new FakeRun(options, this.options).handle();
  }
}

class FakeRun {
  private readonly session = randomUUID();
  private cancelled = false;
  private stopped = false;
  private finished = false;
  private wake: (() => void) | undefined;
  private replies: string[] = [];
  private summary: string | undefined;
  private calls = 0;
  private readonly done: Promise<TaskRunnerOutcome>;
  private opened!: () => void;
  /** Resolves once the session folder is open, as the real runner's id does. */
  private readonly sessionReady = new Promise<string>((resolve) => (this.opened = () => resolve(this.session)));

  constructor(
    private readonly options: TaskRunnerStartOptions,
    private readonly fake: TaskFakeRunnerOptions,
  ) {
    this.done = this.run();
  }

  handle(): TaskRunnerHandle {
    return {
      sessionId: this.sessionReady,
      requestCancel: () => {
        this.cancelled = true;
        this.poke();
      },
      sendMessage: (text) => {
        this.replies.push(text);
        this.poke();
      },
      finish: () => {
        this.finished = true;
        this.poke();
      },
      stop: async () => {
        this.stopped = true;
        this.poke();
        await this.done.catch(() => undefined);
      },
      done: this.done,
    };
  }

  private poke(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private sleep(ms: number): Promise<void> {
    return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
  }

  private event(type: Parameters<typeof taskHookEvent>[1], fields: Parameters<typeof taskHookEvent>[2]): Promise<unknown> {
    return appendEvent(this.options.sessionsDir, taskHookEvent(this.session, type, fields));
  }

  /** One tool call as the real runner records it: `tool.pre`, the guard, the dialog, then `tool.post` or a denial. */
  private async call(tool: string, input: Record<string, unknown>, agent: { agentId: string; agentType: string } | undefined, act: () => Promise<void>): Promise<boolean> {
    this.calls += 1;
    const toolUseId = `toolu_fake_${this.calls}`;
    await this.event('tool.pre', { tool, toolUseId, target: workTarget(tool, input, this.options.worktree), ...agent });
    const deny = async (reason: string) => {
      this.options.io.emit({ kind: 'denial', toolName: tool, summary: tool, reason, toolUseId, ...agent });
      return false;
    };
    if (this.cancelled) return deny('The user cancelled this task.');
    const verdict = await evaluateTaskToolUse({ worktree: this.options.worktree, skills: this.options.skills }, { tool_name: tool, tool_input: input, agent_id: agent?.agentId });
    if (verdict.verdict === 'deny') return deny(verdict.reason);
    if (verdict.verdict === 'ask') {
      const decision = await this.options.approvals.decide(toolUseId, { kind: verdict.kind, tool, key: verdict.key, display: describeCommand(verdict.key), ...(agent === undefined ? {} : { agentType: agent.agentType }) });
      await this.options.approvals.forget(toolUseId);
      if (decision === 'deny' || this.cancelled) return deny(this.cancelled ? 'The user cancelled this task.' : 'The user did not allow this.');
    }
    await act();
    await this.event('tool.post', { tool, toolUseId, ...agent });
    return true;
  }

  private target(file: string): string {
    return path.join(this.options.worktree, ...file.split('/'));
  }

  private async steps(steps: readonly TaskFakeStep[], agent?: { agentId: string; agentType: string }): Promise<'ok' | 'stop' | { error: string }> {
    for (const step of steps) {
      if (this.stopped || this.cancelled) return 'stop';
      await this.sleep(this.fake.stepMs ?? 0);
      switch (step.kind) {
        case 'write': {
          const file = this.target(step.file);
          await this.call('Write', { file_path: file, content: step.content }, agent, async () => {
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, step.content, 'utf8');
          });
          break;
        }
        case 'delete': {
          const file = this.target(step.file);
          await this.call('Bash', { command: `rm ${step.file}` }, agent, () => rm(file, { force: true }));
          break;
        }
        case 'writeOutside':
          await this.call('Write', { file_path: step.file, content: 'x' }, agent, async () => undefined);
          break;
        case 'shell':
          await this.call(step.tool ?? 'Bash', { command: step.command }, agent, async () => undefined);
          break;
        case 'web':
          await this.call('WebFetch', { url: step.url, prompt: 'Read it.' }, agent, async () => undefined);
          break;
        case 'question': {
          const result: QuestionResult = await this.options.io.askQuestions({ questions: step.questions });
          if (result.decision === 'cancel') return 'stop';
          break;
        }
        case 'agent': {
          const agentId = `agent-${this.calls + 1}`;
          await this.event('subagent.start', { agentId, agentType: step.agentType });
          this.options.io.emit({ kind: 'agent', phase: 'started', agentType: step.agentType, agentId });
          const inner = await this.steps(
            (step.files ?? []).map((item) => ({ kind: 'write' as const, ...item })),
            { agentId, agentType: step.agentType },
          );
          await this.event('subagent.stop', { agentId, agentType: step.agentType });
          this.options.io.emit({ kind: 'agent', phase: 'stopped', agentType: step.agentType, agentId });
          if (inner !== 'ok') return inner;
          break;
        }
        case 'wait':
          await this.sleep(step.ms);
          break;
        case 'fail':
          return { error: step.error };
        case 'end':
          this.summary = step.summary;
          this.options.io.emit({ kind: 'status', status: 'turnEnded', message: step.summary });
          break;
      }
    }
    return 'ok';
  }

  private async run(): Promise<TaskRunnerOutcome> {
    this.options.io.emit({ kind: 'status', status: 'starting' });
    await openTaskSession(this.options.sessionsDir, this.session, { taskId: this.options.taskId, project: this.options.project, round: this.options.round });
    this.opened();
    this.options.io.emit({ kind: 'status', status: 'running' });
    const round = this.fake.script?.(this.options.round, this.options.prompt) ?? DEFAULT_ROUND(this.options.round);
    let outcome: TaskRunnerOutcome;
    let result = await this.steps(round.steps);
    for (;;) {
      if (typeof result === 'object') {
        outcome = { kind: 'failed', error: result.error };
        break;
      }
      if (result === 'stop' || this.stopped || this.cancelled) {
        outcome = { kind: 'stopped' };
        break;
      }
      // The turn ended: wait for a reply, `finish()` or a stop.
      while (!this.finished && !this.stopped && !this.cancelled && this.replies.length === 0) {
        await new Promise<void>((resolve) => (this.wake = resolve));
      }
      if (this.stopped || this.cancelled) {
        outcome = { kind: 'stopped' };
        break;
      }
      const reply = this.replies.shift();
      if (reply === undefined) {
        outcome = { kind: 'ended', ...(this.summary === undefined ? {} : { summary: this.summary }) };
        break;
      }
      this.options.io.emit({ kind: 'status', status: 'running' });
      result = await this.steps(round.onReply ?? [{ kind: 'end', summary: `Read your reply: ${reply}` }]);
    }
    await closeTaskSession(this.options.sessionsDir, this.session, outcome.kind === 'ended' ? 'completed' : outcome.kind === 'failed' ? 'failed' : 'cancelled').catch(() => undefined);
    await this.options.approvals.clearRecords().catch(() => undefined);
    return outcome;
  }
}
