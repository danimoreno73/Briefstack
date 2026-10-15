import type { StreamEvent } from './types.js';

/** The steps of the flow, in order (the same list as `FLOW_STEPS` in `src/events`; a test keeps them equal). */
export const STEPS = [
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
export type Step = (typeof STEPS)[number];

export type StepState = 'waiting' | 'running' | 'ok' | 'skipped' | 'failed';

export interface Progress {
  steps: Record<Step, StepState>;
  /** The step running now, if any. */
  current: Step | undefined;
  /** The agents working now, in the order they started. */
  agents: string[];
  /** Denials the runner made on its own (the guard, after a cancel). */
  runnerDenials: { toolName: string; summary: string; agentType?: string; reason?: string; at: string }[];
}

const isStep = (value: string | undefined): value is Step => (STEPS as readonly (string | undefined)[]).includes(value);

/** What the live list shows, worked out from the stream's events alone. */
export function deriveProgress(events: readonly StreamEvent[]): Progress {
  const steps = Object.fromEntries(STEPS.map((step) => [step, 'waiting'])) as Record<Step, StepState>;
  const agents = new Map<string, string>();
  const runnerDenials: Progress['runnerDenials'] = [];
  let current: Step | undefined;

  for (const event of events) {
    if (event.kind === 'flow') {
      const { type, step, outcome } = event.data;
      if (isStep(step) && type === 'step.started') {
        steps[step] = 'running';
        current = step;
      } else if (isStep(step) && type === 'step.finished') {
        steps[step] = outcome === 'skipped' ? 'skipped' : outcome === 'failed' ? 'failed' : 'ok';
        if (current === step) current = undefined;
      }
    } else if (event.kind === 'hook') {
      const { type, agentId, agentType } = event.data;
      const key = agentId ?? agentType ?? '';
      if (type === 'subagent.start' && agentType !== undefined) agents.set(key, agentType);
      else if (type === 'subagent.stop') agents.delete(key);
    } else if (event.kind === 'denied' && event.data.by === 'runner') {
      const { toolName, summary, agentType, reason, at } = event.data;
      runnerDenials.push({ toolName, summary, at, ...(agentType === undefined ? {} : { agentType }), ...(reason === undefined ? {} : { reason }) });
    }
  }
  return { steps, current, agents: [...agents.values()], runnerDenials };
}

export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
}

/**
 * Splits what a stream has delivered so far into complete frames and the
 * unfinished rest. Comment lines (heartbeats) produce no frame.
 */
export function parseSse(buffer: string): { frames: SseFrame[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = parts.pop() ?? '';
  const frames: SseFrame[] = [];
  for (const part of parts) {
    const frame: SseFrame = {};
    for (const line of part.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'id' || field === 'event') frame[field] = value;
      else if (field === 'data') frame.data = frame.data === undefined ? value : `${frame.data}\n${value}`;
    }
    if (frame.data !== undefined) frames.push(frame);
  }
  return { frames, rest };
}
