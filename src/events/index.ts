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

/** The creation flow, BRIEF §4. */
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

export const HOOK_EVENT_TYPES = [
  'subagent.start',
  'subagent.stop',
  'tool.pre',
  'tool.post',
  'tool.failure',
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

/** Tool inputs are never recorded: only the tool's name. */
export interface HookEvent extends EventBase {
  source: 'hook';
  type: HookEventType;
  agentId?: string;
  agentType?: string;
  tool?: string;
}

export type SessionEvent = FlowEvent | HookEvent;

/** Claude Code session ids are UUIDs; this also keeps the folder name safe. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isFlowStep(value: string): value is FlowStep {
  return (FLOW_STEPS as readonly string[]).includes(value);
}

export function sessionEventsFile(sessionsDir: string, session: string): string {
  if (!SESSION_ID_RE.test(session) || session.includes('..')) {
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
