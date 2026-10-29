import { query as sdkQuery, type CanUseTool, type HookCallback, type Options, type PermissionResult, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { resolveHome, type PathEnv } from '../config/index.js';
import { findClaudeExecutable } from '../creation/claudeBinary.js';
import { killProcessTree, spawnTracked, type TrackedSpawn } from '../creation/processTree.js';
import { cleanEnvironment, InputQueue, type QueryFn } from '../creation/sdkRunner.js';
import { BriefstackError, isBriefstackError } from '../errors.js';
import { appendEvent, type HookEventType } from '../events/index.js';
import { formatError } from '../i18n/errors.js';
import type { Lang } from '../i18n/index.js';
import { redactSecretLines } from '../validate/secrets.js';
import { evaluateTaskToolUse, type TaskGuardRules } from './guard.js';
import { writeTaskRulesSync } from './guardCommand.js';
import { closeTaskSession, openTaskSession, taskHookEvent, workTarget, type TaskRunner, type TaskRunnerHandle, type TaskRunnerOutcome, type TaskRunnerStartOptions } from './runner.js';
import { taskFlagSettings, taskTools, TASK_ENV } from './session.js';
import { describeCommand, TaskApprovals, TASK_HOOK_TIMEOUT_S } from './shell.js';

/**
 * The real task runner (BRIEF-phase-7 §3.2): one round of a task as an
 * Agent SDK session in the task's worktree, with the user's own Claude Code
 * and login. Explicit model and effort from the profile's `work` entry, the
 * same clean environment as a creation plus `TASK_ENV`, the closed tool
 * list, `auto` mode (never `bypassPermissions`), no background tasks, the
 * project's own `CLAUDE.md`, agents and skills from the worktree, and none
 * of its settings (the file is hidden there).
 *
 * Every tool call goes through the task guard in a `PreToolUse` callback
 * (and in the command hook Claude Code runs itself); shell commands and web
 * requests wait there for the user's decision, so no allow rule, mode or
 * classifier can skip the dialog. `canUseTool` gives the guard's answer
 * again and takes the user's answers to `AskUserQuestion`.
 */

const questionSchema = z.object({
  question: z.string().min(1),
  header: z.string().default(''),
  options: z.array(z.object({ label: z.string().min(1), description: z.string().default('') })).min(1),
  multiSelect: z.boolean().default(false),
});
const askInputSchema = z.object({ questions: z.array(questionSchema).min(1).max(4) });

const CANCELLED_MESSAGE = 'The user cancelled this task. Stop now.';
const MAX_SUMMARY = 4000;
const IDLE_AFTER_RESULT_MS = 15 * 60_000;

export interface TaskSdkRunnerDeps {
  pathEnv: PathEnv;
  lang?: Lang;
  /** Tests inject the SDK's `query`. */
  query?: QueryFn;
  /** Tests inject the lookup of the installed `claude`. */
  findExecutable?: () => string | undefined;
  /** Tests inject the process starter. */
  tracked?: () => TrackedSpawn;
  /** After a turn ends with nothing asked, how long without a reply before the round ends by itself. Default 15 minutes. */
  idleAfterResultMs?: number;
  /** The server's pid, for the command hook's "is anyone still deciding" check. Default this process. */
  serverPid?: number;
}

/** The `query()` options of a task round. Exported for the tests. */
export function buildTaskQueryOptions(params: {
  options: TaskRunnerStartOptions;
  executable: string;
  env: Record<string, string | undefined>;
  hooks: NonNullable<Options['hooks']>;
  canUseTool: CanUseTool;
  abortController: AbortController;
  spawn: NonNullable<Options['spawnClaudeCodeProcess']>;
}): Options {
  const { options } = params;
  return {
    cwd: options.worktree,
    // The project's CLAUDE.md, rules, agents and skills, from the worktree; its settings file is hidden there.
    settingSources: ['project'],
    pathToClaudeCodeExecutable: params.executable,
    permissionMode: 'auto',
    model: options.model,
    effort: options.effort,
    tools: taskTools(options.skills),
    // Only the project's own skills: Claude Code's bundled skills, built-in plugins and synced skills are hidden and refused.
    skills: [...options.skills],
    strictMcpConfig: true,
    mcpServers: {},
    additionalDirectories: [],
    env: params.env,
    hooks: params.hooks,
    canUseTool: params.canUseTool,
    abortController: params.abortController,
    spawnClaudeCodeProcess: params.spawn,
    settings: taskFlagSettings({ worktree: options.worktree, rulesFile: options.rulesFile, restrictions: options.restrictions }) as NonNullable<Options['settings']>,
  };
}

export class TaskSdkRunner implements TaskRunner {
  constructor(private readonly deps: TaskSdkRunnerDeps) {}

  start(options: TaskRunnerStartOptions): TaskRunnerHandle {
    return new TaskSdkRun(this.deps, options).handle();
  }
}

class TaskSdkRun {
  private claimed: string | undefined;
  private cancelled = false;
  private stopped = false;
  private afterResult = false;
  private requests = 0;
  private effortReported = false;
  private summary: string | undefined;
  private readonly agents = new Map<string, string>();
  /** Tool calls the user allowed in the hook's dialog: `canUseTool` does not ask again. */
  private readonly decidedCalls = new Set<string>();
  private readonly input = new InputQueue();
  private readonly abort = new AbortController();
  private readonly tracked: TrackedSpawn;
  private readonly approvals: TaskApprovals;
  private readonly rules: TaskGuardRules;
  private query: Query | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private resolveSession!: (id: string) => void;
  private rejectSession!: (error: unknown) => void;
  private readonly sessionPromise: Promise<string>;
  private readonly donePromise: Promise<TaskRunnerOutcome>;
  private eventChain: Promise<void> = Promise.resolve();
  private opened = false;

  constructor(
    private readonly deps: TaskSdkRunnerDeps,
    private readonly options: TaskRunnerStartOptions,
  ) {
    this.tracked = (deps.tracked ?? (() => spawnTracked((pid) => killProcessTree(pid))))();
    this.rules = { worktree: options.worktree, skills: options.skills };
    this.approvals = options.approvals;
    this.sessionPromise = new Promise<string>((resolve, reject) => {
      this.resolveSession = resolve;
      this.rejectSession = reject;
    });
    this.sessionPromise.catch(() => undefined);
    this.donePromise = this.run();
  }

  handle(): TaskRunnerHandle {
    return {
      sessionId: this.sessionPromise,
      requestCancel: () => {
        this.cancelled = true;
        this.writeRules();
      },
      sendMessage: (text) => this.sendMessage(text),
      finish: () => this.close(),
      stop: () => this.stop(),
      done: this.donePromise,
    };
  }

  private writeRules(strict = false): void {
    try {
      writeTaskRulesSync(this.options.rulesFile, {
        v: 1,
        worktree: this.options.worktree,
        skills: [...this.options.skills],
        approvalsDir: this.options.approvalsDir,
        serverPid: this.deps.serverPid ?? process.pid,
        cancelled: this.cancelled,
        ...(this.claimed === undefined ? {} : { sessionIds: [this.claimed] }),
      });
    } catch (error) {
      if (strict) throw error;
    }
  }

  private async run(): Promise<TaskRunnerOutcome> {
    try {
      // Before claude exists: the command-hook guard denies everything until its rules are there.
      this.writeRules(true);
      const executable = (this.deps.findExecutable ?? (() => findClaudeExecutable({ env: this.deps.pathEnv.env, platform: process.platform, homedir: this.deps.pathEnv.homedir })))();
      if (executable === undefined) throw new BriefstackError('creation.claudeNotFound', {});
      const home = resolveHome(this.deps.pathEnv);
      const { env, removed } = cleanEnvironment(this.deps.pathEnv.env, home);
      Object.assign(env, TASK_ENV);
      this.options.io.emit({ kind: 'status', status: 'starting', ...(removed.length > 0 ? { message: `Not passed to Claude Code: ${removed.join(', ')}` } : {}) });

      const hooks: NonNullable<Options['hooks']> = {
        PreToolUse: [{ hooks: [this.taskGuardCallback()], timeout: TASK_HOOK_TIMEOUT_S }],
        PostToolUse: [{ hooks: [this.recordHook('tool.post')] }],
        PostToolUseFailure: [{ hooks: [this.recordHook('tool.failure')] }],
        SubagentStart: [{ hooks: [this.recordHook('subagent.start')] }],
        SubagentStop: [{ hooks: [this.recordHook('subagent.stop')] }],
        SessionEnd: [{ hooks: [this.recordHook('session.end')] }],
      };
      const queryOptions = buildTaskQueryOptions({
        options: this.options,
        executable,
        env,
        hooks,
        canUseTool: (toolName, input, extra) => this.canUseTool(toolName, input, extra.toolUseID, extra.agentID),
        abortController: this.abort,
        spawn: (spawnOptions) => this.tracked.spawn(spawnOptions),
      });
      this.input.push({ type: 'user', message: { role: 'user', content: this.options.prompt }, parent_tool_use_id: null });
      this.query = (this.deps.query ?? (sdkQuery as QueryFn))({ prompt: this.input, options: queryOptions });
      for await (const message of this.query) {
        this.onMessage(message);
        if (this.stopped) break;
      }
      this.clearIdle();
      return this.stopped ? { kind: 'stopped' } : { kind: 'ended', ...(this.summary === undefined ? {} : { summary: this.summary }) };
    } catch (error) {
      this.clearIdle();
      this.rejectSession(error);
      if (this.stopped) return { kind: 'stopped' };
      this.options.io.emit({ kind: 'status', status: 'error' });
      return { kind: 'failed', error: this.text(error) };
    } finally {
      await this.tracked.killTree().catch(() => undefined);
      await this.approvals.clearRecords().catch(() => undefined);
      await this.eventChain;
      if (this.claimed !== undefined && this.opened) {
        await closeTaskSession(this.options.sessionsDir, this.claimed, this.cancelled ? 'cancelled' : this.afterResult || this.summary !== undefined ? 'completed' : 'failed').catch(() => undefined);
      }
    }
  }

  private text(error: unknown): string {
    if (isBriefstackError(error)) return formatError(error, this.deps.lang ?? 'en');
    return error instanceof Error ? error.message : String(error);
  }

  private claim(id: string): void {
    if (this.claimed !== undefined) return;
    this.claimed = id;
    this.writeRules();
    this.opened = true;
    // The id goes out once the folder is open, so the manager's own lines come after `session.started`.
    this.record(() =>
      openTaskSession(this.options.sessionsDir, id, { taskId: this.options.taskId, project: this.options.project, round: this.options.round }).finally(() => this.resolveSession(id)),
    );
  }

  /** Session-folder writes, one after another, never failing the run. */
  private record(write: () => Promise<unknown>): void {
    this.eventChain = this.eventChain.then(write).then(
      () => undefined,
      () => undefined,
    );
  }

  private isOwn(sessionId: string): boolean {
    if (this.claimed === undefined) this.claim(sessionId);
    return this.claimed === sessionId;
  }

  /** The guard, the user's dialog for shell and web, the panel's `tool.pre` line and the applied effort. */
  private taskGuardCallback(): HookCallback {
    return async (hook) => {
      if (hook.hook_event_name !== 'PreToolUse') return {};
      const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason } });
      if (!this.isOwn(hook.session_id)) return deny('Not this task\'s session.');
      const agentId = hook.agent_id !== undefined && hook.agent_id !== '' ? hook.agent_id : undefined;
      const agentType = hook.agent_type !== undefined && hook.agent_type !== '' ? hook.agent_type : undefined;
      const level = (hook as { effort?: { level?: unknown } }).effort?.level;
      if (!this.effortReported && typeof level === 'string' && level !== '') {
        this.effortReported = true;
        this.options.io.emit({ kind: 'effort', level, requested: this.options.effort });
      }
      const session = hook.session_id;
      this.record(() =>
        appendEvent(
          this.options.sessionsDir,
          taskHookEvent(session, 'tool.pre', { agentId, agentType, tool: hook.tool_name, toolUseId: hook.tool_use_id, target: workTarget(hook.tool_name, hook.tool_input, this.options.worktree), effort: typeof level === 'string' ? level : undefined }),
        ),
      );
      const refuse = (reason: string) => {
        this.options.io.emit({ kind: 'denial', toolName: hook.tool_name, summary: hook.tool_name, reason, ...(agentType === undefined ? {} : { agentType }), ...(agentId === undefined ? {} : { agentId }), ...(hook.tool_use_id === '' ? {} : { toolUseId: hook.tool_use_id }) });
        return deny(reason);
      };
      if (this.cancelled) return refuse(CANCELLED_MESSAGE);
      const verdict = await evaluateTaskToolUse(this.rules, { tool_name: hook.tool_name, tool_input: hook.tool_input, agent_id: agentId }, this.deps.pathEnv);
      if (verdict.verdict === 'deny') return refuse(verdict.reason);
      if (verdict.verdict === 'ask') {
        const decision = await this.whileAsking(() =>
          this.approvals.decide(hook.tool_use_id, {
            kind: verdict.kind,
            tool: hook.tool_name,
            key: verdict.key,
            display: describeCommand(verdict.key),
            ...(agentType === undefined ? {} : { agentType }),
          }),
        );
        if (decision === 'deny' || this.cancelled) return refuse(this.cancelled ? CANCELLED_MESSAGE : 'The user did not allow this.');
        this.decidedCalls.add(hook.tool_use_id);
      }
      return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'allow' as const, permissionDecisionReason: verdict.reason } };
    };
  }

  /** Panel lines for what happened after a call, and subagents. The approval record of a finished call is removed. */
  private recordHook(type: HookEventType): HookCallback {
    return async (hook) => {
      if (!this.isOwn(hook.session_id)) return {};
      const fields = hook as { agent_id?: string; agent_type?: string; tool_name?: string; tool_use_id?: string; reason?: string };
      if (type === 'subagent.start' && fields.agent_id !== undefined && fields.agent_type !== undefined) {
        this.agents.set(fields.agent_id, fields.agent_type);
        this.options.io.emit({ kind: 'agent', phase: 'started', agentType: fields.agent_type, agentId: fields.agent_id });
      }
      if (type === 'subagent.stop' && fields.agent_id !== undefined) {
        this.options.io.emit({ kind: 'agent', phase: 'stopped', agentType: fields.agent_type ?? this.agents.get(fields.agent_id) ?? 'agent', agentId: fields.agent_id });
      }
      if (type === 'tool.post' || type === 'tool.failure') await this.approvals.forget(fields.tool_use_id);
      const session = hook.session_id;
      this.record(() =>
        appendEvent(
          this.options.sessionsDir,
          taskHookEvent(session, type, { agentId: fields.agent_id, agentType: fields.agent_type, tool: fields.tool_name, toolUseId: fields.tool_use_id, reason: fields.reason }),
        ),
      );
      return {};
    };
  }

  private onMessage(message: SDKMessage): void {
    this.armIdle();
    if (message.type === 'system' && message.subtype === 'init') {
      this.isOwn(message.session_id);
      this.options.io.emit({ kind: 'status', status: 'running' });
      return;
    }
    if (message.type === 'result') {
      this.afterResult = true;
      const last = 'result' in message && typeof message.result === 'string' ? redactSecretLines(message.result.trim()).slice(0, MAX_SUMMARY) : '';
      if (last !== '') this.summary = last;
      this.options.io.emit({ kind: 'status', status: 'turnEnded', ...(last === '' ? {} : { message: last }) });
      this.armIdle();
    }
  }

  /** After a turn, nothing for a long time ends the round as if the user had finished it. Never while the user is asked something. */
  private armIdle(): void {
    this.clearIdle();
    if (!this.afterResult || this.stopped || this.requests > 0) return;
    this.idleTimer = setTimeout(() => this.close(), this.deps.idleAfterResultMs ?? IDLE_AFTER_RESULT_MS);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private async whileAsking<T>(request: () => Promise<T>): Promise<T> {
    this.requests += 1;
    this.clearIdle();
    try {
      return await request();
    } finally {
      this.requests -= 1;
      this.armIdle();
    }
  }

  private sendMessage(text: string): void {
    if (this.stopped) return;
    this.afterResult = false;
    this.clearIdle();
    this.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  }

  /** The round is over: the input ends and the session closes after its turn. */
  private close(): void {
    this.clearIdle();
    this.input.close();
    try {
      this.query?.close();
    } catch {
      // Already closed.
    }
  }

  private async stop(): Promise<void> {
    this.stopped = true;
    this.close();
    await this.tracked.killTree().catch(() => undefined);
    await this.donePromise.catch(() => undefined);
  }

  private async canUseTool(toolName: string, input: Record<string, unknown>, toolUseId: string | undefined, agentID: string | undefined): Promise<PermissionResult> {
    if (this.cancelled) return { behavior: 'deny', message: CANCELLED_MESSAGE };
    if (toolName === 'AskUserQuestion') {
      const parsed = askInputSchema.safeParse(input);
      if (!parsed.success) return { behavior: 'deny', message: 'The questions were not in the expected shape.' };
      const result = await this.whileAsking(() => this.options.io.askQuestions({ questions: parsed.data.questions }));
      if (result.decision === 'cancel') return { behavior: 'deny', message: CANCELLED_MESSAGE };
      return { behavior: 'allow', updatedInput: { ...input, answers: result.answers } };
    }
    const verdict = await evaluateTaskToolUse(this.rules, { tool_name: toolName, tool_input: input, agent_id: agentID }, this.deps.pathEnv);
    if (verdict.verdict === 'allow') return { behavior: 'allow', updatedInput: input };
    if (verdict.verdict === 'deny') return { behavior: 'deny', message: verdict.reason };
    // A shell command or web request reaches here only after the hook (a project ask rule, say): the user already decided this very call.
    if ((toolUseId !== undefined && this.decidedCalls.has(toolUseId)) || this.approvals.allowedForTask(toolName, verdict.key)) return { behavior: 'allow', updatedInput: input };
    const decision = await this.whileAsking(() =>
      this.approvals.decide(toolUseId, { kind: verdict.kind, tool: toolName, key: verdict.key, ...(agentID === undefined ? {} : { agentType: this.agents.get(agentID) ?? 'agent' }) }),
    );
    return decision === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user did not allow this.' };
  }
}
