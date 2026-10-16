import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { ApiError, TOKEN_HEADER } from './api.js';
import { answersFor, defaultSelection, type Selection } from './answers.js';
import { ConfirmDialog, CopyButton, ErrorBanner, Loader, Markdown, Notice } from './common.js';
import { formatWhen } from './format.js';
import { useApp, useLoad, useSend } from './hooks.js';
import { AgentPanel, PENDING_CONTROL_ID, usePanelState } from './panel.js';
import { liveFromState, panelEventsFromStream } from './panelData.js';
import { STEPS, deriveProgress, parseSse, type Progress } from './progress.js';
import { routeHash } from './route.js';
import type { CreationState, Pending, ProjectListing, SpecView, StreamEvent, UiQuestion } from './types.js';

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
  const [active, setActive] = useState<string | undefined>(undefined);

  const running = list.data?.creations.find((creation) => creation.status !== 'finished');
  // Reopening the app: the creation in progress is shown, not a blank form.
  useEffect(() => {
    if (running !== undefined) window.location.replace(routeHash({ page: 'new', id: running.id }));
  }, [running?.id]);

  const start = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setActive(undefined);
    try {
      const { id } = await send<{ id: string }>('POST', '/api/creations', { idea });
      window.location.hash = routeHash({ page: 'new', id });
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'creation.busy') setActive(String(failure.params.active));
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
        {active !== undefined && (
          <p class="banner banner-error" role="alert">
            {t.busyMessage} <a href={routeHash({ page: 'new', id: active })}>{t.busyOpen}</a>
          </p>
        )}
        <p>
          <label for="idea">{t.ideaLabel}</label>
          <textarea id="idea" rows={6} value={idea} onInput={(event) => setIdea(event.currentTarget.value)} />
          <span class="muted">{t.ideaHint}</span>
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
          if (finished.length === 0) return <p>{t.recentEmpty}</p>;
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

function CreationView({ id }: { id: string }) {
  const { t } = useApp();
  const { state, events, connected, error, refresh } = useCreation(id);
  const send = useSend();
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<unknown>(undefined);
  const [stale, setStale] = useState(false);
  // The agent panel reads the same stream: the events.jsonl lines, plus what the state says live.
  const panelEvents = useMemo(() => panelEventsFromStream(events), [events]);
  const live = useMemo(() => (state === undefined ? undefined : liveFromState(state)), [state]);
  const panel = usePanelState(panelEvents, live);

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
      <section>
        <h1>{t.newTitle}</h1>
        {error === undefined ? <p role="status">{t.loading}</p> : <ErrorBanner error={error} />}
      </section>
    );
  }

  const progress = deriveProgress(events);
  const finished = state.status === 'finished';
  const { pending } = state;

  return (
    <section>
      <h1>{t.newTitle}</h1>
      <p class="idea" data-testid="idea">
        {state.idea}
      </p>
      <p class="muted">{t.policyShown(state.policy)}</p>
      {!connected && !finished && (
        <p class="banner banner-error" role="status">
          {t.streamLost}
        </p>
      )}
      {stale && <Notice>{t.answerStale}</Notice>}
      {problem !== undefined && <ErrorBanner error={problem} />}

      <div class="creation">
        <ProgressList progress={progress} />
        <div class="creation-main">
          {finished ? (
            <Result state={state} progress={progress} />
          ) : pending === undefined && state.awaitingReply !== undefined && !state.cancelling ? (
            <div class="panel" data-testid="awaiting-reply">
              <h2>{t.awaitingReplyTitle}</h2>
              <p role="status">{t.awaitingReplyBody}</p>
              <Markdown text={state.awaitingReply.lastMessage} />
            </div>
          ) : pending === undefined ? (
            <p role="status" data-testid="working">
              {state.cancelling ? t.cancellingNote : t.statusWorking}
            </p>
          ) : (
            <div id={PENDING_CONTROL_ID} tabIndex={-1}>
              {state.cancelling && <p role="status">{t.cancellingNote}</p>}
              <PendingPanel key={pending.id} id={id} pending={pending} answer={answer} />
            </div>
          )}
          <AgentPanel state={panel} showPendingLinks={!finished} />
        </div>
      </div>

      {!finished && (
        <div class="actions">
          <button type="button" class="danger" disabled={state.cancelling === true} onClick={() => setAsking(true)}>
            {t.cancelCreation}
          </button>
        </div>
      )}
      {asking && (
        <ConfirmDialog
          title={t.cancelTitle}
          body={t.cancelBody}
          confirmLabel={t.cancelCreation}
          cancelLabel={t.cancelKeep}
          onConfirm={() => void cancel()}
          onCancel={() => setAsking(false)}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Progress

function ProgressList({ progress }: { progress: Progress }) {
  const { t } = useApp();
  return (
    <div class="creation-progress">
      <h2>{t.progressTitle}</h2>
      <ol class="steps" aria-label={t.progressTitle} data-testid="progress">
        {STEPS.map((step) => (
          <li key={step} data-state={progress.steps[step]} aria-current={progress.current === step ? 'step' : undefined}>
            <span class="step-name">{t.stepLabel(step)}</span> <span class="step-state">{t.stepState(progress.steps[step])}</span>
          </li>
        ))}
      </ol>
      {progress.current !== undefined && (
        <p data-testid="agents">
          {t.agentsNow}: {progress.agents.length === 0 ? t.mainSessionWorking : progress.agents.join(', ')}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// What the flow asks

interface PanelProps {
  id: string;
  pending: Pending;
  answer(pending: Pending, value: unknown): Promise<boolean>;
}

function PendingPanel({ id, pending, answer }: PanelProps) {
  switch (pending.kind) {
    case 'question':
      return <QuestionForm pending={pending} questions={pending.payload.questions} answer={answer} />;
    case 'permission':
      return <PermissionPanel pending={pending} answer={answer} />;
    case 'spec':
      return <SpecApproval id={id} pending={pending} answer={answer} />;
    case 'grant':
      return <GrantPanel pending={pending} answer={answer} />;
  }
}

function QuestionForm({ pending, questions, answer }: { pending: Pending; questions: UiQuestion[]; answer: PanelProps['answer'] }) {
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
    <form class="panel" onSubmit={(event) => void submit(event)} aria-labelledby="questions-title">
      <h2 id="questions-title">{t.questionsTitle}</h2>
      {questions.map((question, index) => {
        const selection = selections[index] ?? { picked: [], own: '' };
        return (
          <fieldset key={question.question}>
            <legend>
              {question.header !== '' && <span class="chip">{question.header}</span>} {question.question}
            </legend>
            {question.options.map((option, position) => {
              const checked = selection.picked.includes(position);
              return (
                <label key={option.label} class="option">
                  <input
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
                  />{' '}
                  <strong>{option.label}</strong>
                  {option.description !== '' && <span class="muted"> — {option.description}</span>}
                </label>
              );
            })}
            <label class="own">
              {t.ownAnswer}
              <input type="text" value={selection.own} onInput={(event) => update(index, { own: event.currentTarget.value })} />
            </label>
          </fieldset>
        );
      })}
      {answers === undefined && <p class="muted">{t.answerEveryQuestion}</p>}
      <div class="actions">
        <button type="submit" disabled={busy || answers === undefined}>
          {busy ? t.sending : t.sendAnswers}
        </button>
      </div>
    </form>
  );
}

function PermissionPanel({ pending, answer }: { pending: Extract<Pending, { kind: 'permission' }>; answer: PanelProps['answer'] }) {
  const { t } = useApp();
  const [busy, setBusy] = useState(false);
  const decide = async (value: 'allow' | 'deny') => {
    setBusy(true);
    await answer(pending, value);
    setBusy(false);
  };
  return (
    // Not modal: Cancel stays reachable while a request is open.
    <dialog open class="panel permission" aria-labelledby="permission-title">
      <h2 id="permission-title">{t.permissionTitle}</h2>
      <p>{t.permissionBy(pending.payload.agentType)}</p>
      <p>{t.permissionWhat}</p>
      <pre data-testid="permission-summary">{pending.payload.summary}</pre>
      <div class="actions">
        <button type="button" disabled={busy} onClick={() => void decide('allow')}>
          {t.allow}
        </button>
        <button type="button" class="danger" disabled={busy} onClick={() => void decide('deny')}>
          {t.deny}
        </button>
      </div>
    </dialog>
  );
}

function GrantPanel({ pending, answer }: { pending: Extract<Pending, { kind: 'grant' }>; answer: PanelProps['answer'] }) {
  const { t } = useApp();
  const [busy, setBusy] = useState(false);
  const decide = async (value: boolean) => {
    setBusy(true);
    await answer(pending, value);
    setBusy(false);
  };
  return (
    <div class="panel" role="group" aria-labelledby="grant-title">
      <h2 id="grant-title">{t.grantTitle}</h2>
      <p>{t.grantBody(pending.payload.dir)}</p>
      <p>
        <code data-testid="grant-dir">{pending.payload.dir}</code>
      </p>
      <div class="actions">
        <button type="button" disabled={busy} onClick={() => void decide(true)}>
          {t.grantAllow}
        </button>
        <button type="button" class="danger" disabled={busy} onClick={() => void decide(false)}>
          {t.grantDeny}
        </button>
      </div>
    </div>
  );
}

function SpecApproval({ id, pending, answer }: { id: string; pending: Extract<Pending, { kind: 'spec' }>; answer: PanelProps['answer'] }) {
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
    <div class="panel" role="group" aria-labelledby="spec-title">
      <h2 id="spec-title">{t.specTitle}</h2>
      <Loader loaded={spec}>
        {(view) => (
          <>
            {view.spec !== null && (
              <dl data-testid="spec-fields">
                {view.spec.name !== undefined && (
                  <>
                    <dt>{t.colName}</dt>
                    <dd>{view.spec.name}</dd>
                  </>
                )}
                {view.spec.slug !== undefined && (
                  <>
                    <dt>{t.specSlug}</dt>
                    <dd>{view.spec.slug}</dd>
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
                    <dd>{view.spec.target}</dd>
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
            )}
            <div data-testid="spec-summary">{view.summary === null ? <p>{t.specNone}</p> : <Markdown text={view.summary} />}</div>
          </>
        )}
      </Loader>
      {changing && (
        <p>
          <label for="spec-change">{t.changeLabel}</label>
          <textarea id="spec-change" rows={4} value={text} onInput={(event) => setText(event.currentTarget.value)} />
        </p>
      )}
      <div class="actions">
        {!changing ? (
          <>
            <button type="button" disabled={busy} onClick={() => void decide({ decision: 'approve' })}>
              {t.approve}
            </button>
            <button type="button" disabled={busy} onClick={() => setChanging(true)}>
              {t.requestChanges}
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={busy || text.trim() === ''} onClick={() => void decide({ decision: 'change', text: text.trim() })}>
              {t.sendChanges}
            </button>
            <button type="button" disabled={busy} onClick={() => setChanging(false)}>
              {t.back}
            </button>
          </>
        )}
        <button type="button" class="danger" disabled={busy} onClick={() => setCancelling(true)}>
          {t.cancelCreation}
        </button>
      </div>
      {cancelling && (
        <ConfirmDialog
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// The end

function Result({ state, progress }: { state: CreationState; progress: Progress }) {
  const { t, lang } = useApp();
  const outcome = state.outcome ?? 'interrupted';
  const headline =
    outcome === 'completed'
      ? t.resultCompleted
      : outcome === 'cancelled'
        ? t.resultCancelled
        : outcome === 'failed'
          ? t.resultFailed
          : t.resultInterrupted;
  const denied = [
    ...state.denied.map((request) => ({ ...request, why: t.deniedPolicy })),
    ...progress.runnerDenials.map((request) => ({ ...request, why: request.reason ?? t.deniedGuard })),
  ];

  return (
    <div class="panel result" data-testid="result" data-outcome={outcome}>
      <h2>{headline}</h2>
      {state.error !== undefined && <p class="banner banner-error">{state.error}</p>}
      {outcome === 'completed' && <ProjectCard sessionId={state.sessionId} />}

      <h3>{t.deniedTitle}</h3>
      {denied.length === 0 ? (
        <p>{t.deniedNone}</p>
      ) : (
        <ul data-testid="denied">
          {denied.map((request, index) => (
            <li key={`${request.at}-${index}`}>
              <code>{request.summary}</code>
              <br />
              <span class="muted">
                {request.agentType === undefined ? '' : `${request.agentType} · `}
                {formatWhen(request.at, lang)} · {request.why}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div class="actions">
        <a href={routeHash({ page: 'new', id: undefined })}>{t.startAnother}</a>
      </div>
    </div>
  );
}

/** The project this creation made: found through the session id its note records. */
function ProjectCard({ sessionId }: { sessionId: string | undefined }) {
  const { t } = useApp();
  const projects = useLoad<{ projects: ProjectListing[] }>('/api/projects');
  return (
    <Loader loaded={projects}>
      {({ projects: all }) => {
        const project = sessionId === undefined ? undefined : all.find((candidate) => candidate.session === sessionId);
        if (project === undefined) return <p>{t.resultNoProject}</p>;
        return (
          <div data-testid="project-card">
            <h3>{t.resultProject}</h3>
            <p>
              <strong>{project.name}</strong>
              {project.status !== undefined && <span class="muted"> · {project.status.target}</span>}
            </p>
            {project.status !== undefined && (
              <p>
                <code class="path">{project.status.path}</code> <CopyButton text={project.status.path} label={t.copyPath} />
              </p>
            )}
            <p>{t.resultNextSteps}</p>
            <p>
              <a href={routeHash({ page: 'project', slug: project.slug })}>{t.resultOpen}</a>
            </p>
          </div>
        );
      }}
    </Loader>
  );
}
