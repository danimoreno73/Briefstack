import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { BriefstackError } from '../errors.js';

/**
 * Lifecycle events of a creation session, one JSON object per line in
 * `<briefstack home>/sessions/<session id>/events.jsonl`, append-only.
 * Flow steps come from `briefstack event`; subagent and tool events come
 * from `scripts/hook-event.mjs`, which writes the same format without
 * importing this module (it must start fast). A test keeps both in sync.
 */

export const EVENTS_FILE = 'events.jsonl';
export const EVENT_FORMAT = 1;

/** The creation flow, BRIEF-phase-1 §4. */
export const FLOW_STEPS = [
  'idea',
  'gap-analysis',
  'interview',
  'research',
  'spec',
  'generate',
  'validate-review',
  'learn',
  'handoff',
] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

export const STEP_PHASES = ['started', 'finished'] as const;
export type StepPhase = (typeof STEP_PHASES)[number];

export const STEP_OUTCOMES = ['ok', 'skipped', 'failed'] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number];

/** Opening and closing a /new-project run. Only `session.started` (or any flow event) creates the session folder. */
export const SESSION_PHASES = ['started', 'finished'] as const;
export type SessionPhase = (typeof SESSION_PHASES)[number];

export const SESSION_OUTCOMES = ['completed', 'cancelled', 'failed'] as const;
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

export const HOOK_EVENT_TYPES = [
  'subagent.start',
  'subagent.stop',
  'tool.pre',
  'tool.post',
  'tool.failure',
  /** The Claude Code session ended (`SessionEnd` hook): exit, /clear, logout... */
  'session.end',
] as const;
export type HookEventType = (typeof HOOK_EVENT_TYPES)[number];

interface EventBase {
  v: typeof EVENT_FORMAT;
  /** ISO timestamp. */
  ts: string;
  session: string;
}

export interface FlowEvent extends EventBase {
  source: 'flow';
  type: `step.${StepPhase}`;
  step: FlowStep;
  outcome?: StepOutcome;
}

export interface SessionLifecycleEvent extends EventBase {
  source: 'flow';
  type: `session.${SessionPhase}`;
  outcome?: SessionOutcome;
}

/** Tool inputs are never recorded: only the tool's name. */
export interface HookEvent extends EventBase {
  source: 'hook';
  type: HookEventType;
  agentId?: string;
  agentType?: string;
  tool?: string;
  /** `session.end` only: Claude Code's reason, e.g. `clear`, `prompt_input_exit`, `other`. */
  reason?: string;
}

export type SessionEvent = FlowEvent | SessionLifecycleEvent | HookEvent;

/** Claude Code session ids are UUIDs; this also keeps the folder name safe. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isFlowStep(value: string): value is FlowStep {
  return (FLOW_STEPS as readonly string[]).includes(value);
}

/** Whether `value` is usable as a session id (and so as a folder name). */
export function isSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value) && !value.includes('..');
}

export function sessionEventsFile(sessionsDir: string, session: string): string {
  if (!isSessionId(session)) {
    throw new BriefstackError('events.invalidSession', { session });
  }
  return path.join(sessionsDir, session, EVENTS_FILE);
}

export function flowEvent(
  session: string,
  step: FlowStep,
  phase: StepPhase,
  outcome?: StepOutcome,
  now: Date = new Date(),
): FlowEvent {
  const event: FlowEvent = { v: EVENT_FORMAT, ts: now.toISOString(), session, source: 'flow', type: `step.${phase}`, step };
  if (outcome !== undefined) event.outcome = outcome;
  return event;
}

export function sessionLifecycleEvent(
  session: string,
  phase: SessionPhase,
  outcome?: SessionOutcome,
  now: Date = new Date(),
): SessionLifecycleEvent {
  const event: SessionLifecycleEvent = { v: EVENT_FORMAT, ts: now.toISOString(), session, source: 'flow', type: `session.${phase}` };
  if (outcome !== undefined) event.outcome = outcome;
  return event;
}

/** Appends one line. `appendFile` opens with O_APPEND, so lines are never rewritten. */
export async function appendEvent(sessionsDir: string, event: SessionEvent): Promise<string> {
  const file = sessionEventsFile(sessionsDir, event.session);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
  return file;
}

export interface ReadEventsResult {
  events: SessionEvent[];
  /** 1-based numbers of lines that are not valid events. */
  badLines: number[];
}

function isSessionEvent(value: unknown): value is SessionEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  if (event.v !== EVENT_FORMAT || typeof event.ts !== 'string' || typeof event.session !== 'string') return false;
  if (event.source === 'flow') {
    if (event.type === 'session.started' || event.type === 'session.finished') {
      return event.outcome === undefined || (SESSION_OUTCOMES as readonly unknown[]).includes(event.outcome);
    }
    return (
      (event.type === 'step.started' || event.type === 'step.finished') &&
      typeof event.step === 'string' &&
      isFlowStep(event.step)
    );
  }
  return event.source === 'hook' && (HOOK_EVENT_TYPES as readonly unknown[]).includes(event.type);
}

/** Reads a session's events; a missing file has none. Bad lines are reported, not fatal. */
export async function readEvents(file: string): Promise<ReadEventsResult> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], badLines: [] };
    throw error;
  }
  const events: SessionEvent[] = [];
  const badLines: number[] = [];
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isSessionEvent(parsed)) events.push(parsed);
      else badLines.push(index + 1);
    } catch {
      badLines.push(index + 1);
    }
  });
  return { events, badLines };
}

export type SessionStatus = 'finished' | 'in-progress' | 'interrupted';

export interface SessionSummary {
  status: SessionStatus;
  /** From `session.finished`; absent unless finished. */
  outcome?: SessionOutcome;
  startedAt?: string;
  lastEventAt?: string;
  /** The last flow step reached and whether it had finished. */
  lastStep?: { step: FlowStep; phase: StepPhase };
  /** Set when the Claude Code session ended with the flow still open (`session.end`). */
  endReason?: string;
}

/** Default time without events after which an unfinished session counts as interrupted. */
export const STALE_AFTER_MINUTES = 120;

/**
 * Classifies a session from its events. Used by the phase 3 panel.
 *
 * 1. With `session.finished` it is finished, with that outcome, whatever
 *    comes after (a later `session.end` does not change it).
 * 2. Otherwise, a `session.end` with no activity after it (Claude Code exited
 *    or was cleared mid-flow) makes it interrupted at once. Activity after
 *    it (the session was resumed) puts it back under rule 3.
 * 3. Otherwise it is in progress if its last event is recent, and
 *    interrupted after `staleAfterMinutes` without events: the fallback for
 *    endings no hook reports (window closed, process killed, machine slept).
 */
export function summarizeSession(
  events: readonly SessionEvent[],
  options: { now?: Date; staleAfterMinutes?: number } = {},
): SessionSummary {
  const now = options.now ?? new Date();
  const staleAfterMs = (options.staleAfterMinutes ?? STALE_AFTER_MINUTES) * 60_000;
  const summary: SessionSummary = { status: 'in-progress' };

  let last = Number.NEGATIVE_INFINITY;
  let finished: SessionLifecycleEvent | undefined;
  // The latest `session.end` that nothing but other ends followed, in file order.
  let openEnd: HookEvent | undefined;
  for (const event of events) {
    const time = Date.parse(event.ts);
    if (Number.isFinite(time) && time >= last) {
      last = time;
      summary.lastEventAt = event.ts;
    }
    if (event.source === 'hook' && event.type === 'session.end') {
      openEnd = event;
      continue;
    }
    openEnd = undefined;
    if (event.source !== 'flow') continue;
    if (event.type === 'session.started') summary.startedAt ??= event.ts;
    else if (event.type === 'session.finished') finished = event;
    else if ('step' in event) {
      summary.lastStep = { step: event.step, phase: event.type === 'step.started' ? 'started' : 'finished' };
    }
  }

  if (finished !== undefined) {
    summary.status = 'finished';
    summary.outcome = finished.outcome ?? 'completed';
  } else if (openEnd !== undefined) {
    summary.status = 'interrupted';
    summary.endReason = openEnd.reason ?? 'other';
  } else if (!Number.isFinite(last) || now.getTime() - last > staleAfterMs) {
    summary.status = 'interrupted';
  }
  return summary;
}

export * from './sessions.js';
