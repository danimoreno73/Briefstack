import type { SessionEvent } from '../events/index.js';

/**
 * What happened in one creation, computed from its recorded events without a
 * model (BRIEF-phase-5 §3.5): review rounds, guard denials, failed steps and
 * how it ended. Used by the suggestions after a creation and by the evidence
 * an improvement session reads.
 */

export interface DenialSignal {
  tool: string;
  by: string;
  agent: string;
  /** The guard's reason, as recorded (already redacted by the writer). */
  reason?: string;
}

export interface SessionSignals {
  sessionId: string;
  outcome?: string;
  /** How many times the reviewer started. */
  reviewRounds: number;
  /** Denials by the guard or the policy (not the user's own "deny"). */
  denials: DenialSignal[];
  /** Steps that finished as `failed`. */
  failedSteps: string[];
  /** The Claude Code session ended without the flow closing it (`session.end` before `session.finished`). */
  endedWithoutClose: boolean;
}

export function sessionSignals(sessionId: string, events: readonly SessionEvent[]): SessionSignals {
  const signals: SessionSignals = { sessionId, reviewRounds: 0, denials: [], failedSteps: [], endedWithoutClose: false };
  let finished = false;
  for (const event of events) {
    if (event.source === 'flow') {
      if (event.type === 'session.finished') {
        finished = true;
        if (event.outcome !== undefined) signals.outcome = event.outcome;
      } else if (event.type === 'step.finished' && event.outcome === 'failed') signals.failedSteps.push(event.step);
    } else if (event.source === 'hook') {
      if (event.type === 'subagent.start' && event.agentType === 'reviewer') signals.reviewRounds += 1;
      if (event.type === 'session.end' && !finished) signals.endedWithoutClose = true;
    } else if (event.type === 'tool.denied' && event.by !== 'user') {
      signals.denials.push({
        tool: event.tool,
        by: event.by,
        agent: event.agentType ?? 'main',
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      });
    }
  }
  return signals;
}
