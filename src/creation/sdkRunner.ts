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
import { ALLOWED_DIRS_ENV } from '../library/settings.js';
import { formatError } from '../i18n/errors.js';
import type { Lang } from '../i18n/index.js';
import { protectedDirs } from '../scaffold/outputDir.js';
import { redactSecretLines } from '../validate/secrets.js';
import { findClaudeExecutable } from './claudeBinary.js';
import { FLOW_BUILTIN_TOOLS, callerOf, guardHook, insideAny, parseBriefstackCommand, specLibrarySkillNames, type GuardContext } from './guard.js';
import { folderClaimHook } from './folderClaims.js';
import { killProcessTree, spawnTracked, type TrackedSpawn } from './processTree.js';
import { processStartTime, removeRun, runDirOf, runsDirOf, writeRunRecord, type RunRecord, type StartTimeReader } from './runFiles.js';
import { GUARD_RULES_FILE, guardCommandSettings, writeGuardRulesSync } from './guardCommand.js';
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
 * Environment variables that would change how Claude Code runs a session.
 * `ANTHROPIC_MODEL`: the model is always passed as an option, and the
 * variable is not left to compete with it. `CLAUDECODE`: set when the server
 * itself runs inside Claude Code. `ALLOWED_DIRS_ENV`: only a creation sets
 * it, to its own folders.
 */
const REMOVED_ENV = ['ANTHROPIC_MODEL', 'CLAUDECODE', ALLOWED_DIRS_ENV];

/**
 * The `CLAUDE_CODE_*` variables that pass: how the user authenticates their
 * own Claude Code (a cloud provider, a long-lived sign-in token) and how it
 * reaches the network (client certificates, certificate store). Every other
 * `CLAUDE_CODE_*` is Claude Code's own behaviour and is taken out. The
 * `ANTHROPIC_*` credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
 * provider keys) pass as they are. briefstack never reads their values,
 * never logs, shows or writes them (docs/decisions.md, "Release").
 * Source: code.claude.com/docs/en/authentication and /env-vars.
 */
const PASSED_CLAUDE_CODE_ENV =
  /^CLAUDE_CODE_(?:USE_(?:BEDROCK|VERTEX|FOUNDRY|ANTHROPIC_AWS|MANTLE)|SKIP_(?:BEDROCK|VERTEX|FOUNDRY|ANTHROPIC_AWS|MANTLE)_AUTH|SKIP_AWS_CRED_CACHE|AWS_CHAIN_RESOLVE_TIMEOUT_MS|DISABLE_AUTH_REFRESH_LOCK|OAUTH_(?:TOKEN|REFRESH_TOKEN|SCOPES)|CLIENT_(?:CERT|KEY|KEY_PASSPHRASE)|CERT_STORE)$/;

export interface CleanEnvironment {
  env: Record<string, string | undefined>;
  /** Names (never values) of what was taken out. */
  removed: string[];
}

/**
 * The session's environment: the server's, with the user's own way of
 * signing in to Claude Code left as it is, without Claude Code's other
 * `CLAUDE_CODE_*`, and with background tasks and auto memory turned off.
 */
export function cleanEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  home: string,
): CleanEnvironment {
  const env: Record<string, string | undefined> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (REMOVED_ENV.includes(name) || (name.startsWith('CLAUDE_CODE_') && !PASSED_CLAUDE_CODE_ENV.test(name))) {
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
  /** Flag settings: the command-hook guard (`guardCommand.ts`). */
  settings?: ReturnType<typeof guardCommandSettings>;
}

/**
 * The repo's own `CLAUDE.md`, as `claudeMdExcludes` patterns: it is for
 * contributors ("plan first", "ask when in doubt", commit rules) and pulls
 * against the flow, which asks only through its tools (backlog 2, B8;
 * docs/decisions.md). Patterns match absolute paths with glob syntax, so the
 * file goes in both as the system writes it and with forward slashes.
 */
export function repoClaudeMdExcludes(repoDir: string): string[] {
  const file = path.join(path.resolve(repoDir), 'CLAUDE.md');
  return [...new Set([file, file.split(path.sep).join('/')])];
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
    // Flag settings: the command-hook guard, which Claude Code runs itself (it holds when the server is
    // gone), as `guardCommandSettings` wrote it; and the repo's CLAUDE.md left out of every session's memory.
    settings: { ...params.settings, claudeMdExcludes: repoClaudeMdExcludes(params.repoDir) } as NonNullable<Options['settings']>,
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
  /** Where the run files go (`runFiles.ts`). Defaults to `<home>/runs`. */
  runsDir?: string;
  /** Tests inject the reading of a process's start time. */
  startTime?: StartTimeReader;
}

/** This server's own pid and start time, read once: every run file names it. */
let serverIdentity: Promise<{ pid: number; start: string }> | undefined;
const thisServer = (startTime: StartTimeReader) =>
  (serverIdentity ??= startTime(process.pid).then((start) => ({ pid: process.pid, start: start ?? '' })));

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
  /** The library skills of the spec the user approved last; `undefined` before an approval. */
  private approvedLibrarySkills: string[] | undefined;
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
  private libraryDir = '';
  private failure: BriefstackError | undefined;
  /** The run file of this creation, once `claude` exists; its writes are serialised. */
  private runRecord: RunRecord | undefined;
  /** Set once the run folder holds the command-hook guard's rules. */
  private rulesWritten = false;
  private runWrites: Promise<void> = Promise.resolve();

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
        this.writeRules();
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
      this.libraryDir = libraryDir;
      // Before claude exists: the command-hook guard denies everything until its rules are there.
      this.rulesWritten = true;
      this.writeRules(true);
      const executable = (this.deps.findExecutable ?? (() => this.findExecutable()))();
      if (executable === undefined) throw new BriefstackError('creation.claudeNotFound', {});

      const home = resolveHome(this.deps.pathEnv);
      const { env, removed } = cleanEnvironment(this.deps.pathEnv.env, home);
      const allowedDirs = [projectsDir, this.options.sessionsDir];
      // What `briefstack paths` reports inside the session: these folders, not the repo's settings file.
      env[ALLOWED_DIRS_ENV] = JSON.stringify(allowedDirs);
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
        libraryDir,
        cwd: this.deps.repoDir,
        grantedDirs: () => this.granted,
        cancelled: () => this.cancelled,
        approvedLibrarySkills: () => this.approvedLibrarySkills,
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
          approveSpec: async (request) => {
            const decision = await this.whileAsking(() => this.io.approveSpec(request));
            // The guard lets the generator install only the library skills of the spec as approved (unticked ones are gone from it).
            this.approvedLibrarySkills = decision.decision === 'approve' ? ((await specLibrarySkillNames(request.specFile)) ?? []) : undefined;
            this.writeRules();
            return decision;
          },
          grantDirectory: (request) => this.whileAsking(() => this.io.grantDirectory(request)),
          claimFolder: (dir) => this.io.claimFolder(dir),
        },
        sessionDir: () => (this.claimed === undefined ? undefined : this.sessionDir(this.claimed)),
        protectedDirs: protectedDirs(libraryDir, this.deps.repoDir, this.deps.pathEnv),
        projectsDir,
        onGrant: (dir) => {
          this.granted.push(dir);
          // Before the grant tool returns, so the next write in that folder is not denied by the command hook.
          this.writeRules();
        },
        pathEnv: this.deps.pathEnv,
      });

      const queryOptions = buildQueryOptions({
        repoDir: this.deps.repoDir,
        executable,
        profile: this.options.profile,
        env,
        additionalDirectories: allowedDirs,
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
        settings: guardCommandSettings(this.rulesFile),
        spawn: (spawnOptions) => {
          const child = this.tracked.spawn(spawnOptions);
          const { pid } = child as { pid?: number };
          if (pid !== undefined) this.recordRun(pid);
          return child;
        },
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
      // The tree is gone: nothing is left for the next start to clean up.
      await this.runWrites;
      if (this.rulesWritten || this.runRecord !== undefined) await removeRun(this.runsDir, this.options.creationId).catch(() => undefined);
    }
  }

  private get rulesFile(): string {
    return path.join(runDirOf(this.runsDir, this.options.creationId), GUARD_RULES_FILE);
  }

  /**
   * Writes the command-hook guard's rules: the same folders, grants, cancel
   * and session the callback guard reads. A failed rewrite later in the run
   * leaves the old rules, which allow less, or the same.
   */
  private writeRules(strict = false): void {
    if (!this.rulesWritten) return;
    try {
      writeGuardRulesSync(this.rulesFile, {
        v: 1,
        projectsDir: this.projectsDir,
        sessionsDir: this.options.sessionsDir,
        libraryDir: this.libraryDir,
        cwd: this.deps.repoDir,
        granted: [...this.granted],
        cancelled: this.cancelled,
        ...(this.approvedLibrarySkills === undefined ? {} : { librarySkills: [...this.approvedLibrarySkills] }),
        ...(this.claimed === undefined ? {} : { sessionId: this.claimed }),
      });
    } catch (error) {
      if (strict) throw error;
    }
  }

  private get runsDir(): string {
    return this.deps.runsDir ?? runsDirOf(resolveHome(this.deps.pathEnv));
  }

  /** Writes the run file for the `claude` process just started (`runFiles.ts`). */
  private recordRun(pid: number): void {
    const startTime = this.deps.startTime ?? ((target: number) => processStartTime(target));
    this.runWrites = this.runWrites
      .then(async () => {
        const [start, server] = await Promise.all([startTime(pid), thisServer(startTime)]);
        this.runRecord = {
          v: 1,
          creationId: this.options.creationId,
          claude: { pid, start: start ?? '' },
          server,
          ...(this.claimed === undefined ? {} : { sessionId: this.claimed }),
          startedAt: new Date().toISOString(),
        };
        await writeRunRecord(this.runsDir, this.runRecord);
      })
      .catch(() => undefined);
  }

  /** Adds the session id to the run file, once it is known. */
  private recordRunSession(id: string): void {
    this.runWrites = this.runWrites
      .then(async () => {
        if (this.runRecord === undefined || this.runRecord.sessionId === id) return;
        this.runRecord = { ...this.runRecord, sessionId: id };
        await writeRunRecord(this.runsDir, this.runRecord);
      })
      .catch(() => undefined);
  }

  private findExecutable(): string | undefined {
    return findClaudeExecutable({ env: this.deps.pathEnv.env, platform: process.platform, homedir: this.deps.pathEnv.homedir });
  }

  private claim(id: string): void {
    this.claimed = id;
    this.resolveSession(id);
    this.recordRunSession(id);
    this.writeRules();
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
