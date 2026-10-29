import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { BriefstackError } from '../errors.js';
import { redactSecretLines } from '../validate/secrets.js';
import {
  EVENTS_FILE,
  EVENT_FORMAT,
  isSessionId,
  readEvents,
  sessionEventsFile,
  summarizeSession,
  type FlowStep,
  type HookEvent,
  type SessionSummary,
  type StepOutcome,
} from './index.js';

/**
 * Read models over the session folders for the web app: the list of
 * creation sessions and one session's timeline.
 */

/**
 * `session.end` reason the web server writes when it stops with a creation
 * still open. Like Claude Code's own reasons it makes the session read as
 * interrupted at once (`summarizeSession` rule 2).
 */
export const SERVER_STOP_REASON = 'server_stop';

/** A `session.end` event written by briefstack itself rather than by the hook script. */
export function sessionEndEvent(session: string, reason: string, now: Date = new Date()): HookEvent {
  return { v: EVENT_FORMAT, ts: now.toISOString(), session, source: 'hook', type: 'session.end', reason };
}

export interface SessionListing extends SessionSummary {
  id: string;
}

export interface TimelineStep {
  step: FlowStep;
  startedAt: string;
  finishedAt?: string;
  outcome?: StepOutcome;
}

export interface TimelineAgent {
  agentId: string;
  /** From the start event, else the stop event; empty when neither says. */
  agentType: string;
  startedAt: string;
  stoppedAt?: string;
}

export interface SessionTimeline {
  summary: SessionSummary;
  /** In the order each step first started. */
  steps: TimelineStep[];
  /** In start order. */
  agents: TimelineAgent[];
}

interface SummaryOptions {
  now?: Date;
  staleAfterMinutes?: number;
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/** Newest first; ties and sessions without a start time by id. */
function byStartDesc(a: SessionListing, b: SessionListing): number {
  const left = a.startedAt ?? a.lastEventAt;
  const right = b.startedAt ?? b.lastEventAt;
  if (left !== right) {
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return Date.parse(right) - Date.parse(left) || (left < right ? 1 : -1);
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The marker a task's session folder holds (`src/tasks/runner.ts`, `TASK_MARKER_FILE`): such a session is not a creation. */
export const TASK_SESSION_MARKER = 'task.json';

/**
 * Every creation session folder that has an `events.jsonl`, summarised.
 * Folders whose name is not a valid session id, and the sessions of tasks
 * (phase 7: they hold `task.json`), are skipped. Sorted by start time,
 * newest first (a session that never recorded `session.started` uses its
 * last event).
 */
export async function listSessions(sessionsDir: string, options: SummaryOptions = {}): Promise<SessionListing[]> {
  let entries;
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions: SessionListing[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSessionId(entry.name)) continue;
    const file = path.join(sessionsDir, entry.name, EVENTS_FILE);
    if (!(await isFile(file))) continue;
    if (await isFile(path.join(sessionsDir, entry.name, TASK_SESSION_MARKER))) continue;
    const { events } = await readEvents(file);
    sessions.push({ id: entry.name, ...summarizeSession(events, options) });
  }
  return sessions.sort(byStartDesc);
}

/** The file the flow writes the idea to, verbatim, in its first step. */
export const IDEA_FILE = 'idea.md';
/** Longest idea `sessionIdea` returns, in characters; the list shows a few lines at most. */
export const MAX_IDEA_CHARS = 300;
/** A bigger `idea.md` is not read: it is not an idea the flow wrote. */
const MAX_IDEA_FILE_BYTES = 64 * 1024;

/**
 * A session's idea, for the list of unfinished creations: its `idea.md` with
 * every line that looks like a secret replaced, whitespace collapsed to
 * single spaces and cut to `MAX_IDEA_CHARS`. `undefined` when the session is
 * invalid, the file is missing, too big or empty.
 */
export async function sessionIdea(sessionsDir: string, id: string): Promise<string | undefined> {
  if (!isSessionId(id)) return undefined;
  const file = path.join(sessionsDir, id, IDEA_FILE);
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_IDEA_FILE_BYTES) return undefined;
    const text = redactSecretLines(await readFile(file, 'utf8')).replace(/\s+/g, ' ').trim();
    if (text === '') return undefined;
    return text.length <= MAX_IDEA_CHARS ? text : `${text.slice(0, MAX_IDEA_CHARS - 1)}…`;
  } catch {
    return undefined;
  }
}

/**
 * One session's summary, flow steps and subagents. A step started again
 * (e.g. after the user asked for changes) keeps only its last start and
 * finish; a finish with no start counts as starting then. A subagent stop
 * closes the latest open start with the same `agentId`.
 */
export async function sessionTimeline(
  sessionsDir: string,
  id: string,
  options: SummaryOptions = {},
): Promise<SessionTimeline> {
  const file = sessionEventsFile(sessionsDir, id);
  if (!(await isFile(file))) throw new BriefstackError('events.sessionNotFound', { session: id });
  const { events } = await readEvents(file);

  const steps = new Map<FlowStep, TimelineStep>();
  const agents: TimelineAgent[] = [];
  for (const event of events) {
    if (event.source === 'flow' && 'step' in event) {
      if (event.type === 'step.started') {
        const entry = steps.get(event.step);
        if (entry === undefined) steps.set(event.step, { step: event.step, startedAt: event.ts });
        else {
          entry.startedAt = event.ts;
          delete entry.finishedAt;
          delete entry.outcome;
        }
        continue;
      }
      let entry = steps.get(event.step);
      if (entry === undefined) {
        entry = { step: event.step, startedAt: event.ts };
        steps.set(event.step, entry);
      }
      entry.finishedAt = event.ts;
      if (event.outcome !== undefined) entry.outcome = event.outcome;
      else delete entry.outcome;
      continue;
    }
    if (event.source !== 'hook' || event.agentId === undefined) continue;
    if (event.type === 'subagent.start') {
      agents.push({ agentId: event.agentId, agentType: event.agentType ?? '', startedAt: event.ts });
    } else if (event.type === 'subagent.stop') {
      const open = agents.findLast((agent) => agent.agentId === event.agentId && agent.stoppedAt === undefined);
      if (open === undefined) {
        agents.push({ agentId: event.agentId, agentType: event.agentType ?? '', startedAt: event.ts, stoppedAt: event.ts });
      } else {
        open.stoppedAt = event.ts;
        if (open.agentType === '' && event.agentType !== undefined) open.agentType = event.agentType;
      }
    }
  }

  return { summary: summarizeSession(events, options), steps: [...steps.values()], agents };
}
