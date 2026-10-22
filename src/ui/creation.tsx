import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { CreationSuggestions } from './improve.js';
import { ApiError, CREATIONS_CHANGED_EVENT, TOKEN_HEADER, noteRejection } from './api.js';
import { answersFor, defaultSelection, type Selection } from './answers.js';
import { CopyButton, ErrorBanner, Loader, Markdown, PathText } from './common.js';
import { formatWhen, openCommandLines, withoutLeadingHeading } from './format.js';
import { useApp, useDocumentTitle, useLoad, useSend } from './hooks.js';
import { IconCheck, IconFolder, IconQuestion, IconReply, IconSpec, IconTerminal } from './icons.js';
import { ConfirmModal, ErrorNote, LoadState, Loading, MetaLine, Note } from './kit.js';
import { AgentPanel, PENDING_CONTROL_ID, PlanUsage, StepBar, stepPosition, usePanelState } from './panel.js';
import { formatClock, formatDuration, liveFromState, panelEventsFromStream, percent } from './panelData.js';
import { STEPS, deriveProgress, parseSse, type Progress } from './progress.js';
import { ReplyBox } from './reply.js';
import { routeHash } from './route.js';
import type { CreationState, Pending, ProjectDetail, ProjectListing, SpecView, StreamEvent, UiQuestion } from './types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Events that mean the creation's state (the pending request, the status) may have changed. */
const changesState = (event: StreamEvent): boolean =>
  event.kind !== 'flow' && event.kind !== 'hook' && event.kind !== 'runner' && event.kind !== 'denied';

// ---------------------------------------------------------------------------
// The page: an idea form, or the creation in progress

export function NewProjectPage({ id }: { id: string | undefined }) {
  if (id !== undefined) return <CreationView key={id} id={id} />;
  return <StartPage />;
}

function StartPage() {
  const { t, lang } = useApp();
  const send = useSend();
  const list = useLoad<{ creations: CreationState[] }>('/api/creations');
  const [idea, setIdea] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [atLimit, setAtLimit] = useState(false);
  useDocumentTitle(t.newTitle);

  // Several creations may run at once: the form stays, with a note that plan usage adds up.
  const running = list.data?.creations.filter((creation) => creation.status !== 'finished').length ?? 0;

  const start = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setAtLimit(false);
    try {
      const { id } = await send<{ id: string }>('POST', '/api/creations', { idea });
      window.location.hash = routeHash({ page: 'new', id });
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'creation.limit') setAtLimit(true);
      else setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h1>{t.newTitle}</h1>
      <form onSubmit={(event) => void start(event)}>
        {error !== undefined && <ErrorBanner error={error} />}
        {atLimit && (
          <p class="banner banner-error" role="alert" data-testid="limit-reached">
            {t.limitMessage} <a href={routeHash({ page: 'creations' })}>{t.creationsOpen}</a>
          </p>
        )}
        {running > 0 && !atLimit && (
          <p class="banner banner-warn" role="status" data-testid="usage-adds-up">
            {t.usageAddsUp(running)} <a href={routeHash({ page: 'creations' })}>{t.creationsOpen}</a>
          </p>
        )}
        <p>
          <label for="idea">{t.ideaLabel}</label>
          <textarea id="idea" rows={6} value={idea} onInput={(event) => setIdea(event.currentTarget.value)} />
          <span class="hint">{t.ideaHint}</span>
        </p>
        <div class="actions">
          <button type="submit" disabled={busy || idea.trim() === ''}>
            {busy ? t.ideaStarting : t.ideaStart}
          </button>
        </div>
      </form>

      <h2>{t.recentTitle}</h2>
      <Loader loaded={list}>
        {({ creations }) => {
          const finished = creations.filter((creation) => creation.status === 'finished').reverse();
          if (finished.length === 0) return <p class="empty">{t.recentEmpty}</p>;
          return (
            <ul>
              {finished.map((creation) => (
                <li key={creation.id}>
                  <a href={routeHash({ page: 'new', id: creation.id })}>{creation.idea.slice(0, 80)}</a>{' '}
                  <span class="muted">
                    · {t.outcome(creation.outcome)} · {formatWhen(creation.finishedAt ?? creation.startedAt, lang)}
                  </span>
                </li>
              ))}
            </ul>
          );
        }}
      </Loader>
    </section>
  );
}

// ---------------------------------------------------------------------------
// One creation

/** The numbered events of a creation, kept up to date, with the state they describe. */
function useCreation(id: string) {
  const { token } = useApp();
  const [state, setState] = useState<CreationState | undefined>(undefined);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(true);
  const [error, setError] = useState<unknown>(undefined);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/creations/${encodeURIComponent(id)}`, { headers: { [TOKEN_HEADER]: token }, credentials: 'omit' });
      const body = (await res.json()) as CreationState & { code?: string; params?: Record<string, unknown> };
      if (!res.ok) throw new ApiError(res.status, body.code ?? 'web.unknown', body.params);
      setState(body);
      setError(undefined);
    } catch (failure) {
      noteRejection(failure);
      setError(failure);
    }
  }, [id, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The stream: from the last numbered event seen, again after any drop. Closing the tab does not
  // affect the creation; on reopening, the whole history is replayed from 0.
  useEffect(() => {
    const abort = new AbortController();
    let last = 0;
    let finished = false;
    setEvents([]);
    void (async () => {
      while (!abort.signal.aborted && !finished) {
        try {
          const res = await fetch(`/api/creations/${encodeURIComponent(id)}/stream?from=${last}`, {
            headers: { [TOKEN_HEADER]: token },
            credentials: 'omit',
            signal: abort.signal,
          });
          if (res.status === 404) return;
          if (!res.ok || res.body === null) throw new Error('stream');
          setConnected(true);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parsed = parseSse(buffer);
            buffer = parsed.rest;
            const batch = parsed.frames
              .map((frame) => JSON.parse(frame.data ?? 'null') as StreamEvent | null)
              .filter((event): event is StreamEvent => event !== null && event.seq > last);
            if (batch.length === 0) continue;
            last = (batch[batch.length - 1] as StreamEvent).seq;
            setEvents((previous) => [...previous, ...batch]);
            if (batch.some(changesState)) void refresh();
            if (batch.some((event) => event.kind === 'status')) window.dispatchEvent(new Event(CREATIONS_CHANGED_EVENT));
            if (batch.some((event) => event.kind === 'status' && event.data.status === 'finished')) finished = true;
          }
        } catch {
          if (abort.signal.aborted) return;
          setConnected(false);
          await sleep(1000);
        }
      }
      if (!abort.signal.aborted) void refresh();
    })();
    return () => abort.abort();
  }, [id, token, refresh]);

  return { state, events, connected, error, refresh };
}

/** Moves to the control that answers the pending request and focuses its first field or button. */
function goToControl(): void {
  const control = document.getElementById(PENDING_CONTROL_ID);
  if (control === null) return;
  control.scrollIntoView({ block: 'start' });
  const first = control.querySelector<HTMLElement>('input, textarea, button, [tabindex]');
  (first ?? control).focus();
}

/** The idea, cut for the line that says which creation a control answers. */
const shortIdea = (idea: string): string => (idea.length > 80 ? `${idea.slice(0, 80)}…` : idea);

function CreationView({ id }: { id: string }) {
  const { t, lang } = useApp();
  const { state, events, connected, error, refresh } = useCreation(id);
  const send = useSend();
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<unknown>(undefined);
  const [stale, setStale] = useState(false);
  // The agent panel reads the same stream: the events.jsonl lines, plus what the state says live.
  const panelEvents = useMemo(() => panelEventsFromStream(events), [events]);
  const live = useMemo(() => (state === undefined ? undefined : liveFromState(state)), [state]);
  const panel = usePanelState(panelEvents, live);
  useDocumentTitle(state?.idea ?? t.creationLabel);

  /** Answers the pending request. A request that is no longer the one shown means the page is stale. */
  const answer = async (pending: Pending, value: unknown): Promise<boolean> => {
    setProblem(undefined);
    setStale(false);
    try {
      await send('POST', `/api/creations/${encodeURIComponent(id)}/answer`, { pendingId: pending.id, answer: value });
      void refresh();
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && (failure.code === 'creation.wrongPending' || failure.code === 'creation.noPending')) {
        setStale(true);
        void refresh();
      } else setProblem(failure);
      return false;
    }
  };

  /** Sends the free-text reply. A session that no longer waits for one means the page is stale. */
  const reply = async (text: string): Promise<boolean> => {
    setProblem(undefined);
    setStale(false);
    try {
      await send('POST', `/api/creations/${encodeURIComponent(id)}/reply`, { text });
      void refresh();
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'creation.noReply') {
        setStale(true);
        void refresh();
      } else setProblem(failure);
      return false;
    }
  };

  const cancel = async () => {
    setAsking(false);
    setProblem(undefined);
    try {
      await send('POST', `/api/creations/${encodeURIComponent(id)}/cancel`);
      void refresh();
    } catch (failure) {
      setProblem(failure);
    }
  };

  if (state === undefined) {
    return (
      <>
        <header class="page-head">
          <div class="page-head-text">
            <p class="meta">
              <a class="link" href={routeHash({ page: 'creations' })}>
                ← {t.allCreations}
              </a>
            </p>
            <h1 class="t-1">{t.creationLabel}</h1>
          </div>
        </header>
        <div class="page">{error === undefined ? <Loading /> : <ErrorNote error={error} />}</div>
      </>
    );
  }

  const progress = deriveProgress(events);
  const finished = state.status === 'finished';
  const { pending } = state;
  const replying = pending === undefined && state.awaitingReply !== undefined && !state.cancelling && !finished;
  // What waits for the user, if anything: a request, or a reply to the session's last message.
  const waitingKind = finished ? undefined : (pending?.kind ?? (replying ? 'reply' : undefined));
  const steps = STEPS.map((step) => ({ step, state: progress.steps[step] }));
  const position = stepPosition(steps, progress.current ?? state.currentStep);
  const stepName = position === undefined ? undefined : t.stepLabel(position.step);
  const usageNow = panel.usage.now ?? panel.usage.start;
  const planLine = usageNow === undefined ? undefined : t.headPlan(percent(usageNow.fiveHour), percent(usageNow.sevenDay));

  return (
    <>
      {/* The creation is named by its idea; its state and Cancel stay in sight while the page scrolls. */}
      <header class="page-head sticky">
        <div class="page-head-text">
          <p class="meta">
            <a class="link" href={routeHash({ page: 'creations' })}>
              ← {t.allCreations}
            </a>
            <span aria-hidden="true">·</span>
            <span>{state.id}</span>
            <span aria-hidden="true">·</span>
            <span>{state.profile}</span>
          </p>
          <h1 class="t-1 creation-title" data-testid="idea">
            {state.idea}
          </h1>
          <div class="head-status">
            <HeadState state={state} waiting={waitingKind !== undefined} stepName={stepName} />
            <MetaLine parts={[position !== undefined && t.headStep(position.index, STEPS.length), t.headSince(formatClock(state.startedAt, lang)), planLine]} />
          </div>
          <p class="t-small muted">{t.policyShown(state.policy)}</p>
        </div>
        <div class="btn-row">
          <CopyButton text={state.id} label={t.copyId} cls="btn btn-secondary d-only" />
          {!finished && (
            <button type="button" class="btn btn-danger" disabled={state.cancelling === true} onClick={() => setAsking(true)}>
              {t.cancelCreation}
            </button>
          )}
        </div>
      </header>

      <div class="page">
        {/* Focus does not jump when something starts waiting: it is announced, with a way to go there. */}
        <p class="sr-only" aria-live="polite">
          {waitingKind === undefined ? '' : t.waitingAnnounce(t.waitingFor(waitingKind))}
        </p>
        {waitingKind !== undefined && (
          <p>
            <button type="button" class="link link-button" onClick={goToControl}>
              {t.goToWaiting}
            </button>
          </p>
        )}
        {!connected && !finished && <Note tone="danger" role="status" title={t.streamLost} />}
        {stale && <Note role="status">{t.answerStale}</Note>}
        {problem !== undefined && <ErrorNote error={problem} />}

        {finished ? (
          <FinishedView state={state} progress={progress} steps={steps} panel={panel} planLine={planLine} />
        ) : (
          <>
            {replying && state.awaitingReply !== undefined ? (
              <section class="dec" id={PENDING_CONTROL_ID} tabIndex={-1} aria-labelledby="reply-title" data-testid="awaiting-reply">
                <DecHead icon={<IconReply />} titleId="reply-title" title={t.awaitingReplyTitle} idea={state.idea} note={t.questionsPaused} request={false} />
                <p role="status">{t.awaitingReplyBody}</p>
                <div class="dec-card">
                  <Markdown text={state.awaitingReply.lastMessage} cls="md" />
                </div>
                <ReplyBox id="creation-reply" onSend={reply} look="bs" />
              </section>
            ) : pending === undefined ? (
              <div class="card card-dash working" role="status" data-testid="working">
                <span class="strong">{state.cancelling ? t.cancellingNote : t.statusWorking}</span>
                <span class="muted">{t.nothingWaiting}</span>
              </div>
            ) : (
              <div id={PENDING_CONTROL_ID} tabIndex={-1} class="pending-control">
                {state.cancelling && <Note role="status">{t.cancellingNote}</Note>}
                <PendingPanel key={pending.id} id={id} idea={state.idea} pending={pending} answer={answer} />
              </div>
            )}

            <section class="card" aria-label={t.progressTitle}>
              <div class="progress">
                <div class="progress-top">
                  <span class="meta">
                    {progress.current !== undefined && (
                      <span data-testid="agents">
                        {t.agentsNow}: {progress.agents.length === 0 ? t.mainSessionWorking : progress.agents.join(', ')}
                      </span>
                    )}
                  </span>
                  {position !== undefined && <span class="meta">{t.headStep(position.index, STEPS.length)}</span>}
                </div>
                <StepBar steps={steps} current={progress.current} />
              </div>
            </section>

            <div class="cols">
              <div class="col-main">
                <AgentPanel state={panel} showPendingLinks title={t.panelLiveTitle} />
              </div>
              <div class="col-side">
                <section class="card" aria-labelledby="result-later-title">
                  <h2 class="t-2" id="result-later-title">
                    {t.resultColumn}
                  </h2>
                  <p class="t-small muted">{t.resultNotYet}</p>
                </section>
                <PlanUsage state={panel} />
              </div>
            </div>
          </>
        )}
      </div>

      {asking && (
        <ConfirmModal
          title={t.cancelTitle}
          body={t.cancelBody}
          confirmLabel={t.cancelCreation}
          cancelLabel={t.cancelKeep}
          onConfirm={() => void cancel()}
          onCancel={() => setAsking(false)}
        />
      )}
    </>
  );
}

/** The state beside the title: cream when the creation waits for the user, the outcome once it ended. */
function HeadState({ state, waiting, stepName }: { state: CreationState; waiting: boolean; stepName: string | undefined }) {
  const { t } = useApp();
  if (state.status === 'finished') {
    const outcome = state.outcome ?? 'interrupted';
    const tone = outcome === 'completed' ? 'chip chip-ok' : outcome === 'cancelled' ? 'chip' : 'chip chip-danger';
    return <span class={tone}>{t.outcome(outcome)}</span>;
  }
  if (waiting) return <span class="chip chip-dec">{stepName === undefined ? t.statusWaiting : t.headWaiting(stepName)}</span>;
  if (state.cancelling)
    return (
      <span class="state st-wait">
        <span class="ring" />
        {t.waitingFor('cancelling')}
      </span>
    );
  return (
    <span class="state st-run">
      <span class="dot pulse" />
      {stepName === undefined ? t.statusWorking : t.headWorking(stepName)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// What the flow asks: the cream blocks

/**
 * The head of a decision block: its icon, its title, which creation it
 * answers and what it holds up. `request` is false for the free-text reply,
 * which answers no pending request.
 */
function DecHead({
  icon,
  titleId,
  title,
  idea,
  note,
  request = true,
}: {
  icon: ComponentChildren;
  titleId: string;
  title: string;
  idea: string;
  note?: string;
  request?: boolean;
}) {
  const { t } = useApp();
  return (
    <div class="dec-head">
      <div class="dec-title">
        <span class="dec-icon">{icon}</span>
        <div class="dec-heading">
          <h2 id={titleId}>{title}</h2>
          {/* Several creations may ask at once: each control says which one it answers. */}
          <p class="meta">
            <span class="pending-for" data-testid={request ? 'pending-for' : undefined}>
              {t.pendingFor(shortIdea(idea))}
            </span>
            {note !== undefined && (
              <>
                <span aria-hidden="true">·</span>
                <span>{note}</span>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

interface PanelProps {
  id: string;
  idea: string;
  pending: Pending;
  answer(pending: Pending, value: unknown): Promise<boolean>;
}

function PendingPanel({ id, idea, pending, answer }: PanelProps) {
  switch (pending.kind) {
    case 'question':
      return <QuestionForm idea={idea} pending={pending} questions={pending.payload.questions} answer={answer} />;
    case 'permission':
      return <PermissionPanel idea={idea} pending={pending} answer={answer} />;
    case 'spec':
      return <SpecApproval id={id} idea={idea} pending={pending} answer={answer} />;
    case 'grant':
      return <GrantPanel idea={idea} pending={pending} answer={answer} />;
  }
}

function QuestionForm({ idea, pending, questions, answer }: { idea: string; pending: Pending; questions: UiQuestion[]; answer: PanelProps['answer'] }) {
  const { t } = useApp();
  const [selections, setSelections] = useState<Selection[]>(() => questions.map(defaultSelection));
  const [busy, setBusy] = useState(false);
  const answers = answersFor(questions, selections);

  const update = (index: number, change: Partial<Selection>) =>
    setSelections((previous) => previous.map((selection, position) => (position === index ? { ...selection, ...change } : selection)));

  const submit = async (event: Event) => {
    event.preventDefault();
    if (answers === undefined) return;
    setBusy(true);
    await answer(pending, answers);
    setBusy(false);
  };

  return (
    <form class="dec" onSubmit={(event) => void submit(event)} aria-labelledby="questions-title">
      <DecHead icon={<IconQuestion />} titleId="questions-title" title={t.questionsTitle} idea={idea} note={t.questionsPaused} />
      <div class="dec-grid">
        {questions.map((question, index) => {
          const selection = selections[index] ?? { picked: [], own: '' };
          return (
            <fieldset key={question.question} class="dec-card">
              <legend>
                {question.header !== '' && <span class="chip chip-mono chip-ink">{question.header}</span>} {question.question}
              </legend>
              <div class="opts">
                {question.options.map((option, position) => {
                  const checked = selection.picked.includes(position);
                  return (
                    <label key={option.label} class="opt">
                      <input
                        class="opt-input"
                        type={question.multiSelect ? 'checkbox' : 'radio'}
                        name={`q${index}`}
                        checked={checked}
                        onChange={() =>
                          update(index, {
                            picked: question.multiSelect
                              ? checked
                                ? selection.picked.filter((item) => item !== position)
                                : [...selection.picked, position]
                              : [position],
                          })
                        }
                      />
                      <span class="opt-text">
                        {option.label}
                        {option.description !== '' && <small>{option.description}</small>}
                      </span>
                      <IconCheck cls="tick" />
                    </label>
                  );
                })}
              </div>
              <div class="field">
                <label class="label" for={`q${index}-own`}>
                  {t.ownAnswer}
                </label>
                <input id={`q${index}-own`} class="input" type="text" value={selection.own} onInput={(event) => update(index, { own: event.currentTarget.value })} />
              </div>
            </fieldset>
          );
        })}
      </div>
      {answers === undefined && <p class="t-small muted">{t.answerEveryQuestion}</p>}
      <div class="btn-row">
        <button type="submit" class="btn btn-primary btn-lg" disabled={busy || answers === undefined}>
          {busy ? t.sending : t.sendAnswers}
        </button>
      </div>
    </form>
  );
}

function PermissionPanel({ idea, pending, answer }: { idea: string; pending: Extract<Pending, { kind: 'permission' }>; answer: PanelProps['answer'] }) {
  const { t } = useApp();
  const [busy, setBusy] = useState(false);
  const decide = async (value: 'allow' | 'deny') => {
    setBusy(true);
    await answer(pending, value);
    setBusy(false);
  };
  return (
    // Not modal: Cancel stays reachable while a request is open.
    <dialog open class="dec dec-dialog" aria-labelledby="permission-title">
      <DecHead icon={<IconTerminal />} titleId="permission-title" title={t.permissionTitle} idea={idea} note={t.permissionBy(pending.payload.agentType)} />
      <div class="field">
        <span class="label">{t.permissionWhat}</span>
        <pre class="request request-lg" data-testid="permission-summary">
          {pending.payload.summary}
        </pre>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-primary btn-lg" disabled={busy} onClick={() => void decide('allow')}>
          {t.allow}
        </button>
        <button type="button" class="btn btn-secondary btn-lg" disabled={busy} onClick={() => void decide('deny')}>
          {t.deny}
        </button>
      </div>
    </dialog>
  );
}

function GrantPanel({ idea, pending, answer }: { idea: string; pending: Extract<Pending, { kind: 'grant' }>; answer: PanelProps['answer'] }) {
  const { t } = useApp();
  const [busy, setBusy] = useState(false);
  const decide = async (value: boolean) => {
    setBusy(true);
    await answer(pending, value);
    setBusy(false);
  };
  return (
    <section class="dec" role="group" aria-labelledby="grant-title">
      <DecHead icon={<IconFolder />} titleId="grant-title" title={t.grantTitle} idea={idea} />
      <div class="field">
        <span class="label">{t.grantFolder}</span>
        <pre class="request request-lg" data-testid="grant-dir">
          {pending.payload.dir}
        </pre>
      </div>
      <p>{t.grantBody(pending.payload.dir)}</p>
      <div class="btn-row">
        <button type="button" class="btn btn-primary btn-lg" disabled={busy} onClick={() => void decide(true)}>
          {t.grantAllow}
        </button>
        <button type="button" class="btn btn-secondary btn-lg" disabled={busy} onClick={() => void decide(false)}>
          {t.grantDeny}
        </button>
      </div>
    </section>
  );
}

function SpecApproval({ id, idea, pending, answer }: { id: string; idea: string; pending: Extract<Pending, { kind: 'spec' }>; answer: PanelProps['answer'] }) {
  const { t } = useApp();
  const spec = useLoad<SpecView>(`/api/creations/${encodeURIComponent(id)}/spec?pending=${encodeURIComponent(pending.id)}`);
  const [changing, setChanging] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const decide = async (value: unknown) => {
    setBusy(true);
    await answer(pending, value);
    setBusy(false);
  };

  return (
    <section class="dec" role="group" aria-labelledby="spec-title">
      <DecHead icon={<IconSpec />} titleId="spec-title" title={t.specTitle} idea={idea} note={t.specWaits} />
      <LoadState loaded={spec}>
        {(view) => (
          <div class="dec-grid dec-grid-wide">
            <div class="dec-card">
              <h3 class="t-3">{t.specSummaryTitle}</h3>
              <div data-testid="spec-summary">{view.summary === null ? <p>{t.specNone}</p> : <Markdown text={view.summary} cls="md" />}</div>
            </div>
            {view.spec !== null && (
              <div class="dec-card">
                <h3 class="t-3">{t.specFieldsTitle}</h3>
                <dl class="kv" data-testid="spec-fields">
                  {view.spec.name !== undefined && (
                    <>
                      <dt>{t.colName}</dt>
                      <dd>{view.spec.name}</dd>
                    </>
                  )}
                  {view.spec.slug !== undefined && (
                    <>
                      <dt>{t.specSlug}</dt>
                      <dd class="mono">{view.spec.slug}</dd>
                    </>
                  )}
                  {view.spec.type !== undefined && (
                    <>
                      <dt>{t.specType}</dt>
                      <dd>{view.spec.type}</dd>
                    </>
                  )}
                  {view.spec.target !== undefined && (
                    <>
                      <dt>{t.colTarget}</dt>
                      <dd class="mono">{view.spec.target}</dd>
                    </>
                  )}
                  {view.spec.targetChosenBy !== undefined && (
                    <>
                      <dt>{t.targetChosenBy}</dt>
                      <dd data-testid="spec-target-chosen-by">{t.chooser(view.spec.targetChosenBy)}</dd>
                    </>
                  )}
                  {view.spec.targetReason !== undefined && (
                    <>
                      <dt>{t.targetReason}</dt>
                      <dd>{view.spec.targetReason}</dd>
                    </>
                  )}
                  {view.spec.profile !== undefined && (
                    <>
                      <dt>{t.colProfile}</dt>
                      <dd>{view.spec.profile}</dd>
                    </>
                  )}
                  {view.spec.language !== undefined && (
                    <>
                      <dt>{t.specLanguage}</dt>
                      <dd>{view.spec.language}</dd>
                    </>
                  )}
                </dl>
              </div>
            )}
          </div>
        )}
      </LoadState>
      {changing && (
        <div class="field">
          <label class="label" for="spec-change">
            {t.changeLabel}
          </label>
          <textarea id="spec-change" class="textarea" rows={3} value={text} onInput={(event) => setText(event.currentTarget.value)} />
        </div>
      )}
      <div class="btn-row">
        {!changing ? (
          <>
            <button type="button" class="btn btn-primary btn-lg" disabled={busy} onClick={() => void decide({ decision: 'approve' })}>
              {t.approve}
            </button>
            <button type="button" class="btn btn-secondary btn-lg" disabled={busy} onClick={() => setChanging(true)}>
              {t.requestChanges}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              class="btn btn-primary btn-lg"
              disabled={busy || text.trim() === ''}
              onClick={() => void decide({ decision: 'change', text: text.trim() })}
            >
              {t.sendChanges}
            </button>
            <button type="button" class="btn btn-secondary btn-lg" disabled={busy} onClick={() => setChanging(false)}>
              {t.back}
            </button>
          </>
        )}
        <button type="button" class="btn btn-danger-quiet btn-lg push-end" disabled={busy} onClick={() => setCancelling(true)}>
          {t.cancelCreation}
        </button>
      </div>
      {cancelling && (
        <ConfirmModal
          title={t.cancelTitle}
          body={t.cancelBody}
          confirmLabel={t.cancelCreation}
          cancelLabel={t.cancelKeep}
          onConfirm={() => {
            setCancelling(false);
            void decide({ decision: 'cancel' });
          }}
          onCancel={() => setCancelling(false)}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The end

function FinishedView({
  state,
  progress,
  steps,
  panel,
  planLine,
}: {
  state: CreationState;
  progress: Progress;
  steps: { step: string; state: Progress['steps'][keyof Progress['steps']] }[];
  panel: ReturnType<typeof usePanelState>;
  planLine: string | undefined;
}) {
  const { t, lang } = useApp();
  const [showAgents, setShowAgents] = useState(false);
  const calls = panel.nodes.reduce((sum, node) => sum + node.toolCalls, 0);
  const denials = panel.nodes.reduce((sum, node) => sum + node.denials.length, 0);
  const done = steps.filter((item) => item.state === 'ok' || item.state === 'skipped').length;

  return (
    <>
      <div class="cols">
        <div class="col-main">
          <Result state={state} />
        </div>
        <div class="col-side">
          <Denied state={state} progress={progress} />
          <div class="legacy legacy-inset">
            <CreationSuggestions creationId={state.id} />
          </div>
        </div>
      </div>

      <section class="card" aria-label={t.progressTitle}>
        <div class="progress">
          <div class="progress-top">
            <MetaLine parts={[state.id, planLine]} />
            <span class="meta">{done === steps.length ? t.progressDone(steps.length) : t.headStep(done, steps.length)}</span>
          </div>
          <StepBar steps={steps} current={undefined} />
        </div>
      </section>

      <div class="cols">
        <section class="card col-main agents-summary" aria-label={t.panelTitle}>
          <span class="strong">{t.agentsSummary(panel.nodes.length, calls, denials, formatDuration(panel.nodes[0]?.durationMs, lang))}</span>
          <button type="button" class="btn btn-secondary btn-sm" aria-expanded={showAgents} aria-controls="finished-agents" onClick={() => setShowAgents(!showAgents)}>
            {showAgents ? t.agentsHide : t.agentsShow}
          </button>
        </section>
        <div class="col-side">
          <PlanUsage state={panel} finished compact />
        </div>
      </div>
      <div id="finished-agents" hidden={!showAgents}>
        <AgentPanel state={panel} />
      </div>
    </>
  );
}

function Result({ state }: { state: CreationState }) {
  const { t } = useApp();
  const outcome = state.outcome ?? 'interrupted';
  const projects = useLoad<{ projects: ProjectListing[] }>('/api/projects');
  // The project this creation made: found through the session id its note records.
  const project =
    outcome !== 'completed' || state.sessionId === undefined ? undefined : projects.data?.projects.find((candidate) => candidate.session === state.sessionId);
  // "Ready" only when there is a project to show; a completed run without one says it finished.
  const headline =
    outcome === 'completed'
      ? project !== undefined
        ? t.resultCompleted
        : t.resultCompletedNoProject
      : outcome === 'cancelled'
        ? t.resultCancelled
        : outcome === 'failed'
          ? t.resultFailed
          : t.resultInterrupted;

  return (
    <section class="card result-card" data-testid="result" data-outcome={outcome} aria-labelledby="result-title">
      <h2 class="t-2" id="result-title">
        {headline}
      </h2>
      {state.error !== undefined && <Note tone="danger">{state.error}</Note>}
      {outcome === 'completed' && (
        <LoadState loaded={projects}>{() => (project === undefined ? <p>{t.resultNoProject}</p> : <ProjectResult project={project} />)}</LoadState>
      )}
      <div class="btn-row">
        <a class="btn btn-secondary" href={routeHash({ page: 'new', id: undefined })}>
          {t.startAnother}
        </a>
      </div>
    </section>
  );
}

/** Where the project is, how to open it and what to do next: the project page's own data. */
function ProjectResult({ project }: { project: ProjectListing }) {
  const { t } = useApp();
  const detail = useLoad<ProjectDetail>(`/api/projects/${encodeURIComponent(project.slug)}`);
  const path = project.status?.path;
  return (
    <div class="result-blocks" data-testid="project-card">
      <p>
        <span class="strong">{project.name}</span>
        {project.status !== undefined && <span class="meta meta-inline"> · {project.status.target}</span>}
      </p>
      {path !== undefined && (
        <div class="result-block">
          <h3 class="t-3">{t.resultWhere}</h3>
          <div class="request request-row">
            <PathText value={path} />
            <CopyButton text={path} label={t.copyPath} cls="btn btn-ghost btn-sm" />
          </div>
        </div>
      )}
      <LoadState loaded={detail}>
        {({ openCommand, nextSteps }) => {
          const commands = openCommand === null ? undefined : openCommandLines(openCommand.cwd, openCommand.command).join('\n');
          return (
            <>
              {commands !== undefined && (
                <div class="result-block">
                  <h3 class="t-3">{t.openInClaude}</h3>
                  <div class="command-row">
                    <pre class="request" data-testid="open-command">
                      {commands}
                    </pre>
                    <CopyButton text={commands} label={t.copyCommand} cls="btn btn-primary" />
                  </div>
                </div>
              )}
              {nextSteps !== null && (
                <div class="result-block">
                  <h3 class="t-3">{t.nextSteps}</h3>
                  <Markdown text={withoutLeadingHeading(nextSteps, t.nextSteps)} cls="md" />
                </div>
              )}
            </>
          );
        }}
      </LoadState>
      <p>
        <a class="link" href={routeHash({ page: 'project', slug: project.slug })}>
          {t.resultOpen}
        </a>
      </p>
    </div>
  );
}

function Denied({ state, progress }: { state: CreationState; progress: Progress }) {
  const { t, lang } = useApp();
  const denied = [
    ...state.denied.map((request) => ({ ...request, why: t.deniedPolicy })),
    ...progress.runnerDenials.map((request) => ({ ...request, why: request.reason ?? t.deniedGuard })),
  ];
  return (
    <section class="card" aria-labelledby="denied-title">
      <h2 class="t-2" id="denied-title">
        {t.deniedTitle} ({denied.length})
      </h2>
      {denied.length === 0 ? (
        <p class="t-small muted">{t.deniedNone}</p>
      ) : (
        <ul class="denied-list" data-testid="denied">
          {denied.map((request, index) => (
            <li key={`${request.at}-${index}`}>
              <span class="mono deny">× {request.summary}</span>
              <span class="t-small muted">
                {request.agentType === undefined ? '' : `${request.agentType} · `}
                {formatWhen(request.at, lang)} · {request.why}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
