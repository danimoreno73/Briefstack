import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  EVENT_FORMAT,
  FLOW_STEPS,
  HOOK_EVENT_TYPES,
  SESSION_OUTCOMES,
  TARGET_ROOTS,
  STEP_OUTCOMES,
  appendEvent,
  flowEvent,
  sessionEventsFile,
  sessionLifecycleEvent,
  type FlowStep,
  type HookEvent,
} from '../events/index.js';
import { addNote } from '../library/notes.js';
import { claimRefusedMessage } from './folderClaims.js';
import type { CreationRunner, RunnerHandle, RunnerOutcome, RunnerStartOptions } from './types.js';

/**
 * A runner that replays a recorded creation, so tests and the E2E suite
 * spend no tokens and need no login (BRIEF-phase-2 §5).
 *
 * Recording format: a text file with one JSON object per line. Blank lines
 * and lines starting with `#` are ignored. Each object has a `do` field:
 *
 * - `{"do":"session","phase":"started"}` and
 *   `{"do":"session","phase":"finished","outcome":"completed"}`: the skill's
 *   `briefstack event session …` calls.
 * - `{"do":"flow","step":"spec","phase":"started"}` and
 *   `{"do":"flow","step":"spec","phase":"finished","outcome":"ok"}`: the
 *   skill's `briefstack event <step> …` calls.
 * - `{"do":"hook","type":"subagent.start","agentType":"architect"}`: a hook
 *   line (`agentId`, `agentType`, `tool`, `toolUseId`, `target`, `effort`,
 *   `model`, `reason` optional; docs/events.md).
 * - `{"do":"burst","count":500,"agentId":"a1","agentType":"generator","tool":"Read"}`:
 *   `count` pairs of `tool.pre`/`tool.post` lines written at once, to test
 *   that the page keeps up.
 * - `{"do":"emit","event":{…}}`: a `RunnerEvent` sent through `io.emit`.
 * - `{"do":"question","questions":[…],"onCancel":"<label>"}`: an
 *   `AskUserQuestion` batch (1–4 questions).
 * - `{"do":"permission","toolName":"Bash","summary":"…","agentType":"generator","onDeny":"<label>"}`.
 * - `{"do":"spec","onChange":"<label>","onCancel":"<label>","spec":"…","summary":"…"}`:
 *   the spec checkpoint. `spec` and `summary` (optional) are written to
 *   `spec.json` and `spec-summary.md` in the session folder first.
 * - `{"do":"grant","dir":"out/x","onDeny":"<label>"}`: a folder grant; a
 *   relative `dir` is resolved against the session folder.
 * - `{"do":"claim","dir":"garden","onRefused":"<label>"}`: the flow names its
 *   output folder (`paths check`), which claims it; a relative `dir` is
 *   resolved against `projectsDir` (an option), else the session folder.
 *   When another active creation holds it, a denial is reported as the
 *   runner's hook would, and the flow goes on at `onRefused` (or the next line).
 * - `{"do":"library","section":"projects","name":"garden","text":"…"}`: the
 *   learn step's `library add` (needs the `libraryDir` option).
 * - `{"do":"turnEnd","message":"Which name do you want?"}`: the main session ends
 *   its turn with that text and nothing asked; the run waits for the user's
 *   free-text reply (`sendMessage`), keeps it in `received` (an option), and goes on.
 * - `{"do":"label","name":"revise"}` and `{"do":"goto","label":"revise"}`.
 * - `{"do":"wait","ms":50}`: a pause (cut short by a cancel or a stop).
 * - `{"do":"exit"}`: the runner ends without closing the session, like a crash.
 *
 * Every `on…` label is optional. Without one, a denial or a declined grant
 * just continues (the flow goes on without that action), and a cancel from
 * a question or the spec closes the session as the skill does: the open
 * step as `skipped`, then `session finished cancelled`. `requestCancel()`
 * does the same at the next line.
 */

const label = z.string().min(1);

/** Many lines in one append, as a busy session's hooks would leave them. */
async function appendEventLines(sessionsDir: string, session: string, lines: readonly string[]): Promise<void> {
  const file = sessionEventsFile(sessionsDir, session);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, lines.map((line) => `${line}\n`).join(''), 'utf8');
}

const questionSchema = z.object({
  question: z.string().min(1),
  header: z.string(),
  options: z.array(z.object({ label: z.string().min(1), description: z.string() })).min(1),
  multiSelect: z.boolean(),
});

const hookSchema = z.object({
  do: z.literal('hook'),
  type: z.enum(HOOK_EVENT_TYPES),
  agentId: z.string().optional(),
  agentType: z.string().optional(),
  tool: z.string().optional(),
  toolUseId: z.string().optional(),
  target: z.strictObject({ root: z.enum(TARGET_ROOTS), path: z.string().optional() }).optional(),
  effort: z.string().optional(),
  model: z.string().optional(),
  reason: z.string().optional(),
});

const stepSchema = z.discriminatedUnion('do', [
  z.object({ do: z.literal('session'), phase: z.enum(['started', 'finished']), outcome: z.enum(SESSION_OUTCOMES).optional() }),
  z.object({
    do: z.literal('flow'),
    step: z.enum(FLOW_STEPS),
    phase: z.enum(['started', 'finished']),
    outcome: z.enum(STEP_OUTCOMES).optional(),
  }),
  hookSchema,
  z.object({
    do: z.literal('burst'),
    count: z.number().int().min(1).max(20_000),
    agentId: z.string().optional(),
    agentType: z.string().optional(),
    tool: z.string().min(1),
  }),
  z.object({ do: z.literal('emit'), event: z.looseObject({ kind: z.enum(['status', 'agent', 'step', 'denial']) }) }),
  z.object({ do: z.literal('question'), questions: z.array(questionSchema).min(1).max(4), onCancel: label.optional() }),
  z.object({
    do: z.literal('permission'),
    toolName: z.string().min(1),
    summary: z.string(),
    agentType: z.string().optional(),
    onDeny: label.optional(),
  }),
  z.object({
    do: z.literal('spec'),
    onChange: label,
    onCancel: label.optional(),
    spec: z.string().optional(),
    summary: z.string().optional(),
  }),
  z.object({ do: z.literal('grant'), dir: z.string().min(1), onDeny: label.optional() }),
  z.object({ do: z.literal('claim'), dir: z.string().min(1), onRefused: label.optional() }),
  z.object({ do: z.literal('turnEnd'), message: z.string() }),
  z.object({ do: z.literal('library'), section: z.string().min(1), name: z.string().min(1).optional(), text: z.string().min(1) }),
  z.object({ do: z.literal('label'), name: label }),
  z.object({ do: z.literal('goto'), label }),
  z.object({ do: z.literal('wait'), ms: z.number().int().min(0) }),
  z.object({ do: z.literal('exit') }),
]);

export type RecordingStep = z.infer<typeof stepSchema>;

/** Parses a recording; throws with the line number on the first bad line or unknown label. */
export function parseRecording(text: string): RecordingStep[] {
  const steps: RecordingStep[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`recording line ${index + 1}: ${(error as Error).message}`, { cause: error });
    }
    const parsed = stepSchema.safeParse(value);
    if (!parsed.success) throw new Error(`recording line ${index + 1}: ${z.prettifyError(parsed.error)}`);
    steps.push(parsed.data);
  });
  const labels = new Set(steps.flatMap((step) => (step.do === 'label' ? [step.name] : [])));
  for (const step of steps) {
    const targets = [
      step.do === 'goto' ? step.label : undefined,
      'onCancel' in step ? step.onCancel : undefined,
      'onChange' in step ? step.onChange : undefined,
      'onDeny' in step ? step.onDeny : undefined,
      'onRefused' in step ? step.onRefused : undefined,
    ];
    for (const target of targets) {
      if (target !== undefined && !labels.has(target)) throw new Error(`recording: unknown label "${target}"`);
    }
  }
  return steps;
}

export async function loadRecording(file: string): Promise<RecordingStep[]> {
  return parseRecording(await readFile(file, 'utf8'));
}

export interface FakeRunnerOptions {
  steps: readonly RecordingStep[];
  /** Fixed session id; a random UUID per run otherwise. */
  sessionId?: () => string;
  now?: () => Date;
  /** Simulates a flow that never honours `requestCancel()` (tests the manager's fallback). */
  ignoreCancel?: boolean;
  /** Where a relative `claim` folder is resolved. */
  projectsDir?: string;
  /** The library the `library` steps write to. */
  libraryDir?: string;
  /** Free-text replies the user sent, in order (`turnEnd`). */
  received?: string[];
}

const STOPPED = Symbol('stopped');

export class FakeRunner implements CreationRunner {
  private readonly options: FakeRunnerOptions;

  constructor(options: FakeRunnerOptions) {
    this.options = options;
  }

  static async fromFile(file: string, options: Omit<FakeRunnerOptions, 'steps'> = {}): Promise<FakeRunner> {
    return new FakeRunner({ ...options, steps: await loadRecording(file) });
  }

  start(start: RunnerStartOptions): RunnerHandle {
    const { steps, ignoreCancel = false } = this.options;
    const now = this.options.now ?? (() => new Date());
    const session = (this.options.sessionId ?? randomUUID)();
    const sessionDir = path.join(start.sessionsDir, session);
    const { io, sessionsDir } = start;

    let cancelRequested = false;
    let stopped = false;
    // Wakes a pending wait or io call on cancel or stop.
    const wakers = new Set<() => void>();
    let resolveStop: () => void = () => undefined;
    const stopSignal = new Promise<typeof STOPPED>((resolve) => {
      resolveStop = () => resolve(STOPPED);
    });
    const wake = () => {
      for (const waker of [...wakers]) waker();
    };

    const untilStopped = <T>(promise: Promise<T>): Promise<T | typeof STOPPED> => Promise.race([promise, stopSignal]);

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          wakers.delete(done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        wakers.add(done);
      });

    let openStep: FlowStep | undefined;
    let replyWaiter: ((text: string) => void) | undefined;
    const hook = (fields: Omit<HookEvent, 'v' | 'ts' | 'session' | 'source'>): HookEvent => ({
      v: EVENT_FORMAT,
      ts: now().toISOString(),
      session,
      source: 'hook',
      ...fields,
    });

    const closeCancelled = async () => {
      if (openStep !== undefined) await appendEvent(sessionsDir, flowEvent(session, openStep, 'finished', 'skipped', now()));
      openStep = undefined;
      await appendEvent(sessionsDir, sessionLifecycleEvent(session, 'finished', 'cancelled', now()));
    };

    const labels = new Map<string, number>();
    steps.forEach((step, index) => {
      if (step.do === 'label') labels.set(step.name, index);
    });
    const jump = (target: string): number => labels.get(target) as number;

    const run = async (): Promise<RunnerOutcome> => {
      io.emit({ kind: 'status', status: 'running' });
      let pc = 0;
      while (pc < steps.length) {
        if (stopped) return { kind: 'stopped' };
        if (cancelRequested && !ignoreCancel) {
          await closeCancelled();
          return { kind: 'ended' };
        }
        const step = steps[pc] as RecordingStep;
        pc += 1;
        switch (step.do) {
          case 'session':
            await appendEvent(
              sessionsDir,
              sessionLifecycleEvent(session, step.phase, step.phase === 'finished' ? (step.outcome ?? 'completed') : undefined, now()),
            );
            if (step.phase === 'finished') return { kind: 'ended' };
            break;
          case 'flow':
            await appendEvent(sessionsDir, flowEvent(session, step.step, step.phase, step.outcome, now()));
            openStep = step.phase === 'started' ? step.step : undefined;
            break;
          case 'hook': {
            const event = hook({ type: step.type });
            for (const key of ['agentId', 'agentType', 'tool', 'toolUseId', 'effort', 'model', 'reason'] as const) {
              const value = step[key];
              if (value !== undefined) event[key] = value;
            }
            if (step.target !== undefined) {
              event.target = step.target.path === undefined ? { root: step.target.root } : { root: step.target.root, path: step.target.path };
            }
            await appendEvent(sessionsDir, event);
            break;
          }
          case 'burst': {
            const lines: string[] = [];
            for (let index = 1; index <= step.count; index += 1) {
              for (const type of ['tool.pre', 'tool.post'] as const) {
                const event = hook({ type });
                if (step.agentId !== undefined) event.agentId = step.agentId;
                if (step.agentType !== undefined) event.agentType = step.agentType;
                event.tool = step.tool;
                event.toolUseId = `burst-${index}`;
                lines.push(JSON.stringify(event));
              }
            }
            await appendEventLines(sessionsDir, session, lines);
            break;
          }
          case 'emit':
            io.emit(step.event as unknown as Parameters<typeof io.emit>[0]);
            break;
          case 'question': {
            const result = await untilStopped(io.askQuestions({ questions: step.questions }));
            if (result === STOPPED) return { kind: 'stopped' };
            if (result.decision === 'cancel' && !ignoreCancel) {
              if (step.onCancel !== undefined) pc = jump(step.onCancel);
              else {
                await closeCancelled();
                return { kind: 'ended' };
              }
            }
            break;
          }
          case 'permission': {
            const request = { toolName: step.toolName, summary: step.summary };
            const decision = await untilStopped(
              io.requestPermission(step.agentType === undefined ? request : { ...request, agentType: step.agentType }),
            );
            if (decision === STOPPED) return { kind: 'stopped' };
            if (decision === 'deny' && step.onDeny !== undefined) pc = jump(step.onDeny);
            break;
          }
          case 'spec': {
            const specFile = path.join(sessionDir, 'spec.json');
            const summaryFile = path.join(sessionDir, 'spec-summary.md');
            await mkdir(sessionDir, { recursive: true });
            if (step.spec !== undefined) await writeFile(specFile, step.spec, 'utf8');
            if (step.summary !== undefined) await writeFile(summaryFile, step.summary, 'utf8');
            const result = await untilStopped(io.approveSpec({ specFile, summaryFile }));
            if (result === STOPPED) return { kind: 'stopped' };
            if (result.decision === 'change') pc = jump(step.onChange);
            else if (result.decision === 'cancel' && !ignoreCancel) {
              if (step.onCancel !== undefined) pc = jump(step.onCancel);
              else {
                await closeCancelled();
                return { kind: 'ended' };
              }
            }
            break;
          }
          case 'grant': {
            const granted = await untilStopped(io.grantDirectory({ dir: path.resolve(sessionDir, step.dir) }));
            if (granted === STOPPED) return { kind: 'stopped' };
            if (!granted && step.onDeny !== undefined) pc = jump(step.onDeny);
            break;
          }
          case 'claim': {
            const dir = path.resolve(this.options.projectsDir ?? sessionDir, step.dir);
            const result = io.claimFolder(dir);
            if (!result.ok) {
              io.emit({
                kind: 'denial',
                toolName: 'Bash',
                summary: `npm run --silent briefstack -- paths check "${dir.replaceAll('\\', '/')}" --json`,
                reason: claimRefusedMessage(dir, result.holder, this.options.projectsDir),
              });
              if (step.onRefused !== undefined) pc = jump(step.onRefused);
            }
            break;
          }
          case 'turnEnd': {
            io.emit({ kind: 'status', status: 'turnEnded', message: step.message });
            let onWake: () => void = () => undefined;
            const reply = await untilStopped(
              new Promise<string | undefined>((resolve) => {
                replyWaiter = resolve;
                // A cancel ends the wait too.
                onWake = () => resolve(undefined);
                wakers.add(onWake);
              }),
            );
            wakers.delete(onWake);
            replyWaiter = undefined;
            if (reply === STOPPED) return { kind: 'stopped' };
            if (reply === undefined) break;
            this.options.received?.push(reply);
            io.emit({ kind: 'status', status: 'running' });
            break;
          }
          case 'library': {
            const libraryDir = this.options.libraryDir;
            if (libraryDir === undefined) throw new Error('recording: a library step needs the libraryDir option');
            await addNote({ libraryDir, section: step.section, ...(step.name === undefined ? {} : { name: step.name }), text: step.text, session });
            break;
          }
          case 'label':
            break;
          case 'goto':
            pc = jump(step.label);
            break;
          case 'wait':
            await sleep(step.ms);
            break;
          case 'exit':
            return { kind: 'ended' };
        }
      }
      return { kind: 'ended' };
    };

    const done = run().catch((error: unknown): RunnerOutcome => ({
      kind: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }));

    return {
      sessionId: Promise.resolve(session),
      requestCancel: () => {
        cancelRequested = true;
        if (!ignoreCancel) wake();
      },
      sendMessage: (text) => replyWaiter?.(text),
      stop: async () => {
        stopped = true;
        resolveStop();
        wake();
        await done;
      },
      done,
    };
  }
}
