/**
 * The live agent panel's state, computed from a session's events alone
 * (BRIEF-phase-3 §4). A pure module with no imports at run time, so the
 * browser runs the same function on the live stream and on a finished
 * session's recorded lines, and the server can answer "what is creation X
 * doing" without a page (phase 4).
 *
 * Input: the lines of `events.jsonl` in file order (docs/events.md), as
 * the server projects them, plus, for a creation that is still open, what
 * the manager knows live (finished or not, the request it asks the user).
 */

/** The flow steps in order; the same list as `FLOW_STEPS` in `src/events` (a test keeps them equal). */
export const PANEL_STEPS = [
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
export type PanelStep = (typeof PANEL_STEPS)[number];
export type PanelStepState = 'waiting' | 'running' | 'ok' | 'skipped' | 'failed';

/** Same default as `STALE_AFTER_MINUTES` in `src/events`. */
export const PANEL_STALE_AFTER_MINUTES = 120;

/** One line of `events.jsonl`, loosely typed: unknown fields are ignored. */
export interface PanelEventInput {
  ts: string;
  source: string;
  type: string;
  step?: string;
  outcome?: string;
  agentId?: string;
  agentType?: string;
  tool?: string;
  toolUseId?: string;
  target?: PanelTarget;
  effort?: string;
  model?: string;
  reason?: string;
  by?: string;
  profile?: string;
  fiveHour?: number | null;
  sevenDay?: number | null;
}

export interface PanelTarget {
  root: string;
  path?: string;
}

export type PendingKind = 'question' | 'permission' | 'spec' | 'grant';

/** What the manager knows about an open creation that the file does not say. */
export interface PanelLive {
  finished: boolean;
  /** `completed`, `cancelled`, `failed` or `interrupted`, once finished. */
  outcome?: string;
  cancelling?: boolean;
  /** The request the user is asked now. A permission names the agent type that asked, if a subagent did. */
  pending?: { id: string; kind: PendingKind; agentType?: string };
  /** The first plan usage reading is on its way (it takes a few seconds). */
  usageReading?: boolean;
}

export interface PanelOptions {
  now: Date;
  live?: PanelLive;
  staleAfterMinutes?: number;
}

export type SessionPanelStatus = 'running' | 'finished' | 'interrupted';
/** `noEnd`: no stop was recorded and the session is over (BRIEF-phase-3 §3.3). */
export type NodeStatus = 'waiting' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted' | 'noEnd';

export interface PanelDenial {
  at: string;
  tool: string;
  /** `guard`, `policy` or `user`. */
  by: string;
  reason?: string;
  target?: PanelTarget;
}

export interface PanelToolCall {
  tool: string;
  target?: PanelTarget;
  since: string;
}

export interface PanelNode {
  /** `main`, or the subagent's id (made up from its type when the hook gave none). */
  id: string;
  kind: 'main' | 'agent';
  /** `main` for the main session. */
  agentType: string;
  model?: string;
  effort?: string;
  status: NodeStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** The tool it is using now; absent once it stopped. */
  current?: PanelToolCall;
  toolCalls: number;
  denials: PanelDenial[];
  /** The request the user is asked now, when this node asked it. */
  pending?: { id: string; kind: PendingKind };
}

export interface TimelineRow {
  nodeId: string;
  /** Milliseconds from the start of the timeline. */
  startMs: number;
  endMs: number;
  /** Still running: the row ends at "now". */
  open: boolean;
}

export interface UsageReading {
  at: string;
  fiveHour: number | null;
  sevenDay: number | null;
}

export interface PanelState {
  session: {
    status: SessionPanelStatus;
    outcome?: string;
    startedAt?: string;
    endedAt?: string;
    profile?: string;
  };
  nodes: PanelNode[];
  timeline: { startedAt?: string; spanMs: number; rows: TimelineRow[] };
  steps: { step: PanelStep; state: PanelStepState }[];
  /**
   * First and last plan usage reading; absent when none was recorded.
   * `reading`: none yet, and the first one is on its way in a running session.
   */
  usage: { start?: UsageReading; now?: UsageReading; reading?: true };
  /** How many lines went in. */
  eventCount: number;
}

interface OpenCall extends PanelToolCall {
  toolUseId?: string;
}

interface NodeBuild {
  node: PanelNode;
  open: OpenCall[];
  /** A stop was recorded and nothing happened after it. */
  stopped: boolean;
}

const isStep = (value: string | undefined): value is PanelStep => (PANEL_STEPS as readonly (string | undefined)[]).includes(value);

const time = (ts: string | undefined): number | undefined => {
  if (ts === undefined) return undefined;
  const value = Date.parse(ts);
  return Number.isFinite(value) ? value : undefined;
};

function removeCall(build: NodeBuild, tool: string | undefined, toolUseId: string | undefined): OpenCall | undefined {
  let index = toolUseId === undefined ? -1 : build.open.findIndex((call) => call.toolUseId === toolUseId);
  if (index === -1) index = build.open.findIndex((call) => call.toolUseId === undefined && call.tool === tool);
  if (index === -1 && toolUseId === undefined) index = build.open.findIndex((call) => call.tool === tool);
  if (index === -1) return undefined;
  return build.open.splice(index, 1)[0];
}

/**
 * The panel's state from a session's lines. Pure: the same lines and
 * options always give the same state.
 */
export function buildPanelState(events: readonly PanelEventInput[], options: PanelOptions): PanelState {
  const now = options.now.getTime();
  const staleMs = (options.staleAfterMinutes ?? PANEL_STALE_AFTER_MINUTES) * 60_000;

  const main: NodeBuild = {
    node: { id: 'main', kind: 'main', agentType: 'main', status: 'running', toolCalls: 0, denials: [] },
    open: [],
    stopped: false,
  };
  const agents: NodeBuild[] = [];
  const byId = new Map<string, NodeBuild>();
  const steps = Object.fromEntries(PANEL_STEPS.map((step) => [step, 'waiting'])) as Record<PanelStep, PanelStepState>;
  const usage: PanelState['usage'] = {};
  // Targets by tool use id, kept after the call closes: the server may write a denial after the agent's stop.
  const targets = new Map<string, PanelTarget>();

  let profileEffort: string | undefined;
  let profile: string | undefined;
  let startedAt: string | undefined;
  let firstAt: string | undefined;
  let lastActivity: string | undefined;
  let finished: PanelEventInput | undefined;
  let openEnd: PanelEventInput | undefined;

  const agentFor = (event: PanelEventInput, create: boolean): NodeBuild | undefined => {
    const key = event.agentId ?? (event.agentType === undefined ? undefined : `${event.agentType}#${agents.filter((a) => a.node.agentType === event.agentType).length + 1}`);
    if (key === undefined) return undefined;
    const known = event.agentId === undefined ? undefined : byId.get(key);
    if (known !== undefined || !create) return known;
    const build: NodeBuild = {
      node: { id: key, kind: 'agent', agentType: event.agentType ?? '', status: 'running', startedAt: event.ts, toolCalls: 0, denials: [] },
      open: [],
      stopped: false,
    };
    agents.push(build);
    byId.set(key, build);
    return build;
  };

  /** The node a line belongs to: its subagent, or the main session. */
  const nodeOf = (event: PanelEventInput): NodeBuild => {
    if (event.agentId === undefined) return main;
    return agentFor(event, true) ?? main;
  };

  /** The latest agent of a type still working, for lines that only name the type. */
  const latestOfType = (agentType: string | undefined): NodeBuild | undefined => {
    if (agentType === undefined) return undefined;
    for (let index = agents.length - 1; index >= 0; index -= 1) {
      const build = agents[index] as NodeBuild;
      if (build.node.agentType === agentType && !build.stopped) return build;
    }
    return undefined;
  };

  for (const event of events) {
    firstAt ??= event.ts;
    if (event.source !== 'runner') {
      if (event.source === 'hook' && event.type === 'session.end') openEnd = event;
      else openEnd = undefined;
      if (lastActivity === undefined || (time(event.ts) ?? 0) >= (time(lastActivity) ?? 0)) lastActivity = event.ts;
    }

    if (event.source === 'flow') {
      if (event.type === 'session.started') startedAt ??= event.ts;
      else if (event.type === 'session.finished') finished = event;
      else if (isStep(event.step)) {
        if (event.type === 'step.started') steps[event.step] = 'running';
        else if (event.type === 'step.finished') {
          steps[event.step] = event.outcome === 'skipped' ? 'skipped' : event.outcome === 'failed' ? 'failed' : 'ok';
        }
      }
      continue;
    }

    if (event.source === 'runner') {
      if (event.type === 'session.profile') {
        if (event.model !== undefined) main.node.model = event.model;
        profileEffort = event.effort;
        profile = event.profile;
      } else if (event.type === 'usage') {
        const reading: UsageReading = { at: event.ts, fiveHour: event.fiveHour ?? null, sevenDay: event.sevenDay ?? null };
        usage.start ??= reading;
        usage.now = reading;
      } else if (event.type === 'tool.denied') {
        const build = (event.agentId === undefined ? undefined : byId.get(event.agentId)) ?? latestOfType(event.agentType) ?? main;
        const call = removeCall(build, event.tool, event.toolUseId);
        const denial: PanelDenial = { at: event.ts, tool: event.tool ?? '', by: event.by ?? 'guard' };
        if (event.reason !== undefined) denial.reason = event.reason;
        const target = call?.target ?? (event.toolUseId === undefined ? undefined : targets.get(event.toolUseId));
        if (target !== undefined) denial.target = target;
        build.node.denials.push(denial);
      }
      continue;
    }

    if (event.source !== 'hook') continue;
    switch (event.type) {
      case 'subagent.start': {
        const known = event.agentId === undefined ? undefined : byId.get(event.agentId);
        const build = known ?? (agentFor(event, true) as NodeBuild);
        build.stopped = false;
        delete build.node.endedAt;
        if (event.model !== undefined) build.node.model = event.model;
        break;
      }
      case 'subagent.stop': {
        const build = event.agentId === undefined ? latestOfType(event.agentType) : nodeOf(event);
        if (build === undefined || build === main) break;
        build.stopped = true;
        build.node.endedAt = event.ts;
        build.open = [];
        if (event.effort !== undefined) build.node.effort = event.effort;
        break;
      }
      case 'tool.pre': {
        const build = nodeOf(event);
        if (build.stopped) {
          // Activity after a stop (seen in H10 run 3): the agent is working again.
          build.stopped = false;
          delete build.node.endedAt;
        }
        build.node.toolCalls += 1;
        const call: OpenCall = { tool: event.tool ?? '', since: event.ts };
        if (event.target !== undefined) call.target = event.target;
        if (event.toolUseId !== undefined) {
          call.toolUseId = event.toolUseId;
          if (event.target !== undefined) targets.set(event.toolUseId, event.target);
        }
        build.open.push(call);
        if (event.effort !== undefined) build.node.effort = event.effort;
        break;
      }
      case 'tool.post':
      case 'tool.failure': {
        removeCall(nodeOf(event), event.tool, event.toolUseId);
        break;
      }
    }
  }

  // The session as a whole.
  let status: SessionPanelStatus = 'running';
  let outcome: string | undefined;
  let endedAt: string | undefined;
  const live = options.live;
  if (finished !== undefined) {
    status = 'finished';
    outcome = finished.outcome ?? 'completed';
    endedAt = finished.ts;
  } else if (openEnd !== undefined) {
    status = 'interrupted';
    endedAt = openEnd.ts;
  } else if (live !== undefined && live.finished) {
    status = live.outcome === 'interrupted' ? 'interrupted' : 'finished';
    if (live.outcome !== undefined && live.outcome !== 'interrupted') outcome = live.outcome;
    endedAt = lastActivity;
  } else if (live === undefined && (lastActivity === undefined || now - (time(lastActivity) ?? 0) > staleMs)) {
    status = 'interrupted';
    endedAt = lastActivity;
  }
  const ended = status !== 'running';
  const sessionStart = startedAt ?? firstAt;

  // The main session.
  main.node.startedAt = sessionStart ?? options.now.toISOString();
  if (main.node.effort === undefined && profileEffort !== undefined) main.node.effort = profileEffort;
  if (ended) {
    if (endedAt !== undefined) main.node.endedAt = endedAt;
    main.node.status =
      status === 'interrupted' ? 'interrupted' : outcome === 'failed' ? 'failed' : outcome === 'cancelled' ? 'cancelled' : 'done';
  }

  // Each subagent: done once stopped; no end recorded if the session is over and it never stopped.
  for (const build of agents) {
    if (build.stopped) build.node.status = 'done';
    else if (ended) build.node.status = 'noEnd';
    else build.node.status = 'running';
  }

  // Who asked what is pending now.
  const pending = !ended ? live?.pending : undefined;
  if (pending !== undefined) {
    const asker = pending.kind === 'permission' ? (latestOfType(pending.agentType) ?? main) : main;
    asker.node.pending = { id: pending.id, kind: pending.kind };
    asker.node.status = 'waiting';
  }

  const builds = [main, ...agents];
  for (const build of builds) {
    const last = build.open.at(-1);
    const working = build.node.status === 'running' || build.node.status === 'waiting';
    if (working && last !== undefined) {
      const current: PanelToolCall = { tool: last.tool, since: last.since };
      if (last.target !== undefined) current.target = last.target;
      build.node.current = current;
    }
    const start = time(build.node.startedAt);
    const end = time(build.node.endedAt) ?? (ended ? time(endedAt) : now);
    if (start !== undefined && end !== undefined) build.node.durationMs = Math.max(0, end - start);
  }

  // The timeline: one row per node, from the session's start.
  const origin = time(sessionStart) ?? now;
  const rows: TimelineRow[] = builds.map((build) => {
    const start = time(build.node.startedAt) ?? origin;
    const open = build.node.endedAt === undefined && !ended;
    const end = time(build.node.endedAt) ?? (ended ? (time(endedAt) ?? start) : now);
    return { nodeId: build.node.id, startMs: Math.max(0, start - origin), endMs: Math.max(0, end - origin, start - origin), open };
  });
  const spanMs = Math.max(1, ...rows.map((row) => row.endMs));

  const session: PanelState['session'] = { status };
  if (outcome !== undefined) session.outcome = outcome;
  if (sessionStart !== undefined) session.startedAt = sessionStart;
  if (ended && endedAt !== undefined) session.endedAt = endedAt;
  if (profile !== undefined) session.profile = profile;

  const timeline: PanelState['timeline'] = { spanMs, rows };
  if (sessionStart !== undefined) timeline.startedAt = sessionStart;
  if (usage.start === undefined && !ended && live?.usageReading === true) usage.reading = true;

  return {
    session,
    nodes: builds.map((build) => build.node),
    timeline,
    steps: PANEL_STEPS.map((step) => ({ step, state: steps[step] })),
    usage,
    eventCount: events.length,
  };
}
