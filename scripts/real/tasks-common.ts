// Shared helpers for the real checks of phase 7 (PLAN-phase-7.md, M9):
// tasks in existing projects, with real Claude Code sessions on the saver
// profile. Never run by the test suite or by CI; the user runs them on
// purpose:
//
//   npx tsx scripts/real/check-task-<name>.ts --yes
//
// Each check works in a `sandbox()` (common.ts): a temp BRIEFSTACK_HOME
// with its own library, a temp projects folder and a sample `claude-code`
// project made here (a git repository on `main`, registered in the temp
// library as briefstack registers its projects). It runs the real
// `briefstack web` in this process (`main(['web'])`, from the sources),
// with the real task runner (`TaskSdkRunner`), and drives it through the
// HTTP API the page uses. The only addition is a tap on the SDK's
// `query()`: it reads every message the session sends (the init message's
// skills, the tool calls) and changes nothing. Nothing of the user's is
// read or written: not the real library, not the real projects.

import { query as sdkQuery, type Options, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { main, type CliIO } from '../../src/cli.js';
import { systemPathEnv, updateConfig } from '../../src/config/index.js';
import type { QueryFn } from '../../src/creation/sdkRunner.js';
import { killProcessTree, spawnTracked } from '../../src/creation/processTree.js';
import { addNote } from '../../src/library/index.js';
import { writeProjectNote } from '../../src/library/projectStatus.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { TOKEN_HEADER } from '../../src/server/index.js';
import { TaskSdkRunner } from '../../src/tasks/sdkRunner.js';
import { baseProfilesFile, loadUsageProfiles } from '../../src/usage/index.js';
import { CheckStop, oneShot, processesMentioning, readPlanUsage, report, sandboxLibrary, sessionEnv, show, type Check, type Sandbox } from './common.js';

const execFileAsync = promisify(execFile);
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a session's context reading (`getContextUsage()`) may take to answer. */
export const CONTEXT_READING_MS = 2 * 60_000;

/**
 * `promise`, or an error once `ms` pass without an answer: a wait that has no
 * answer fails the check (an error is a failure, `startCheck`), never passes it.
 */
export async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer within ${Math.round(ms / 1000)} s`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The limits of the user's instruction for M9: stop above these. */
export const FIVE_HOUR_LIMIT = 90;
export const WEEK_LIMIT = 95;

/** Reads the plan usage (no message is sent) and stops the check above the limits. */
export async function usageGate(box: Sandbox, executable: string, label: string): Promise<void> {
  const usage = await readPlanUsage(box, executable);
  console.log(`Plan usage ${label}: ${show(usage)}`);
  if (typeof usage !== 'string' && ((usage.fiveHour ?? 0) > FIVE_HOUR_LIMIT || (usage.sevenDay ?? 0) > WEEK_LIMIT)) {
    throw new CheckStop(2, `STOP: plan usage above ${FIVE_HOUR_LIMIT}% of the 5-hour window or ${WEEK_LIMIT}% of the week.`);
  }
}

// ---- The tap on the SDK -------------------------------------------------------------------------

export interface SessionInit {
  sessionId: string;
  skills: string[];
  tools: string[];
  agents: string[];
  model: string;
  permissionMode: string;
  slashCommands: string[];
  claudeCodeVersion: string;
}

/** The skills part of `getContextUsage()`: what the model's context holds (sdk.d.ts, `SDKControlGetContextUsageResponse`). */
export interface ContextSkills {
  totalSkills: number;
  includedSkills: number;
  tokens: number;
  skillFrontmatter: { name: string; source: string; tokens: number }[];
}

export interface ToolCall {
  sessionId: string;
  /** Set for a subagent's call. */
  parent: string | null;
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** What every task session of this process said, read from its messages. */
export interface Tap {
  inits: SessionInit[];
  calls: ToolCall[];
  /** Tool results that came back as errors, by tool call id. */
  errors: Map<string, string>;
  /** Every tool result, error or not, by tool call id (its text cut short). */
  results: Map<string, { error: boolean; text: string }>;
  /**
   * With `contextUsage`, the session's `getContextUsage()` asked once its
   * first turn ended, by session id: its `skills` part, `null` when the
   * answer has none, or the error's text. Without it, nothing is asked.
   */
  contextUsage?: Map<string, Promise<ContextSkills | null | string>>;
}

export function newTap(options: { contextUsage?: boolean } = {}): Tap {
  return { inits: [], calls: [], errors: new Map(), results: new Map(), ...(options.contextUsage === true ? { contextUsage: new Map() } : {}) };
}

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: { text?: unknown }) => (typeof part.text === 'string' ? part.text : '')).join('\n') : JSON.stringify(content);

function observe(tap: Tap, message: SDKMessage): void {
  if (message.type === 'system' && message.subtype === 'init') {
    const init = message as unknown as {
      session_id: string;
      skills?: unknown[];
      tools?: unknown[];
      agents?: unknown[];
      model?: unknown;
      permissionMode?: unknown;
      slash_commands?: unknown[];
      claude_code_version?: unknown;
    };
    tap.inits.push({
      sessionId: init.session_id,
      skills: (init.skills ?? []).map(String),
      tools: (init.tools ?? []).map(String),
      agents: (init.agents ?? []).map(String),
      model: String(init.model ?? ''),
      permissionMode: String(init.permissionMode ?? ''),
      slashCommands: (init.slash_commands ?? []).map(String),
      claudeCodeVersion: String(init.claude_code_version ?? ''),
    });
    return;
  }
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'tool_use') {
        tap.calls.push({ sessionId: message.session_id, parent: message.parent_tool_use_id, id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
      }
    }
    return;
  }
  if (message.type === 'user' && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (typeof block !== 'object' || block.type !== 'tool_result') continue;
      const error = block.is_error === true;
      tap.results.set(block.tool_use_id, { error, text: textOf(block.content).slice(0, 2000) });
      if (error) tap.errors.set(block.tool_use_id, textOf(block.content).slice(0, 300));
    }
  }
}

/** The SDK's `query()`, unchanged, with every message it yields read into `tap` on the way. */
export function tappedQuery(tap: Tap): QueryFn {
  return (params) => {
    const q = sdkQuery(params);
    return new Proxy(q, {
      get(target, prop) {
        if (prop === 'next') {
          return async (...args: [] | [unknown]) => {
            const step = await target.next(...(args as []));
            if (step.done !== true) {
              observe(tap, step.value);
              // Once the first turn ended, the session's context holds its skill listing: ask what it holds (a read).
              const usage = tap.contextUsage;
              if (usage !== undefined && step.value.type === 'result' && !usage.has(step.value.session_id)) {
                usage.set(
                  step.value.session_id,
                  target.getContextUsage().then(
                    (answer) => ((answer as { skills?: ContextSkills }).skills ?? null),
                    (error: unknown) => `getContextUsage failed: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                );
              }
            }
            return step;
          };
        }
        if (prop === Symbol.asyncIterator) {
          return function (this: unknown) {
            return this;
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as Query;
  };
}

// ---- The sample project --------------------------------------------------------------------------

/** Plain git for the script's own setup: no hooks of any project, a fixed identity. */
export async function git(cwd: string, args: readonly string[], emptyHooks: string): Promise<string> {
  const config = ['-c', `core.hooksPath=${emptyHooks}`, '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true', '-c', 'user.name=briefstack-check', '-c', 'user.email=check@example.invalid'];
  const { stdout } = await execFileAsync('git', [...config, ...args], { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

export interface SampleProject {
  slug: string;
  dir: string;
  /** The commit on `main` the project starts with. */
  base: string;
  emptyHooks: string;
}

/**
 * A `claude-code` project as briefstack leaves one: its files, a
 * `.briefstack/profile.json`, a git repository on `main` with one commit,
 * and its note in the sandbox library. `files` are relative paths with
 * forward slashes.
 */
export async function sampleProject(box: Sandbox, slug: string, files: Record<string, string>): Promise<SampleProject> {
  const dir = path.join(box.projects, slug);
  const emptyHooks = path.join(box.dir, 'empty-hooks');
  await mkdir(emptyHooks, { recursive: true });
  const all: Record<string, string> = {
    'CLAUDE.md': `# ${slug}\n\nA small sample project for a briefstack check.\n`,
    'README.md': `# ${slug}\n\nA small sample project.\n`,
    '.briefstack/profile.json': '{}\n',
    '.gitignore': 'node_modules/\n',
    ...files,
  };
  for (const [relative, content] of Object.entries(all)) {
    const file = path.join(dir, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  }
  await execFileAsync('git', ['init', '--quiet', '-b', 'main', dir], { windowsHide: true });
  await git(dir, ['config', 'core.autocrlf', 'false'], emptyHooks);
  await git(dir, ['add', '-A'], emptyHooks);
  await git(dir, ['commit', '--quiet', '--no-verify', '-m', 'Prepare the project with briefstack'], emptyHooks);
  const base = (await git(dir, ['rev-parse', 'HEAD'], emptyHooks)).trim();
  const note = writeProjectNote(
    {
      statusFormat: 1,
      slug,
      target: 'claude-code',
      path: dir.replaceAll('\\', '/'),
      status: 'created',
      profile: 'saver',
      updated: new Date().toISOString().slice(0, 10),
      summary: `The ${slug} sample project.`,
    },
    `# ${slug}\n\nA sample project for a real check.\n`,
  );
  await addNote({ libraryDir: path.join(box.home, 'library'), section: 'projects', name: slug, text: note });
  return { slug, dir, base, emptyHooks };
}

// ---- The real server -----------------------------------------------------------------------------

export interface ApiAnswer {
  status: number;
  body: string;
  json: () => unknown;
}

export interface Web {
  url: URL;
  call(method: string, route: string, body?: unknown): Promise<ApiAnswer>;
  /** Stops the server as Ctrl+C does and waits for it. */
  stop(): Promise<void>;
  /** What the server printed. */
  log: string[];
}

/**
 * A temp library with the saver profile, then the real `briefstack web` in
 * this process on a free port, with the real task runner tapped. The
 * server, and any process left in the work folder, end with the check.
 */
export async function startWeb(check: Check, box: Sandbox, tap: Tap): Promise<Web> {
  await sandboxLibrary(box);
  // `sandbox()` set BRIEFSTACK_HOME in this process to the temp home: the server and the runner read it from here.
  const pathEnv = systemPathEnv();
  await updateConfig(path.join(box.home, 'config.json'), { activeProfile: 'saver', permissionPolicy: 'ask' });
  // Last resort, before the sandbox goes: end anything still running from it.
  check.add(async () => {
    for (const entry of await processesMentioning(box.dir)) await killProcessTree(entry.pid);
  });
  const log: string[] = [];
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => (release = resolve));
  let address: string | undefined;
  const io: CliIO = {
    out: (line) => {
      log.push(line);
      if (/^http:\/\/127\.0\.0\.1:\d+\/#token=/.test(line)) address = line;
    },
    err: (line) => log.push(line),
    cwd: PACKAGE_ROOT,
    pathEnv,
    untilStopped: () => stopped,
    taskRunner: new TaskSdkRunner({ pathEnv, lang: 'en', query: tappedQuery(tap) }),
  };
  const running = main(['web', '--port', '0'], io).catch((error: unknown) => {
    log.push(`web failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  });
  let done = false;
  const stop = async () => {
    if (done) return;
    done = true;
    release();
    await running;
  };
  check.add(stop);
  for (let i = 0; i < 240 && address === undefined; i += 1) {
    if (log.some((line) => line.startsWith('web failed'))) break;
    await sleep(250);
  }
  if (address === undefined) throw new Error(`briefstack web did not print its address: ${log.join(' | ').slice(0, 500)}`);
  const url = new URL(address);
  const token = url.hash.replace('#token=', '');
  const call = (method: string, route: string, body?: unknown) =>
    new Promise<ApiAnswer>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: Number(url.port),
          path: route,
          method,
          headers: { host: url.host, [TOKEN_HEADER]: token, origin: url.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, json: () => JSON.parse(text) as unknown }));
        },
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  console.log('briefstack web is running (in this process, temp home).');
  return { url, call, stop, log };
}

// ---- Driving a task ------------------------------------------------------------------------------

/** The part of a task the checks read (`TaskView`, docs/api.md). */
export interface TaskSeen {
  id: string;
  state: string;
  project: string;
  baseBranch: string;
  baseCommit: string;
  branch: string;
  hidden: string[];
  model: string;
  effort: string;
  profile: string;
  rounds: { n: number; sessionId?: string; outcome?: string; commit?: string; summary?: string; error?: string }[];
  checks?: { command: string; exitCode: number | null; timedOut: boolean; output: string }[];
  validations?: { kind: string; level: string; file: string }[];
  reviewed?: string;
  applied?: { commit: string };
  reverted?: { commit: string };
  error?: string;
  pending?: { id: string; kind: 'approval' | 'question'; payload: Record<string, unknown> };
  awaitingReply?: { lastMessage: string; at: string };
}

export interface ApprovalSeen {
  text: string;
  tool: string;
  kind: string;
  compound: boolean;
  redacted: boolean;
  answer: 'once' | 'task' | 'deny';
}

export async function getTask(web: Web, id: string): Promise<TaskSeen> {
  const answer = await web.call('GET', `/api/tasks/${encodeURIComponent(id)}`);
  if (answer.status !== 200) throw new Error(`GET task ${id}: ${answer.status} ${answer.body.slice(0, 300)}`);
  return answer.json() as TaskSeen;
}

/** Starts a task as the page's form does; a refusal (the plan usage warning among them) stops the check. */
export async function startTask(web: Web, project: string, description: string): Promise<string> {
  const answer = await web.call('POST', '/api/tasks', { project, description });
  if (answer.status === 409 && answer.body.includes('usage.high')) throw new CheckStop(2, `The server warns that plan usage is high: not starting (${answer.body.slice(0, 200)}).`);
  if (answer.status !== 201) throw new Error(`POST /api/tasks: ${answer.status} ${answer.body.slice(0, 400)}`);
  const { id } = answer.json() as { id: string };
  console.log(`Task ${id} started on ${project}.`);
  return id;
}

/**
 * Follows a round until the task leaves `running` and `checking`: each
 * shell or web dialog is answered with `decide` (and recorded), a question
 * gets its first option, and a turn that ended with nothing asked is
 * finished, as the page's "finish" button does.
 */
export async function driveRound(
  web: Web,
  id: string,
  decide: (payload: { text: string; tool: string; kind: string }) => 'once' | 'task' | 'deny',
  timeoutMs = 12 * 60_000,
  /** Runs once the turn ended and before the round is finished, while the session is still open. */
  beforeFinish?: () => Promise<void>,
): Promise<{ task: TaskSeen; approvals: ApprovalSeen[]; finished: string[] }> {
  const approvals: ApprovalSeen[] = [];
  const finished: string[] = [];
  const answered = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await getTask(web, id);
    if (task.state !== 'running' && task.state !== 'checking') return { task, approvals, finished };
    if (Date.now() > deadline) throw new Error(`The round did not end within ${Math.round(timeoutMs / 60_000)} minutes (state ${task.state}).`);
    const pending = task.pending;
    if (pending !== undefined && !answered.has(pending.id)) {
      answered.add(pending.id);
      if (pending.kind === 'approval') {
        const payload = pending.payload as { text: string; tool: string; kind: string; compound: boolean; redacted: boolean };
        const answer = payload.redacted ? 'deny' : decide(payload);
        approvals.push({ text: payload.text, tool: payload.tool, kind: payload.kind, compound: payload.compound, redacted: payload.redacted, answer });
        console.log(`   dialog: ${payload.kind} ${payload.tool} ${JSON.stringify(payload.text)} -> ${answer}`);
        const sent = await web.call('POST', `/api/tasks/${id}/answer`, { pendingId: pending.id, answer });
        if (sent.status !== 200) throw new Error(`answer: ${sent.status} ${sent.body.slice(0, 300)}`);
      } else {
        const questions = (pending.payload as { questions?: { question: string; options: { label: string }[] }[] }).questions ?? [];
        const answer = Object.fromEntries(questions.map((q) => [q.question, q.options[0]?.label ?? 'yes']));
        console.log(`   question: ${JSON.stringify(questions.map((q) => q.question))} -> first options`);
        await web.call('POST', `/api/tasks/${id}/answer`, { pendingId: pending.id, answer });
      }
    } else if (pending === undefined && task.awaitingReply !== undefined && task.state === 'running' && !finished.includes(task.awaitingReply.at)) {
      finished.push(task.awaitingReply.at);
      console.log(`   turn ended: ${JSON.stringify(task.awaitingReply.lastMessage.slice(0, 300))} -> finish`);
      await beforeFinish?.();
      const sent = await web.call('POST', `/api/tasks/${id}/finish`);
      if (sent.status !== 200) throw new Error(`finish: ${sent.status} ${sent.body.slice(0, 300)}`);
    }
    await sleep(1500);
  }
}

/** Waits until the task is in one of `states`. */
export async function waitState(web: Web, id: string, states: readonly string[], timeoutMs = 5 * 60_000): Promise<TaskSeen> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await getTask(web, id);
    if (states.includes(task.state)) return task;
    if (Date.now() > deadline) throw new Error(`The task did not reach ${states.join(' or ')} (state ${task.state}).`);
    await sleep(1000);
  }
}

/** A line of a session's `events.jsonl` (the panel's source), the fields the checks read. */
export interface EventSeen {
  type: string;
  tool?: string;
  toolUseId?: string;
  /** On `tool.denied`: `guard` or `user`. */
  by?: string;
  reason?: string;
}

/** Every line of a session's `events.jsonl`; a line that does not parse is `{ type: '?' }`. */
export async function sessionEvents(box: Sandbox, sessionId: string | undefined): Promise<EventSeen[]> {
  if (sessionId === undefined) return [];
  const text = await readFile(path.join(box.sessions, sessionId, 'events.jsonl'), 'utf8').catch(() => '');
  const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const seen: EventSeen = { type: String(event.type) };
        for (const key of ['tool', 'toolUseId', 'by', 'reason'] as const) {
          const value = str(event[key]);
          if (value !== undefined) seen[key] = value;
        }
        return seen;
      } catch {
        return { type: '?' };
      }
    });
}

/** The `type` of every line of a session's `events.jsonl`, with the tool after a colon. */
export async function sessionEventTypes(box: Sandbox, sessionId: string | undefined): Promise<string[]> {
  return (await sessionEvents(box, sessionId)).map((event) => `${event.type}${event.tool === undefined ? '' : `:${event.tool}`}`);
}

// ---- Codex in Settings (phase 8, check-codex-task.ts) -------------------------------------------

/** What `GET /api/codex` and `POST /api/codex/check` answer (docs/api.md, "Codex routes"). */
export interface CodexSeen {
  enabled: boolean;
  mode: string;
  maxCalls: number;
  modeOffered: boolean;
  available: boolean;
  reason?: string;
  last?: { at: string; platform: string; mode?: string; found: boolean; ok: boolean; version: { ok: boolean; text: string }; login: { ok: boolean; text: string }; sandbox: { ok: boolean; text: string } };
}

/**
 * Before anything is spent: through the API the Settings card uses, turns
 * Codex on (mode `unelevated` on Windows, 5 calls per round) and runs the
 * status check (`--version`, `login status`, `sandbox ... -- whoami`: no
 * plan). Prints the three readings. When Codex is not found, not signed in,
 * its sandbox fails or task rounds would not get the tool, it stops the check
 * with the exact reason (a `CheckStop`), before any Claude session.
 */
export async function prepareCodex(web: Pick<Web, 'call'>, platform: NodeJS.Platform = process.platform): Promise<CodexSeen> {
  const settings = { codexEnabled: true, codexMaxCalls: 5, ...(platform === 'win32' ? { codexMode: 'unelevated' } : {}) };
  const saved = await web.call('PUT', '/api/settings', settings);
  if (saved.status !== 200) throw new CheckStop(2, `STOP before any session: the Codex settings were not saved (${saved.status} ${saved.body.slice(0, 300)}).`);
  const checked = await web.call('POST', '/api/codex/check');
  if (checked.status !== 200) throw new CheckStop(2, `STOP before any session: the Codex check did not answer (${checked.status} ${checked.body.slice(0, 300)}).`);
  const view = checked.json() as CodexSeen;
  const last = view.last;
  console.log(`Codex settings: enabled ${view.enabled}, mode ${view.modeOffered ? view.mode : '(not offered here)'}, ${view.maxCalls} calls per round.`);
  if (last !== undefined) {
    console.log(`Codex check: version ${last.version.ok ? 'ok' : 'FAILED'} ${JSON.stringify(last.version.text)}`);
    console.log(`Codex check: login ${last.login.ok ? 'ok' : 'FAILED'} ${JSON.stringify(last.login.text)}`);
    console.log(`Codex check: sandbox ${last.sandbox.ok ? 'ok' : 'FAILED'} ${JSON.stringify(last.sandbox.text)}${last.mode === undefined ? '' : ` (mode ${last.mode})`}`);
  }
  const why =
    last === undefined
      ? 'the check left no result'
      : !last.found
        ? 'Codex CLI was not found on the PATH (install it with npm install -g @openai/codex, then codex login)'
        : !last.version.ok
          ? `codex --version failed: ${JSON.stringify(last.version.text)}`
          : !last.login.ok
            ? `Codex is not signed in (codex login status: ${JSON.stringify(last.login.text)}); run codex login`
            : !last.sandbox.ok
              ? `Codex's sandbox did not run a command (${JSON.stringify(last.sandbox.text)})`
              : !view.available
                ? `task rounds would not get the tool (${view.reason ?? 'no reason given'})`
                : undefined;
  if (why !== undefined) throw new CheckStop(2, `STOP before any session: ${why}.`);
  return view;
}

/** Discards a task that is not to be applied (its branch and worktree go). */
export async function discard(web: Web, id: string): Promise<void> {
  const answer = await web.call('POST', `/api/tasks/${id}/discard`, { confirm: true });
  console.log(`Discarded task ${id}: ${answer.status}`);
}

/** The commands the shell tools were called with, from the tap. */
export const shellCalls = (tap: Tap): ToolCall[] => tap.calls.filter((call) => call.name === 'Bash' || call.name === 'PowerShell');

export const exists = (file: string): Promise<boolean> =>
  readFile(file).then(
    () => true,
    () => false,
  );

/**
 * A control session WITHOUT briefstack's task layers: a plain SDK session in
 * `cwd` with the project's settings (`settingSources: ['project']`), the
 * saver `work` model, `default` permission mode and `canUseTool` allowing
 * only `allowTools`. It shows what the task's layers take away. Returns its
 * init message and tool calls.
 */
export async function controlSession(
  check: Check,
  box: Sandbox,
  executable: string,
  params: { cwd: string; tools: string[]; allowTools: string[]; prompt: string; maxTurns?: number },
): Promise<{ init: SessionInit | undefined; calls: ToolCall[]; text: string; contextSkills: ContextSkills | null | string }> {
  const work = (await loadUsageProfiles({ baseFile: baseProfilesFile() })).presets.saver?.work;
  if (work === undefined) throw new Error('The saver profile has no work entry.');
  const tap = newTap({ contextUsage: true });
  const tracked = spawnTracked();
  const options: Options = {
    cwd: params.cwd,
    pathToClaudeCodeExecutable: executable,
    env: sessionEnv(box),
    settingSources: ['project'],
    model: work.model,
    effort: work.effort,
    permissionMode: 'default',
    strictMcpConfig: true,
    mcpServers: {},
    persistSession: false,
    maxTurns: params.maxTurns ?? 4,
    tools: params.tools,
    canUseTool: async (toolName, input) =>
      params.allowTools.includes(toolName) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Not allowed in this control session.' },
    spawnClaudeCodeProcess: (spawnOptions) => tracked.spawn(spawnOptions),
  };
  const q = check.query(tappedQuery(tap)({ prompt: oneShot(params.prompt), options }), tracked);
  let text = '';
  let contextSkills: ContextSkills | null | string = 'no context reading (the turn did not end)';
  for await (const message of q) {
    if (message.type === 'result') {
      text = 'result' in message && typeof message.result === 'string' ? message.result : '';
      // The tap asked the context reading as the result went through. Leaving the loop closes the query, so its answer is awaited here first, with a deadline.
      const reading = tap.contextUsage?.get(message.session_id);
      contextSkills = reading === undefined ? 'no context reading was asked' : await within(reading, CONTEXT_READING_MS, "the control session's context reading");
      break;
    }
  }
  q.close();
  await tracked.killTree();
  return { init: tap.inits[0], calls: tap.calls, text, contextSkills };
}

/** A path with forward slashes, for commands that run under cmd and sh alike. */
export const slashed = (file: string): string => file.replaceAll('\\', '/');

// ---- The shell scenario (checks 2 and 4) ----------------------------------------------------------

export interface ShellScenarioResult {
  ok: boolean;
  task: TaskSeen;
}

/**
 * The scenario of check-task-shell.ts (a plain project) and
 * check-task-allow-all.ts (a project whose settings allow every shell
 * command). The task asks the session to run two commands, each writing its
 * own marker file in the task's folder:
 *   A  the dialog must appear with the exact command; it is DENIED, and the
 *      marker must not exist afterwards (not in the worktree, not in the
 *      round's commit);
 *   B  the control: its dialog must appear too; it is allowed ONCE, and its
 *      marker must be in the round's commit, which shows that shell
 *      commands do run in this task, so A's missing marker means A did not
 *      run, not that nothing could.
 * Every shell call the session made must have had its own dialog, with the
 * command shown exactly as the session sent it.
 */
export async function shellScenario(web: Web, box: Sandbox, tap: Tap, project: SampleProject): Promise<ShellScenarioResult> {
  let ok = true;
  const suffix = randomInt(100000, 1000000);
  const markerA = `shell-a-${suffix}.txt`;
  const markerB = `shell-b-${suffix}.txt`;
  const commandA = `node -e "require('fs').writeFileSync('${markerA}','a')"`;
  const commandB = `node -e "require('fs').writeFileSync('${markerB}','b')"`;
  const description = [
    'Run exactly these two shell commands, in this order, each as its own tool call, character for character as written here:',
    `1) ${commandA}`,
    `2) ${commandB}`,
    'If a command is refused, do not retry it and do not do its work another way (no file tools, no other command): go on to the next one.',
    'Change nothing else. When both have been tried, say which ran and stop.',
  ].join('\n');
  const id = await startTask(web, project.slug, description);
  const { task, approvals } = await driveRound(web, id, (payload) => (payload.text.includes(markerB) ? 'once' : 'deny'));
  const worktree = path.join(box.home, 'tasks', id, 'work');
  const sessionId = task.rounds[0]?.sessionId;
  // Subagents' calls carry the session's id too.
  const calls = shellCalls(tap).filter((call) => call.sessionId === sessionId);
  console.log(`Round: ${task.state}${task.error === undefined ? '' : ` (${task.error})`}; shell calls: ${calls.length}`);
  for (const call of calls) console.log(`   ${call.name} ${JSON.stringify(call.input.command)}: ${tap.errors.has(call.id) ? `error/denied: ${tap.errors.get(call.id)}` : 'ran'}`);

  const dialogA = approvals.filter((approval) => approval.text.includes(markerA));
  const dialogB = approvals.filter((approval) => approval.text.includes(markerB));
  const callA = calls.filter((call) => String(call.input.command).includes(markerA));
  const callB = calls.filter((call) => String(call.input.command).includes(markerB));
  ok = report('the round ended on the proposal', task.state === 'proposal', task.state) && ok;
  ok = report('control: the session called the shell for command A', callA.length >= 1, `${callA.length} call(s)`) && ok;
  ok = report('the dialog for A appeared, with the exact command the session sent', dialogA.length >= 1 && callA.every((call) => dialogA.some((approval) => approval.text === call.input.command)), dialogA.map((approval) => JSON.stringify(approval.text)).join(', ') || 'NO DIALOG') && ok;
  ok = report('A was denied in the dialog', dialogA.length >= 1 && dialogA.every((approval) => approval.answer === 'deny'), '') && ok;
  ok = report('A did not run: no marker in the worktree', !(await exists(path.join(worktree, markerA))), markerA) && ok;
  ok = report('A did not run: no marker in the project folder', !(await exists(path.join(project.dir, markerA))), '') && ok;

  const proposal = (await web.call('GET', `/api/tasks/${id}/proposal`)).json() as { diff: { files: { path: string }[] } | null };
  const paths = (proposal.diff?.files ?? []).map((file) => file.path);
  console.log(`Diff: ${paths.join(', ') || 'empty'}`);
  ok = report('A did not run: no marker in the round\'s commit', !paths.includes(markerA), paths.join(', ') || 'empty') && ok;
  ok = report('control: the dialog for B appeared with the exact command, and B was allowed once', callB.length >= 1 && dialogB.some((approval) => approval.answer === 'once' && callB.some((call) => call.input.command === approval.text)), dialogB.map((approval) => approval.answer).join(', ') || 'NO DIALOG') && ok;
  ok = report('control: B ran (its marker is in the round\'s commit)', paths.includes(markerB), paths.join(', ') || 'empty') && ok;
  ok = report('every shell call had its own dialog', calls.length > 0 && calls.length === approvals.filter((approval) => approval.kind === 'shell').length, `${calls.length} call(s), ${approvals.length} dialog(s)`) && ok;

  await discard(web, id);
  return { ok, task };
}
