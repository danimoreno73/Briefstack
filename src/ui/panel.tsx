import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { PANEL_STEPS, buildPanelState, type PanelEventInput, type PanelLive, type PanelNode, type PanelState, type PanelStepState } from '../panel/state.js';
import { useApp, useDocumentTitle, useLoad } from './hooks.js';
import { IconCheck, IconCross } from './icons.js';
import { LoadState, Note } from './kit.js';
import { barGeometry, formatClock, formatDuration, percent, stepNumber, targetText, timelineTicks, usageMeter } from './panelData.js';
import { routeHash } from './route.js';

/**
 * The live agent panel (BRIEF-phase-3 §3), on bs.css (U5). It only reads:
 * the controls that answer the flow stay on the creation page, and a node
 * that asks something links to its control.
 */

/** Id of the element that holds the control answering the pending request. */
export const PENDING_CONTROL_ID = 'pending-control';

/** How often the live panel recomputes at most, so a burst of events does not freeze the page. */
const RECOMPUTE_MS = 200;

/**
 * The panel state for a list of lines that may grow fast: recomputed at most
 * every `RECOMPUTE_MS`, and every second while something runs (durations).
 */
export function usePanelState(events: readonly PanelEventInput[], live: PanelLive | undefined): PanelState {
  const [shown, setShown] = useState({ events, live });
  const latest = useRef({ events, live });
  latest.current = { events, live };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastRun = useRef(0);

  useEffect(() => {
    if (timer.current !== undefined) return;
    const wait = Math.max(0, lastRun.current + RECOMPUTE_MS - Date.now());
    timer.current = setTimeout(() => {
      timer.current = undefined;
      lastRun.current = Date.now();
      setShown(latest.current);
    }, wait);
  }, [events, live]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const [tick, setTick] = useState(0);
  const state = useMemo(() => buildPanelState(shown.events, { now: new Date(), ...(shown.live === undefined ? {} : { live: shown.live }) }), [shown, tick]);
  const running = state.session.status === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const interval = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(interval);
  }, [running]);
  return state;
}

function nodeName(node: PanelNode, mainLabel: string): string {
  return node.kind === 'main' ? mainLabel : node.agentType || '?';
}

// ---------------------------------------------------------------------------
// Progress

/**
 * The nine steps as segments: done in the accent, the current one in cream.
 * Each step's state is in words for screen readers; the line above says
 * which step it is.
 */
export function StepBar({ steps, current }: { steps: { step: string; state: PanelStepState }[]; current: string | undefined }) {
  const { t } = useApp();
  return (
    <ol class="segs" aria-label={t.progressTitle} data-testid="progress">
      {steps.map(({ step, state }) => (
        <li
          key={step}
          class={`seg-step${state === 'ok' || state === 'skipped' ? ' done' : ''}${state === 'running' ? ' now' : ''}${state === 'failed' ? ' fail' : ''}`}
          data-state={state}
          aria-current={current === step ? 'step' : undefined}
        >
          <span>{t.stepLabel(step)}</span>
          <small class="sr-only">{t.stepState(state)}</small>
        </li>
      ))}
    </ol>
  );
}

/** "step 3 / 9" for the step running now or, between steps, the last one reached. */
export function stepPosition(steps: { step: string; state: PanelStepState }[], current: string | undefined): { index: number; step: string } | undefined {
  const reached = current ?? [...steps].reverse().find((item) => item.state !== 'waiting')?.step;
  const index = stepNumber(PANEL_STEPS, reached);
  return index === undefined || reached === undefined ? undefined : { index, step: reached };
}

// ---------------------------------------------------------------------------
// Plan usage

/** Plan usage at the start and at the latest reading, as two meters; never tokens or cost. */
export function PlanUsage({ state, finished = false, compact = false }: { state: PanelState; finished?: boolean; compact?: boolean }) {
  const { t, lang } = useApp();
  const { start, now } = state.usage;
  const rows =
    start === undefined
      ? []
      : [
          { label: t.usageFiveHour, meter: usageMeter(start.fiveHour, now?.fiveHour) },
          { label: t.usageSevenDay, meter: usageMeter(start.sevenDay, now?.sevenDay) },
        ];
  return (
    <section class={compact ? 'card usage-card usage-compact' : 'card usage-card'} aria-labelledby="usage-title" data-testid="panel-usage">
      <h2 class={compact ? 'sr-only' : 't-2'} id="usage-title">
        {t.usageSession}
      </h2>
      {start === undefined ? (
        <p class="t-small muted" role="status">
          {state.usage.reading === true ? t.panelUsageReading : t.panelUsageNone}
        </p>
      ) : (
        rows.map(({ label, meter }) => (
          <div class="use-row" key={label}>
            <div class="use-head">
              <span class="t-small muted">{label}</span>
              <span class="use-big">{meter === undefined ? '?' : percent(meter.now)}</span>
            </div>
            {meter !== undefined && (
              <>
                {/* Widths through the CSSOM (Preact's style object), which the CSP allows; style attributes it does not. */}
                <div class="meter" role="img" aria-label={t.usageMeter(percent(meter.start), percent(meter.now), finished)}>
                  <span class="m-now" style={{ width: `${meter.now}%` }} />
                  <span class="m-start" style={{ width: `${meter.start}%` }} />
                  <span class="m-mark" style={{ left: `${meter.start}%` }} />
                </div>
                <span class="meta">
                  <span>{t.usageAtStart(percent(meter.start))}</span>
                  <span aria-hidden="true">·</span>
                  <span>{t.usageDelta(meter.delta)}</span>
                </span>
              </>
            )}
          </div>
        ))
      )}
      {now !== undefined && start !== undefined && now.at !== start.at && (
        <p class="meta">
          {t.panelUsageNow} · {formatClock(now.at, lang)}
        </p>
      )}
      {!compact && <p class="t-small muted">{t.panelUsageHint}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Agents

/** The mark before a node's name: the state is also in words beside it. */
function StatusMark({ node }: { node: PanelNode }) {
  switch (node.status) {
    case 'running':
      return (
        <span class="n-dot st-run">
          <span class="dot pulse" />
        </span>
      );
    case 'done':
      return (
        <span class="n-dot st-done">
          <IconCheck />
        </span>
      );
    case 'failed':
      return (
        <span class="n-dot st-fail">
          <IconCross />
        </span>
      );
    case 'cancelled':
      return (
        <span class="n-dot st-wait">
          <IconCross />
        </span>
      );
    case 'waiting':
      return (
        <span class="n-dot st-wait">
          <span class="ring" />
        </span>
      );
    default:
      return (
        <span class="n-dot st-fail">
          <span class="ring" />
        </span>
      );
  }
}

/** The state in words: cream for the node that waits for the user, the plain state for the others. */
function StatusWord({ node }: { node: PanelNode }) {
  const { t } = useApp();
  if (node.status === 'waiting')
    return (
      <span class="chip chip-dec chip-node" data-testid="node-status">
        {t.nodeStatus(node.status)}
      </span>
    );
  const tone = node.status === 'running' ? 'st-run' : node.status === 'done' ? 'st-done' : node.status === 'cancelled' ? 'st-cancel' : 'st-fail';
  return (
    <span class={`state ${tone}`} data-testid="node-status">
      {t.nodeStatus(node.status)}
    </span>
  );
}

const barKind = (node: PanelNode): string =>
  node.status === 'running' ? 'bar-run' : node.status === 'waiting' ? 'bar-wait' : node.status === 'done' ? 'bar-done' : 'bar-fail';

/**
 * Each fact has one place (audit M15): the node says who, model, time and
 * what it does; the details add the start, the counts and the denied calls
 * with their reasons; the text view repeats everything for screen readers
 * and copying.
 */
export function AgentPanel({ state, showPendingLinks = false, title }: { state: PanelState; showPendingLinks?: boolean; title?: string }) {
  const { t, lang } = useApp();
  const [selected, setSelected] = useState('main');
  const [view, setView] = useState<'tree' | 'text'>('tree');
  const node = state.nodes.find((item) => item.id === selected) ?? state.nodes[0];
  const labels = { outside: t.targetOutside, root: t.targetRoot };
  const [main, ...agents] = state.nodes;

  const goToControl = () => {
    const control = document.getElementById(PENDING_CONTROL_ID);
    if (control === null) return;
    control.scrollIntoView({ block: 'start' });
    const first = control.querySelector<HTMLElement>('input, textarea, button, [tabindex]');
    (first ?? control).focus();
  };

  const item = (entry: PanelNode) => {
    const target = targetText(entry.current?.target, labels);
    const name = nodeName(entry, t.panelMain);
    return (
      <li key={entry.id} class="node-item" data-status={entry.status} data-kind={entry.kind} data-testid={`agent-${entry.id}`}>
        <button
          type="button"
          class={entry.kind === 'main' ? 'node' : 'node node-child'}
          aria-expanded={entry.id === node?.id}
          aria-controls="panel-detail"
          aria-label={`${name}: ${t.nodeStatus(entry.status)}`}
          onClick={() => setSelected(entry.id)}
        >
          <StatusMark node={entry} />
          <span class="n-name">
            <b>{name}</b>
            {(entry.model !== undefined || entry.effort !== undefined) && (
              <span class="n-model">{[entry.model, entry.effort].filter((value) => value !== undefined).join(' · ')}</span>
            )}
          </span>
          <span class="n-right">
            <span class="n-dur">{formatDuration(entry.durationMs, lang)}</span>
            <StatusWord node={entry} />
          </span>
          <span class="n-tool" data-testid="agent-now">
            {entry.current === undefined ? (
              <span class="faint">{t.panelNoTool}</span>
            ) : (
              <>
                {entry.current.tool}
                {target !== undefined && <span class={entry.current.target?.root === 'outside' ? 'deny' : undefined}> → {target}</span>}
              </>
            )}
          </span>
          <span class="n-count">
            {t.panelToolCalls(entry.toolCalls)}
            {entry.denials.length > 0 && (
              <>
                {' · '}
                <span class="deny" data-testid="denial-count">
                  {t.panelDenialCount(entry.denials.length)}
                </span>
              </>
            )}
          </span>
        </button>
        {entry.pending !== undefined && (
          <div class={entry.kind === 'main' ? 'node-pending' : 'node-pending node-pending-child'} data-testid="node-pending">
            <span class="chip chip-dec">{t.panelAsks(entry.pending.kind)}</span>
            {showPendingLinks && (
              <button type="button" class="btn btn-secondary btn-sm" onClick={goToControl}>
                {t.panelGoToControl}
              </button>
            )}
          </div>
        )}
      </li>
    );
  };

  const ticks = timelineTicks(state.timeline.spanMs, lang);

  return (
    <section class="card card-flush" aria-labelledby="panel-title" data-testid="agent-panel">
      <div class="card-head">
        <h2 class="t-2" id="panel-title">
          {title ?? t.panelTitle}
        </h2>
        <div class="seg" role="group" aria-label={t.agentsView}>
          <button type="button" aria-pressed={view === 'tree'} onClick={() => setView('tree')}>
            {t.viewTree}
          </button>
          <button type="button" aria-pressed={view === 'text'} onClick={() => setView('text')}>
            {t.viewText}
          </button>
        </div>
      </div>

      {view === 'tree' ? (
        <>
          <ul class="nodes" aria-label={t.panelTitle}>
            {main !== undefined && item(main)}
            {agents.map(item)}
            {main !== undefined && agents.length === 0 && <li class="t-small muted nodes-none">{t.panelNoAgents}</li>}
          </ul>

          <div class="tl" data-testid="panel-timeline">
            <div class="tl-axis">
              <span>{t.panelTimeline}</span>
              <span class="tl-ticks" aria-hidden="true">
                {ticks.map((tick, index) => (
                  <span key={index}>{tick}</span>
                ))}
              </span>
              <span />
            </div>
            {state.timeline.rows.map((row) => {
              const entry = state.nodes.find((candidate) => candidate.id === row.nodeId);
              if (entry === undefined) return null;
              const { left, width } = barGeometry(row.startMs, row.endMs, state.timeline.spanMs);
              return (
                <button
                  key={row.nodeId}
                  type="button"
                  class="tl-row"
                  aria-pressed={entry.id === node?.id}
                  aria-controls="panel-detail"
                  data-status={entry.status}
                  onClick={() => setSelected(entry.id)}
                >
                  <span class="tl-label">
                    {nodeName(entry, t.panelMain)}
                    {/* The state in words too, not only the bar's colour (audit M13). */}
                    <span class="sr-only">, {t.nodeStatus(entry.status)}</span>
                  </span>
                  <span class="tl-track" aria-hidden="true">
                    <span class={`bar ${barKind(entry)}`} style={{ left: `${left}%`, width: `${width}%` }} />
                    {row.open && <span class="bar-now" style={{ left: `${left + width}%` }} />}
                  </span>
                  <span class="tl-dur">{formatDuration(entry.durationMs, lang)}</span>
                </button>
              );
            })}
            <p class="meta tl-legend">
              {t.panelLegend.map((part) => (
                <span key={part}>{part}</span>
              ))}
              <span>{t.panelTimelineHint}</span>
            </p>
          </div>

          {node !== undefined && (
            <div class="detail" id="panel-detail" data-testid="panel-detail">
              <div class="detail-facts">
                <h3 class="mono detail-name">
                  <span class="sr-only">{t.panelDetail}: </span>
                  {nodeName(node, t.panelMain)}
                </h3>
                <dl class="kv">
                  <dt>{t.panelModel}</dt>
                  <dd class="mono">{node.model ?? '—'}</dd>
                  <dt>{t.panelEffort}</dt>
                  <dd>{node.effort ?? '—'}</dd>
                  <dt>{t.panelStatus}</dt>
                  <dd>{t.nodeStatus(node.status)}</dd>
                  <dt>{t.panelStarted}</dt>
                  <dd class="num">{formatClock(node.startedAt, lang)}</dd>
                  <dt>{t.panelDuration}</dt>
                  <dd class="num">{formatDuration(node.durationMs, lang)}</dd>
                  <dt>{t.panelCalls}</dt>
                  <dd class="num">{node.toolCalls}</dd>
                  <dt>{t.panelDeniedLabel}</dt>
                  <dd class={node.denials.length > 0 ? 'num deny' : 'num'}>{node.denials.length}</dd>
                </dl>
              </div>
              <div class="detail-log">
                <h4 class="t-small strong">{t.panelDenials}</h4>
                {node.denials.length === 0 ? (
                  <p class="t-small muted">{t.panelNoDenials}</p>
                ) : (
                  <ol class="log" data-testid="panel-denials">
                    {node.denials.map((denial, index) => (
                      <li key={`${denial.at}-${index}`} class="denied">
                        <span class="lt">{formatClock(denial.at, lang)}</span> <span class="lk">{denial.tool}</span>{' '}
                        <span class="ld">
                          {t.denialBy(denial.by)}
                          {denial.target !== undefined && ` · ${targetText(denial.target, labels) ?? ''}`}
                          {denial.reason !== undefined && ` · ${denial.reason}`}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        <ol class="textview" aria-live="polite" aria-label={t.panelTextView} data-testid="panel-text">
          {state.nodes.map((entry) => {
            const target = targetText(entry.current?.target, labels);
            return (
              <li key={entry.id} class={entry.kind === 'main' ? undefined : 'tv-child'}>
                <span class="mono strong">
                  {nodeName(entry, t.panelMain)} · {t.nodeStatus(entry.status)}
                </span>
                <p>
                  {[entry.model, entry.effort].filter((value) => value !== undefined).join(', ')}
                  {entry.model !== undefined || entry.effort !== undefined ? '. ' : ''}
                  {t.panelStarted} {formatClock(entry.startedAt, lang)}, {t.panelDuration.toLowerCase()} {formatDuration(entry.durationMs, lang)}.{' '}
                  {entry.current === undefined ? t.panelNoTool : `${t.panelNow}: ${entry.current.tool}${target === undefined ? '' : ` ${target}`}`}.{' '}
                  {t.panelToolCalls(entry.toolCalls)}
                  {entry.denials.length > 0 ? `, ${t.panelDenialCount(entry.denials.length)}` : ''}.
                  {entry.pending !== undefined ? ` ${t.panelAsks(entry.pending.kind)}.` : ''}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// A finished session

/** A finished (or interrupted) session's panel, rebuilt from its recorded lines. */
export function SessionPanelPage({ id }: { id: string }) {
  const { t } = useApp();
  const loaded = useLoad<{ events: PanelEventInput[]; badLines: number }>(`/api/sessions/${encodeURIComponent(id)}/events`);
  useDocumentTitle(`${t.panelSessionTitle} ${id}`);
  return (
    <>
      <header class="page-head">
        <div class="page-head-text">
          <p class="meta">
            <a class="link" href={routeHash({ page: 'projects' })}>
              ← {t.panelBack}
            </a>
          </p>
          <h1 class="t-1">{t.panelSessionTitle}</h1>
          <p class="meta">
            <span>{id}</span>
          </p>
        </div>
      </header>
      <div class="page">
        <LoadState loaded={loaded}>{({ events, badLines }) => <SessionPanel events={events} badLines={badLines} />}</LoadState>
      </div>
    </>
  );
}

function SessionPanel({ events, badLines }: { events: PanelEventInput[]; badLines: number }) {
  const { t, lang } = useApp();
  const state = usePanelState(events, undefined);
  const current = state.steps.find((item) => item.state === 'running')?.step;
  const position = stepPosition(state.steps, current);
  return (
    <>
      <p class="session-status" data-testid="session-status">
        <span class="strong">{t.panelSessionStatus(state.session.status, state.session.outcome)}</span>
        <span class="meta">
          <span>{formatClock(state.session.startedAt, lang)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatDuration(state.nodes[0]?.durationMs, lang)}</span>
          {state.session.profile !== undefined && (
            <>
              <span aria-hidden="true">·</span>
              <span>{state.session.profile}</span>
            </>
          )}
        </span>
      </p>
      {badLines > 0 && <Note tone="warn">{t.panelBadLines(badLines)}</Note>}
      <section class="card" aria-label={t.progressTitle}>
        <div class="progress">
          {position !== undefined && (
            <div class="progress-top">
              <span class="meta">{t.headStep(position.index, PANEL_STEPS.length)}</span>
            </div>
          )}
          <StepBar steps={state.steps} current={current} />
        </div>
      </section>
      <div class="cols">
        <div class="col-main">
          <AgentPanel state={state} />
        </div>
        <div class="col-side">
          <PlanUsage state={state} finished={state.session.status !== 'running'} />
        </div>
      </div>
    </>
  );
}
