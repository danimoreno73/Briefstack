import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { buildPanelState, type PanelEventInput, type PanelLive, type PanelNode, type PanelState } from '../panel/state.js';
import { Loader } from './common.js';
import { useApp, useLoad } from './hooks.js';
import { formatClock, formatDuration, percent, targetText } from './panelData.js';
import { routeHash } from './route.js';

/**
 * The live agent panel (BRIEF-phase-3 §3). It only reads: the controls that
 * answer the flow stay where phase 2 put them, and a node that asks
 * something links to its control.
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

/** Plan usage at the start and at the latest reading; never tokens or cost. */
export function PlanUsage({ state }: { state: PanelState }) {
  const { t, lang } = useApp();
  return (
    <div class="plan-usage" data-testid="panel-usage">
      <h3>{t.panelUsage}</h3>
      {state.usage.start === undefined ? (
        <p class="muted" role="status">
          {state.usage.reading === true ? t.panelUsageReading : t.panelUsageNone}
        </p>
      ) : (
        <dl>
          <dt>{t.panelUsageStart}</dt>
          <dd>{t.panelUsageLine(percent(state.usage.start.fiveHour), percent(state.usage.start.sevenDay))}</dd>
          {state.usage.now !== undefined && state.usage.now.at !== state.usage.start.at && (
            <>
              <dt>{t.panelUsageNow}</dt>
              <dd>
                {t.panelUsageLine(percent(state.usage.now.fiveHour), percent(state.usage.now.sevenDay))} · {formatClock(state.usage.now.at, lang)}
              </dd>
            </>
          )}
        </dl>
      )}
      <p class="hint">{t.panelUsageHint}</p>
    </div>
  );
}

/**
 * Each fact has one place (audit M15): the card says who, model, time and
 * what it does; the details add only what the card leaves out (denied calls
 * and their reasons); the text view repeats everything for screen readers
 * and copying. Plan usage is shown here unless the page puts it elsewhere.
 */
export function AgentPanel({ state, showPendingLinks = false, showUsage = true }: { state: PanelState; showPendingLinks?: boolean; showUsage?: boolean }) {
  const { t, lang } = useApp();
  const [selected, setSelected] = useState('main');
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

  const card = (item: PanelNode) => {
    const target = targetText(item.current?.target, labels);
    return (
      <div class="agent-card" data-status={item.status} data-kind={item.kind} data-testid={`agent-${item.id}`}>
        <button
          type="button"
          class="agent-select"
          aria-pressed={item.id === node?.id}
          onClick={() => setSelected(item.id)}
          aria-label={`${nodeName(item, t.panelMain)}: ${t.nodeStatus(item.status)}`}
        >
          <span class="agent-name">{nodeName(item, t.panelMain)}</span>
          <span class="node-status" data-testid="node-status">
            {t.nodeStatus(item.status)}
          </span>
        </button>
        <div class="agent-meta muted">
          {[item.model, item.effort, formatClock(item.startedAt, lang), formatDuration(item.durationMs)]
            .filter((value) => value !== undefined)
            .join(' · ')}
        </div>
        <div class="agent-now" data-testid="agent-now">
          {item.current === undefined ? (
            <span class="muted">{t.panelNoTool}</span>
          ) : (
            <>
              <strong>{item.current.tool}</strong>
              {target !== undefined && <span class={item.current.target?.root === 'outside' ? 'target-outside' : 'target'}> {target}</span>}
            </>
          )}
        </div>
        <div class="agent-counts muted">
          {t.panelToolCalls(item.toolCalls)}
          {item.denials.length > 0 && (
            <>
              {' · '}
              <span class="denied-count" data-testid="denial-count">
                {t.panelDenialCount(item.denials.length)}
              </span>
            </>
          )}
        </div>
        {item.pending !== undefined && (
          <div class="agent-pending" data-testid="node-pending">
            {t.panelAsks(item.pending.kind)}
            {showPendingLinks && (
              <>
                {' '}
                <button type="button" class="link-button" onClick={goToControl}>
                  {t.panelGoToControl}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <section class="agent-panel" aria-labelledby="panel-title" data-testid="agent-panel">
      <h2 id="panel-title">{t.panelTitle}</h2>

      <ol class="agent-tree" aria-label={t.panelTitle}>
        {main !== undefined && (
          <li>
            {card(main)}
            {agents.length === 0 ? (
              <p class="muted agent-none">{t.panelNoAgents}</p>
            ) : (
              <ol class="agent-children">
                {agents.map((item) => (
                  <li key={item.id}>{card(item)}</li>
                ))}
              </ol>
            )}
          </li>
        )}
      </ol>

      <h3>{t.panelTimeline}</h3>
      <p class="muted">{t.panelTimelineHint}</p>
      <div class="timeline" data-testid="panel-timeline">
        {state.timeline.rows.map((row) => {
          const item = state.nodes.find((candidate) => candidate.id === row.nodeId);
          if (item === undefined) return null;
          const left = (row.startMs / state.timeline.spanMs) * 100;
          const width = Math.max(0.5, ((row.endMs - row.startMs) / state.timeline.spanMs) * 100);
          return (
            <button
              key={row.nodeId}
              type="button"
              class="timeline-row"
              aria-pressed={item.id === node?.id}
              data-status={item.status}
              data-kind={item.kind}
              onClick={() => setSelected(item.id)}
            >
              <span class="timeline-label">{nodeName(item, t.panelMain)}</span>
              <span class="timeline-track" aria-hidden="true">
                <svg viewBox="0 0 100 10" preserveAspectRatio="none" focusable="false">
                  <rect x={left} y="1" width={Math.min(width, 100 - left)} height="8" rx="1" class={row.open ? 'bar bar-open' : 'bar'} />
                </svg>
              </span>
              {/* The status in words too, not only the bar's colour (audit M13). */}
              <span class="timeline-time muted">
                <span class="timeline-status">{t.nodeStatus(item.status)}</span> · {formatDuration(item.durationMs)}
              </span>
            </button>
          );
        })}
      </div>

      {node !== undefined && (
        <div class="agent-detail" data-testid="panel-detail">
          <h3>
            {t.panelDetail}: {nodeName(node, t.panelMain)}
          </h3>
          <h4>{t.panelDenials}</h4>
          {node.denials.length === 0 ? (
            <p class="muted">{t.panelNoDenials}</p>
          ) : (
            <ul class="denials" data-testid="panel-denials">
              {node.denials.map((denial, index) => (
                <li key={`${denial.at}-${index}`}>
                  <strong>{denial.tool}</strong> {t.denialBy(denial.by)} · {formatClock(denial.at, lang)}
                  {denial.target !== undefined && (
                    <span class={denial.target.root === 'outside' ? 'target-outside' : 'target'}> · {targetText(denial.target, labels)}</span>
                  )}
                  {denial.reason !== undefined && <div class="denial-reason">{denial.reason}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {showUsage && <PlanUsage state={state} />}

      <details class="panel-text">
        <summary>{t.panelTextView}</summary>
        <ul data-testid="panel-text">
          {state.nodes.map((item) => {
            const target = targetText(item.current?.target, labels);
            return (
              <li key={item.id}>
                {nodeName(item, t.panelMain)}: {t.nodeStatus(item.status)}. {t.panelStarted} {formatClock(item.startedAt, lang)}, {t.panelDuration.toLowerCase()}{' '}
                {formatDuration(item.durationMs)}. {item.current === undefined ? t.panelNoTool : `${t.panelNow}: ${item.current.tool}${target === undefined ? '' : ` ${target}`}`}.{' '}
                {t.panelToolCalls(item.toolCalls)}
                {item.denials.length > 0 ? `, ${t.panelDenialCount(item.denials.length)}` : ''}.
                {item.pending !== undefined ? ` ${t.panelAsks(item.pending.kind)}.` : ''}
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}

/** A finished (or interrupted) session's panel, rebuilt from its recorded lines. */
export function SessionPanelPage({ id }: { id: string }) {
  const { t } = useApp();
  const loaded = useLoad<{ events: PanelEventInput[]; badLines: number }>(`/api/sessions/${encodeURIComponent(id)}/events`);
  return (
    <section>
      <p>
        <a href={routeHash({ page: 'projects' })}>← {t.panelBack}</a>
      </p>
      <h1>{t.panelSessionTitle}</h1>
      <p>
        <code>{id}</code>
      </p>
      <Loader loaded={loaded}>
        {({ events, badLines }) => <SessionPanel events={events} badLines={badLines} />}
      </Loader>
    </section>
  );
}

function SessionPanel({ events, badLines }: { events: PanelEventInput[]; badLines: number }) {
  const { t, lang } = useApp();
  const state = usePanelState(events, undefined);
  return (
    <>
      <p data-testid="session-status">
        <strong>{t.panelSessionStatus(state.session.status, state.session.outcome)}</strong> · {formatClock(state.session.startedAt, lang)} ·{' '}
        {formatDuration(state.nodes[0]?.durationMs)}
        {state.session.profile !== undefined && <> · {state.session.profile}</>}
      </p>
      {badLines > 0 && <p class="banner banner-warn">{t.panelBadLines(badLines)}</p>}
      <ol class="steps steps-inline" aria-label={t.progressTitle}>
        {state.steps.map(({ step, state: stepState }) => (
          <li key={step} data-state={stepState}>
            <span class="step-name">{t.stepLabel(step)}</span> <span class="step-state">{t.stepState(stepState)}</span>
          </li>
        ))}
      </ol>
      <AgentPanel state={state} />
    </>
  );
}

