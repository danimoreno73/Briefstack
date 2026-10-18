import {
  query as sdkQuery,
  type CanUseTool,
  type HookCallback,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { z } from 'zod';
import { resolveHome, type PathEnv } from '../config/index.js';
import { BriefstackError, isBriefstackError } from '../errors.js';
import { formatError } from '../i18n/errors.js';
import type { Lang } from '../i18n/index.js';
import { protectedDirs } from '../scaffold/outputDir.js';
import { redactSecretLines } from '../validate/secrets.js';
import { findClaudeExecutable } from './claudeBinary.js';
import { FLOW_BUILTIN_TOOLS, callerOf, guardHook, insideAny, parseBriefstackCommand, type GuardContext } from './guard.js';
import { folderClaimHook } from './folderClaims.js';
import { killProcessTree, spawnTracked, type TrackedSpawn } from './processTree.js';
import { SHADOWED_WEB_TOOLS, filterKnownSdkWarnings } from './sdkWarnings.js';
import type {
  CreationRunner,
  QuestionRequest,
  RunnerHandle,
  RunnerIO,
  RunnerOutcome,
  RunnerProfile,
  RunnerStartOptions,
} from './types.js';
import { APPROVE_SPEC_TOOL, GRANT_DIRECTORY_TOOL, WEB_SERVER_NAME, createWebToolsServer } from './webTools.js';

/**
 * The real runner: drives the `/new-project` skill and its five agents through
 * the Agent SDK with the user's own Claude Code and login (PLAN-phase-2 §3).
 * It reaches the user only through `RunnerIO`, like the fake runner.
 */

export const SKILL_COMMAND = 'new-project';

/**
 * Environment variables that would make Claude Code bill an API key or change
 * how it runs. `ANTHROPIC_MODEL` too: the model is always passed as an option,
 * and the variable is not left to compete with it.
 */
const REMOVED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE'];

export interface CleanEnvironment {
  env: Record<string, string | undefined>;
  /** Names (never values) of what was taken out. */
  removed: string[];
}

/**
 * The session's environment: the server's, without credentials or Claude
 * Code's own `CLAUDE_CODE_*`, with background tasks and auto memory turned off.
 */
export function cleanEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  home: string,
): CleanEnvironment {
  const env: Record<string, string | undefined> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (REMOVED_ENV.includes(name) || name.startsWith('CLAUDE_CODE_')) {
      removed.push(name);
      continue;
    }
    env[name] = value;
  }
  // The skill, the CLI and the hooks must use the same home as the server.
  env.BRIEFSTACK_HOME = home;
  // Subagents run in the foreground, so their report is the Agent call's result
  // and the main session never waits by polling (docs/decisions.md, H10).
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  // Auto memory (`~/.claude/projects/<cwd>/memory/`) loads whatever `settingSources` says; it holds
  // the user's own notes about the folder, so no session reads it (docs/decisions.md, phase 4).
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return { env, removed };
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];
const isEffort = (value: string | undefined): value is Effort => (EFFORTS as readonly string[]).includes(value ?? '');

export interface QueryOptionsParams {
  repoDir: string;
  executable: string;
  profile: RunnerProfile;
  env: Record<string, string | undefined>;
  additionalDirectories: string[];
  hooks: NonNullable<Options['hooks']>;
  canUseTool: CanUseTool;
  mcpServers: NonNullable<Options['mcpServers']>;
  abortController: AbortController;
  spawn: NonNullable<Options['spawnClaudeCodeProcess']>;
}

/**
 * The `query()` options of a creation. Never `bypassPermissions`: the session
 * runs in `auto` mode, and the guard and `canUseTool` decide what the
 * classifier must not.
 */
export function buildQueryOptions(params: QueryOptionsParams): Options {
  const { profile } = params;
  return {
    cwd: params.repoDir,
    // Project only: skills, agents and hooks. Not `local` (`settings.local.json`, `CLAUDE.local.md`) nor
    // `user`: they hold the user's own folders and notes, and the runner passes the folders it means to.
    settingSources: ['project'],
    pathToClaudeCodeExecutable: params.executable,
    permissionMode: 'auto',
    // Always explicit: the option wins over `ANTHROPIC_MODEL` and any settings file.
    model: profile.sessionModel,
    ...(isEffort(profile.effort) ? { effort: profile.effort } : {}),
    // Only the built-in tools the flow uses (`--tools`); the guard denies any other tool name too.
    tools: [...FLOW_BUILTIN_TOOLS],
    // Only the briefstack-web server: no claude.ai connectors.
    strictMcpConfig: true,
    mcpServers: params.mcpServers,
    // The two tools are ours and need no prompt; everything else goes through the guard and `canUseTool`.
    // Keep this list to `SHADOWED_WEB_TOOLS`: the SDK's shadowing warning is hidden only for exactly these.
    allowedTools: [...SHADOWED_WEB_TOOLS],
    additionalDirectories: params.additionalDirectories,
    env: params.env,
    hooks: params.hooks,
    canUseTool: params.canUseTool,
    abortController: params.abortController,
    spawnClaudeCodeProcess: params.spawn,
  };
}

/** What the main session is reminded of after the two CLI checks that come right before a web answer. */
export const WEB_REMINDERS = {
  specCheck:
    `Web app: if the spec check passed, write the summary to summary.md in the session folder and call ${APPROVE_SPEC_TOOL} ` +
    'with specFile and summaryFile now, in this turn. Do not show the summary in your reply and do not ask in plain text: ' +
    'the user cannot reply to text here, only to that tool.',
  pathsCheck:
    `Web app: if "allowed" is false and the folder is not forbidden, call ${GRANT_DIRECTORY_TOOL} with dir. ` +
    'Do not ask the user to run /add-dir: the user cannot reply to text here.',
} as const;

/**
 * A `PostToolUse` callback that adds `WEB_REMINDERS` to the result of the main
 * session's `spec check` and `paths check` calls (H10 run 2, docs/decisions.md):
 * the reminder arrives when the model decides what to do next.
 */
export function webReminderHook(isOwnSession: (id: string) => boolean): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PostToolUse' || !isOwnSession(input.session_id)) return {};
    if (callerOf(input) !== 'main' || (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell')) return {};
    const command = (input.tool_input as { command?: unknown } | undefined)?.command;
    const parsed = parseBriefstackCommand(typeof command === 'string' ? command : '');
    if (!parsed.ok || parsed.argv[1] !== 'check') return {};
    const reminder = parsed.argv[0] === 'spec' ? WEB_REMINDERS.specCheck : parsed.argv[0] === 'paths' ? WEB_REMINDERS.pathsCheck : undefined;
    if (reminder === undefined) return {};
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: reminder } };
  };
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
const MAX_SUMMARY = 500;

/** What a permission dialog shows for a tool call: the command, path, url or query, with secrets hidden. */
export function describeToolUse(toolName: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === 'string' && value !== '') return value;
    }
    return undefined;
  };
  const main = pick('command', 'file_path', 'notebook_path', 'url', 'query', 'pattern', 'path');
  const text = main ?? JSON.stringify(input);
  return `${toolName}: ${redactSecretLines(text)}`.slice(0, MAX_SUMMARY);
}

const questionSchema = z.object({
  question: z.string().min(1),
  header: z.string().default(''),
  options: z.array(z.object({ label: z.string().min(1), description: z.string().default('') })).min(1),
  multiSelect: z.boolean().default(false),
});
const askInputSchema = z.object({ questions: z.array(questionSchema).min(1).max(4) });

const CANCELLED_MESSAGE =
  'The user cancelled this creation. Close the open step as skipped and the session as cancelled, and stop.';

/** A queue the SDK reads user messages from. The first one starts the skill; the rest are not used yet. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
  private closed = false;

  push(item: SDKUserMessage): void {
    if (this.closed) return;
    if (this.waiting !== undefined) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: item, done: false });
    } else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    if (this.waiting !== undefined) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

export interface SdkRunnerDeps {
  /** The briefstack repo: the working folder of every creation. */
  repoDir: string;
  pathEnv: PathEnv;
  /** Read when each creation starts, so a change in Settings applies to the next one. */
  locations: () => Promise<{ projectsDir: string; libraryDir: string }>;
  lang?: Lang;
  /** Tests inject the SDK's `query`. */
  query?: QueryFn;
  /** Tests inject the lookup of the installed `claude`. */
  findExecutable?: () => string | undefined;
  /** Tests inject the process starter. */
  tracked?: () => TrackedSpawn;
  /**
   * After a turn ends, how long without any message before the runner ends
   * itself. Default 15 minutes. It never runs while the user is being asked
   * something (a question, a permission, the spec, a folder): the user may
   * take as long as they need.
   */
  idleAfterResultMs?: number;
  /** The same wait while a background agent is still running, as a last resort against a missed stop. Default 2 hours. */
  idleWithAgentsMs?: number;
}

const IDLE_AFTER_RESULT_MS = 15 * 60_000;
const MAX_LAST_MESSAGE = 4000;
const IDLE_WITH_AGENTS_MS = 2 * 60 * 60_000;

export class SdkRunner implements CreationRunner {
  constructor(private readonly deps: SdkRunnerDeps) {}

  start(options: RunnerStartOptions): RunnerHandle {
    return new SdkRun(this.deps, options).handle();
  }
}

class SdkRun {
  private claimed: string | undefined;
  private readonly granted: string[] = [];
  private cancelled = false;
  private stopped = false;
  private afterResult = false;
  private readonly agents = new Map<string, string>();
  /** Agents that started and have not stopped. */
  private readonly running = new Set<string>();
  /** Requests to the user that have no answer yet. */
  private requests = 0;
  /** Whether the applied effort was already reported. */
  private effortReported = false;
  /** Whether the first init message, the one that lists the tools, was read. */
  private initSeen = false;
  private readonly input = new InputQueue();
  private readonly abort = new AbortController();
  private readonly tracked: TrackedSpawn;
  private query: Query | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private resolveSession!: (id: string) => void;
  private rejectSession!: (error: unknown) => void;
  private readonly sessionPromise: Promise<string>;
  private readonly donePromise: Promise<RunnerOutcome>;
  private projectsDir = '';
  private failure: BriefstackError | undefined;

  constructor(
    private readonly deps: SdkRunnerDeps,
    private readonly options: RunnerStartOptions,
  ) {
    this.tracked = (deps.tracked ?? (() => spawnTracked((pid) => killProcessTree(pid))))();
    this.sessionPromise = new Promise<string>((resolve, reject) => {
      this.resolveSession = resolve;
      this.rejectSession = reject;
    });
    // A run that fails before the session opens must not leave an unhandled rejection.
    this.sessionPromise.catch(() => undefined);
    this.donePromise = this.run();
  }

  handle(): RunnerHandle {
    return {
      sessionId: this.sessionPromise,
      requestCancel: () => {
        this.cancelled = true;
      },
      sendMessage: (text) => this.sendMessage(text),
      stop: () => this.stop(),
      done: this.donePromise,
    };
  }

  private get io(): RunnerIO {
    return this.options.io;
  }

  private sessionDir(id: string): string {
    return path.join(this.options.sessionsDir, id);
  }

  private text(error: unknown): string {
    if (isBriefstackError(error)) return formatError(error, this.deps.lang ?? 'en');
    return error instanceof Error ? error.message : String(error);
  }

  private async run(): Promise<RunnerOutcome> {
    try {
      const { projectsDir, libraryDir } = await this.deps.locations();
      this.projectsDir = projectsDir;
      const executable = (this.deps.findExecutable ?? (() => this.findExecutable()))();
      if (executable === undefined) throw new BriefstackError('creation.claudeNotFound', {});

      const home = resolveHome(this.deps.pathEnv);
      const { env, removed } = cleanEnvironment(this.deps.pathEnv.env, home);
      this.io.emit({
        kind: 'status',
        status: 'starting',
        ...(removed.length > 0 ? { message: `Not passed to Claude Code: ${removed.join(', ')}` } : {}),
      });

      const guardContext: GuardContext = {
        isOwnSession: (id) => {
          if (this.claimed === undefined) this.claim(id);
          return this.claimed === id;
        },
        sessionDir: (id) => this.sessionDir(id),
        projectsDir,
        grantedDirs: () => this.granted,
        cancelled: () => this.cancelled,
        pathEnv: this.deps.pathEnv,
      };
      const recordAgent: HookCallback = async (hook) => {
        if (hook.session_id !== this.claimed) return {};
        if (hook.hook_event_name === 'SubagentStart') {
          this.agents.set(hook.agent_id, hook.agent_type);
          this.running.add(hook.agent_id);
          this.armIdle();
        } else if (hook.hook_event_name === 'SubagentStop') {
          this.running.delete(hook.agent_id);
          this.armIdle();
        }
        return {};
      };
      // The init message of an SDK session carries no effort; hook inputs in a tool context do.
      const recordEffort: HookCallback = async (hook) => {
        // Hooks of one event may run side by side, so this one claims the session as the guard does.
        if (this.claimed === undefined) this.claim(hook.session_id);
        if (this.effortReported || hook.session_id !== this.claimed) return {};
        const level = (hook as { effort?: { level?: unknown } }).effort?.level;
        if (typeof level !== 'string' || level === '') return {};
        this.effortReported = true;
        const requested = this.options.profile.effort;
        this.io.emit({ kind: 'effort', level, ...(requested === undefined ? {} : { requested }) });
        return {};
      };
      const webTools = createWebToolsServer({
        // Waiting for the user on the spec or a folder counts as a request too.
        io: {
          approveSpec: (request) => this.whileAsking(() => this.io.approveSpec(request)),
          grantDirectory: (request) => this.whileAsking(() => this.io.grantDirectory(request)),
          claimFolder: (dir) => this.io.claimFolder(dir),
        },
        sessionDir: () => (this.claimed === undefined ? undefined : this.sessionDir(this.claimed)),
        protectedDirs: protectedDirs(libraryDir, this.deps.repoDir, this.deps.pathEnv),
        projectsDir,
        onGrant: (dir) => this.granted.push(dir),
        pathEnv: this.deps.pathEnv,
      });

      const queryOptions = buildQueryOptions({
        repoDir: this.deps.repoDir,
        executable,
        profile: this.options.profile,
        env,
        additionalDirectories: [projectsDir, this.options.sessionsDir],
        hooks: {
          PreToolUse: [
            {
              hooks: [
                guardHook(guardContext, (denial) => this.io.emit({ kind: 'denial', ...denial })),
                // Its own hook, not the guard: a deny from either wins (docs/decisions.md, phase 4).
                folderClaimHook(
                  {
                    isOwnSession: guardContext.isOwnSession,
                    claim: (dir) => this.io.claimFolder(dir),
                    heldByOther: (target) => this.io.folderHeldByOther(target),
                    projectsDir,
                    pathEnv: this.deps.pathEnv,
                  },
                  (denial) => this.io.emit({ kind: 'denial', ...denial }),
                ),
                recordEffort,
              ],
            },
          ],
          PostToolUse: [{ hooks: [webReminderHook((id) => id === this.claimed)] }],
          SubagentStart: [{ hooks: [recordAgent] }],
          SubagentStop: [{ hooks: [recordAgent] }],
        },
        canUseTool: (toolName, input, extra) => this.whileAsking(() => this.canUseTool(toolName, input, extra.agentID)),
        mcpServers: { [WEB_SERVER_NAME]: webTools },
        abortController: this.abort,
        spawn: (spawnOptions) => this.tracked.spawn(spawnOptions),
      });

      this.input.push({
        type: 'user',
        message: { role: 'user', content: `/${SKILL_COMMAND} ${this.options.idea}` },
        parent_tool_use_id: null,
      });
      // The SDK warns that `canUseTool` is shadowed for our two web tools; that is on purpose (sdkWarnings.ts).
      filterKnownSdkWarnings();
      this.query = (this.deps.query ?? (sdkQuery as QueryFn))({ prompt: this.input, options: queryOptions });

      for await (const message of this.query) {
        this.onMessage(message);
        if (this.stopped) break;
      }
      this.clearIdle();
      if (this.failure !== undefined) throw this.failure;
      return this.stopped ? { kind: 'stopped' } : { kind: 'ended' };
    } catch (error) {
      this.clearIdle();
      this.rejectSession(error);
      if (this.stopped && error !== this.failure) return { kind: 'stopped' };
      this.io.emit({ kind: 'status', status: 'error' });
      return { kind: 'failed', error: this.text(error) };
    } finally {
      await this.tracked.killTree().catch(() => undefined);
    }
  }

  private findExecutable(): string | undefined {
    return findClaudeExecutable({ env: this.deps.pathEnv.env, platform: process.platform, homedir: this.deps.pathEnv.homedir });
  }

  private claim(id: string): void {
    this.claimed = id;
    this.resolveSession(id);
  }

  private onMessage(message: SDKMessage): void {
    this.armIdle();
    if (message.type === 'system' && message.subtype === 'init') {
      if (this.claimed === undefined) this.claim(message.session_id);
      const commands = (message as { slash_commands?: string[] }).slash_commands;
      if (commands !== undefined && !commands.includes(SKILL_COMMAND)) {
        this.fail(new BriefstackError('creation.slashCommandMissing', { command: SKILL_COMMAND }));
        return;
      }
      // Without the two browser tools the skill takes the terminal path and the spec never reaches the page.
      if (!this.initSeen) {
        this.initSeen = true;
        const tools = message.tools ?? [];
        const missing = [APPROVE_SPEC_TOOL, GRANT_DIRECTORY_TOOL].filter((tool) => !tools.includes(tool));
        if (missing.length > 0) {
          const status = message.mcp_servers?.find((server) => server.name === WEB_SERVER_NAME)?.status ?? 'not listed';
          this.fail(new BriefstackError('creation.webToolsMissing', { tools: missing.join(', '), server: WEB_SERVER_NAME, status }));
          return;
        }
      }
      this.io.emit({ kind: 'status', status: 'running' });
      return;
    }
    if (message.type === 'result') {
      this.afterResult = true;
      // The main session's last text: shown if the turn ended with nothing asked in the browser.
      const last = 'result' in message && typeof message.result === 'string' ? message.result.trim().slice(0, MAX_LAST_MESSAGE) : '';
      this.io.emit({ kind: 'status', status: 'turnEnded', ...(last === '' ? {} : { message: last }) });
      this.armIdle();
    }
  }

  /** The skill cannot run: end with the reason instead of waiting for nothing. */
  private fail(error: BriefstackError): void {
    this.failure = error;
    this.stopped = true;
    this.input.close();
    this.query?.close();
  }

  /**
   * After a turn ends, subagents may start another one; if nothing at all
   * arrives for a long time the flow is not coming back, so the runner ends
   * and the manager marks the session interrupted.
   */
  private armIdle(): void {
    this.clearIdle();
    // Never while the user has something to answer: that wait has no limit.
    if (!this.afterResult || this.stopped || this.requests > 0) return;
    const wait =
      this.running.size > 0
        ? (this.deps.idleWithAgentsMs ?? IDLE_WITH_AGENTS_MS)
        : (this.deps.idleAfterResultMs ?? IDLE_AFTER_RESULT_MS);
    this.idleTimer = setTimeout(() => {
      this.input.close();
      this.query?.close();
    }, wait);
    this.idleTimer.unref();
  }

  /** Runs a request to the user: the idle wait is off until it is answered, and starts again after. */
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

  private clearIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** The user's reply goes into the same input queue as the first message (H0 #4, phase 4); a new turn starts. */
  private sendMessage(text: string): void {
    if (this.stopped) return;
    this.afterResult = false;
    this.clearIdle();
    this.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearIdle();
    this.input.close();
    try {
      this.query?.close();
    } catch {
      // Already closed.
    }
    await this.tracked.killTree().catch(() => undefined);
    await this.donePromise.catch(() => undefined);
  }

  private async canUseTool(toolName: string, input: Record<string, unknown>, agentID: string | undefined): Promise<PermissionResult> {
    if (this.cancelled) return { behavior: 'deny', message: CANCELLED_MESSAGE };

    if (toolName === 'AskUserQuestion') {
      const parsed = askInputSchema.safeParse(input);
      if (!parsed.success) return { behavior: 'deny', message: 'The questions were not in the expected shape.' };
      const request: QuestionRequest = { questions: parsed.data.questions };
      const result = await this.io.askQuestions(request);
      if (result.decision === 'cancel') return { behavior: 'deny', message: CANCELLED_MESSAGE };
      return { behavior: 'allow', updatedInput: { ...input, answers: result.answers } };
    }

    // A write the guard let through to the permission check, in a folder the user granted: allow it for this session only.
    if (WRITE_TOOLS.has(toolName)) {
      const target = [input.file_path, input.notebook_path].find((value): value is string => typeof value === 'string');
      if (target !== undefined && this.claimed !== undefined) {
        const roots = [this.projectsDir, this.sessionDir(this.claimed), ...this.granted];
        if (await insideAny(target, roots, this.deps.pathEnv)) {
          let grant: string | undefined;
          for (const dir of this.granted) if (await insideAny(target, [dir], this.deps.pathEnv)) grant = dir;
          return {
            behavior: 'allow',
            updatedInput: input,
            ...(grant === undefined
              ? {}
              : { updatedPermissions: [{ type: 'addDirectories' as const, directories: [grant], destination: 'session' as const }] }),
          };
        }
      }
    }

    const agentType = agentID === undefined ? undefined : this.agents.get(agentID);
    const decision = await this.io.requestPermission({
      toolName,
      summary: describeToolUse(toolName, input),
      ...(agentType === undefined ? {} : { agentType }),
    });
    return decision === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'The user did not allow this action.' };
  }
}
