import { useEffect, useState } from 'preact/hooks';
import { diffRows } from './diffLines.js';
import { formatWhen } from './format.js';
import { useApp, useDocumentTitle, useLoad, useSend } from './hooks.js';
import { IconAlert, IconCheck, IconCross } from './icons.js';
import { ConfirmModal, ErrorNote, LoadState, Note } from './kit.js';
import { formatDuration } from './panelData.js';
import { routeHash } from './route.js';
import type { DiffHunkView, ImproveOverview, ProposalDetail, ProposalPage, SuggestionView, UsageView } from './types.js';

/**
 * Improvements of the creation flow (BRIEF-phase-5 §3.3–§3.5): suggestions,
 * proposals and the applied history, and one proposal's page, the only place
 * where an improvement is approved, discarded or reverted. On bs.css (U5).
 */

const LIVE = new Set(['preparing', 'verifying', 'waiting', 'revertWaiting']);

/** Statuses with something to decide: approve, ask for changes, discard or revert (the same rules as `Actions`). */
const DECIDABLE = new Set(['ready', 'rejected', 'failed', 'preparing', 'waiting', 'applied']);

/** Reloads every `ms` while `active` holds. */
function usePoll(reload: () => void, active: boolean, ms = 2000): void {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(reload, ms);
    return () => clearInterval(timer);
  }, [reload, active, ms]);
}

/**
 * A diff with line numbers, as the proposal page and the chat's note-change
 * card show one. `file` adds the header with the path and the counts. Each
 * line also says `data-op`, so tests need no styling class.
 */
export function Diff({ hunks, testId, file }: { hunks: readonly DiffHunkView[]; testId?: string; file?: { path: string; added: number; removed: number } }) {
  const { t } = useApp();
  return (
    <div class="diff" data-testid={testId}>
      {file !== undefined && (
        <div class="diff-file">
          <span class="diff-path">{file.path}</span>
          <span class="diff-stat" aria-label={t.cardNoteCounts(file.added, file.removed)}>
            <span class="a">+{file.added}</span>
            <span class="d">−{file.removed}</span>
          </span>
        </div>
      )}
      <div class="diff-lines">
        {diffRows(hunks).map((row, index) =>
          row.kind === 'gap' ? (
            <div key={index} class="dl dl-hunk">
              <span class="ln" />
              <span class="sg" />
              <span>{t.cardSkipped(row.count)}</span>
            </div>
          ) : (
            <div key={index} class={row.op === '+' ? 'dl dl-add' : row.op === '-' ? 'dl dl-del' : 'dl'} data-op={row.op}>
              <span class="ln">{row.number}</span>
              <span class="sg">{row.op === '-' ? '−' : row.op}</span>
              <span>{row.text}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/** The form that asks for an improvement. Starts the session only when sent. */
export function PrepareForm({ initial, suggestionId, lessons: lessonsDefault = false, onCancel }: { initial: string; suggestionId?: string; lessons?: boolean; onCancel?: () => void }) {
  const { t } = useApp();
  const send = useSend();
  const usage = useLoad<UsageView>('/api/usage');
  const [request, setRequest] = useState(initial);
  const [lessons, setLessons] = useState(lessonsDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const id = `improve-request-${suggestionId ?? 'new'}`;
  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { proposal } = await send<{ proposal: { id: string } }>('POST', '/api/improve/proposals', {
        request,
        lessons,
        ...(suggestionId === undefined ? {} : { suggestionId }),
      });
      window.location.hash = routeHash({ page: 'improve', id: proposal.id });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="stack-4" onSubmit={(event) => void submit(event)} data-testid="prepare-form">
      <div class="field">
        <label class="label" for={id}>
          {t.improveRequestLabel}
        </label>
        <textarea
          id={id}
          class="textarea"
          rows={4}
          value={request}
          maxLength={10_000}
          onInput={(event) => setRequest((event.target as HTMLTextAreaElement).value)}
          required
        />
      </div>
      <label class="check-line">
        <input type="checkbox" checked={lessons} onChange={(event) => setLessons((event.target as HTMLInputElement).checked)} /> {t.improveLessonsLabel}
      </label>
      <p class="help">{t.improveUsesPlan(usage.data?.sessionModel ?? '…')}</p>
      {error !== undefined && <ErrorNote error={error} />}
      <div class="btn-row">
        <button type="submit" class="btn btn-primary" disabled={busy || request.trim() === ''}>
          {t.improvePrepareButton}
        </button>
        {onCancel !== undefined && (
          <button type="button" class="btn btn-secondary" onClick={onCancel}>
            {t.cancel}
          </button>
        )}
      </div>
    </form>
  );
}

/** Suggestions, each with a way to ask for it to be prepared. Used on the improvements page, the result screen and the chat. */
export function SuggestionList({ suggestions }: { suggestions: readonly SuggestionView[] }) {
  const { t } = useApp();
  const [open, setOpen] = useState<string | undefined>(undefined);
  return (
    <ul class="suggestion-list" data-testid="suggestions">
      {suggestions.map((s) => {
        const text = t.suggestionText(s.kind, s.params, s.target);
        return (
          <li key={s.id} class="suggestion" data-testid="suggestion" data-kind={s.kind}>
            <p class="strong">{text}</p>
            <p class="t-small muted">{t.suggestionFrom(s.idea)}</p>
            {s.proposalId !== undefined ? (
              <p class="t-small">
                {t.suggestionPrepared}{' '}
                <a class="link" href={routeHash({ page: 'improve', id: s.proposalId })}>
                  {s.proposalId}
                </a>
              </p>
            ) : open === s.id ? (
              <PrepareForm initial={t.suggestionRequest(s.kind, text)} suggestionId={s.id} lessons={s.kind === 'lessons'} onCancel={() => setOpen(undefined)} />
            ) : (
              <div class="btn-row">
                <button type="button" class="btn btn-secondary btn-sm" onClick={() => setOpen(s.id)}>
                  {t.suggestionPrepare}
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A proposal's status in words, coloured by what it means: cream when it waits for the user's decision. */
function StatusMark({ status }: { status: string }) {
  const { t } = useApp();
  const word = t.proposalStatus(status);
  if (status === 'ready') return <span class="chip chip-dec">{word}</span>;
  if (status === 'preparing' || status === 'verifying')
    return (
      <span class="state st-run">
        <span class="dot pulse" />
        {word}
      </span>
    );
  if (status === 'applied') return <span class="chip chip-ok">{word}</span>;
  if (status === 'failed' || status === 'rejected') return <span class="chip chip-danger">{word}</span>;
  if (status === 'discarded') return <span class="state st-cancel">{word}</span>;
  return <span class="chip chip-outline">{word}</span>;
}

function ProposalTable({ proposals, testId }: { proposals: ImproveOverview['proposals']; testId: string }) {
  const { t, lang } = useApp();
  return (
    <div class="table-card">
      <table class="table" data-testid={testId}>
        <thead>
          <tr>
            <th scope="col">{t.colRequest}</th>
            <th scope="col">{t.colStatus}</th>
            <th scope="col">{t.colFiles}</th>
            <th scope="col" class="th-num">
              {t.colUpdated}
            </th>
            <th scope="col">
              <span class="sr-only">{t.openProposal}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {proposals.map((p) => (
            <tr key={p.id} data-proposal={p.id}>
              <td>{p.title ?? p.request.slice(0, 120)}</td>
              <td data-testid="proposal-row-status">
                <StatusMark status={p.status} />
              </td>
              <td class="td-mono td-path">{p.files.join(', ')}</td>
              <td class="td-mono td-num">{formatWhen(p.updatedAt, lang)}</td>
              <td>
                <a class="link" href={routeHash({ page: 'improve', id: p.id })}>
                  {t.openProposal}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Overview() {
  const { t } = useApp();
  const loaded = useLoad<ImproveOverview>('/api/improve');
  usePoll(loaded.reload, true, 3000);
  useDocumentTitle(t.improveTitle);
  return (
    <>
      <header class="page-head">
        <div class="page-head-text">
          <h1 class="t-1">{t.improveTitle}</h1>
          <p class="lead">{t.improveIntro}</p>
        </div>
        <div class="btn-row">
          <button type="button" class="btn btn-secondary" onClick={() => document.getElementById('improve-request-new')?.focus()}>
            {t.improveAsk}
          </button>
        </div>
      </header>
      <div class="page page-roomy">
        <LoadState loaded={loaded}>
          {(data) => {
            const applied = data.proposals.filter((p) => p.status === 'applied' || p.status === 'reverted' || p.status === 'revertWaiting');
            const open = data.proposals.filter((p) => !applied.includes(p));
            return (
              <>
                {data.active !== undefined && (
                  <Note tone="ok" role="status">
                    {t.improveRunning}{' '}
                    <a class="link" href={routeHash({ page: 'improve', id: data.active })}>
                      {data.active}
                    </a>
                  </Note>
                )}
                {/* What waits for a decision first, then what could be asked, then the record (audit L12). */}
                <section class="stack-4" aria-labelledby="proposals-title">
                  <h2 class="section-title" id="proposals-title">
                    {t.improveProposals}
                  </h2>
                  {open.length === 0 ? <p class="muted">{t.improveNoProposals}</p> : <ProposalTable proposals={open} testId="proposals" />}
                </section>
                <section class="stack-4" aria-labelledby="suggestions-title">
                  <h2 class="section-title" id="suggestions-title">
                    {t.improveSuggestions}
                  </h2>
                  {data.suggestions.length === 0 ? (
                    <p class="muted">{t.improveNoSuggestions}</p>
                  ) : (
                    <div class="card">
                      <SuggestionList suggestions={data.suggestions} />
                    </div>
                  )}
                </section>
                <section class="card" aria-labelledby="prepare-title">
                  <h2 class="t-2" id="prepare-title">
                    {t.improvePrepareTitle}
                  </h2>
                  <PrepareForm initial="" />
                </section>
                <section class="stack-4" aria-labelledby="history-title">
                  <h2 class="section-title" id="history-title">
                    {t.improveHistory}
                  </h2>
                  {applied.length === 0 ? <p class="muted">{t.improveNoHistory}</p> : <ProposalTable proposals={applied} testId="history" />}
                </section>
              </>
            );
          }}
        </LoadState>
      </div>
    </>
  );
}

type Pending = 'approve' | 'discard' | 'revert' | undefined;

function Actions({ proposal, check, reload }: { proposal: ProposalDetail; check: ProposalPage['check']; reload: () => void }) {
  const { t, lang } = useApp();
  const send = useSend();
  const [confirm, setConfirm] = useState<Pending>(undefined);
  const [changes, setChanges] = useState<string | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const base = `/api/improve/proposals/${encodeURIComponent(proposal.id)}`;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
      setConfirm(undefined);
      reload();
    }
  };
  const canChange = ['ready', 'rejected', 'failed'].includes(proposal.status);
  const canDiscard = canChange || proposal.status === 'preparing' || proposal.status === 'waiting';
  const dialogs = {
    approve: { title: t.proposalApproveTitle, body: t.proposalApproveBody, label: t.proposalApprove, path: 'approve', tone: 'normal' },
    discard: { title: t.proposalDiscardTitle, body: t.proposalDiscardBody, label: t.proposalDiscard, path: 'discard', tone: 'danger' },
    revert: { title: t.proposalRevertTitle, body: t.proposalRevertBody, label: t.proposalRevert, path: 'revert', tone: 'danger' },
  } as const;
  return (
    <>
      {error !== undefined && <ErrorNote error={error} />}
      {check !== undefined && proposal.status === 'ready' && proposal.realCheck?.state !== 'running' && (
        <div class="dec-card" data-testid="real-check-offer">
          <h3 class="t-3">{t.proposalCheckTitle(check.name)}</h3>
          <p class="t-small muted">{check.cost[lang]}</p>
          <div class="btn-row">
            <button type="button" class="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run(() => send('POST', `${base}/check`))}>
              {t.proposalCheck}
            </button>
          </div>
        </div>
      )}
      {changes !== undefined && (
        <form
          class="stack-4"
          data-testid="changes-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => send('POST', `${base}/changes`, { text: changes })).then(() => setChanges(undefined));
          }}
        >
          <div class="field">
            <label class="label" for="proposal-changes">
              {t.proposalChangesLabel}
            </label>
            <textarea
              id="proposal-changes"
              class="textarea"
              rows={3}
              value={changes}
              maxLength={10_000}
              onInput={(event) => setChanges((event.target as HTMLTextAreaElement).value)}
              required
            />
          </div>
          <div class="btn-row">
            <button type="submit" class="btn btn-primary" disabled={busy || changes.trim() === ''}>
              {t.proposalSendChanges}
            </button>
            <button type="button" class="btn btn-secondary" onClick={() => setChanges(undefined)}>
              {t.cancel}
            </button>
          </div>
        </form>
      )}
      {changes === undefined && (
        <div class="btn-row">
          {proposal.status === 'ready' && (
            <button type="button" class="btn btn-primary btn-lg" disabled={busy} data-testid="approve" onClick={() => setConfirm('approve')}>
              {t.proposalApprove}
            </button>
          )}
          {canChange && (
            <button type="button" class="btn btn-secondary btn-lg" disabled={busy} data-testid="ask-changes" onClick={() => setChanges('')}>
              {t.proposalAskChanges}
            </button>
          )}
          {canDiscard && (
            <button type="button" class="btn btn-danger-quiet btn-lg push-end" disabled={busy} data-testid="discard" onClick={() => setConfirm('discard')}>
              {t.proposalDiscard}
            </button>
          )}
          {proposal.status === 'applied' && (
            <button type="button" class="btn btn-danger-quiet btn-lg" disabled={busy} data-testid="revert" onClick={() => setConfirm('revert')}>
              {t.proposalRevert}
            </button>
          )}
        </div>
      )}
      {confirm !== undefined && (
        <ConfirmModal
          title={dialogs[confirm].title}
          body={dialogs[confirm].body}
          confirmLabel={dialogs[confirm].label}
          cancelLabel={t.cancel}
          tone={dialogs[confirm].tone}
          onCancel={() => setConfirm(undefined)}
          onConfirm={() =>
            void run(() =>
              // Approving names the round this page shows, so a round checked since is not approved unseen.
              confirm === 'approve' ? send('POST', `${base}/approve`, { head: proposal.head ?? '' }) : send('POST', `${base}/${dialogs[confirm].path}`),
            )
          }
        />
      )}
    </>
  );
}

function StatusLine({ proposal, blockers }: { proposal: ProposalDetail; blockers: readonly string[] }) {
  const { t } = useApp();
  const short = (commit: string | undefined) => (commit ?? '').slice(0, 10);
  const text =
    proposal.status === 'preparing'
      ? t.proposalPreparing
      : proposal.status === 'verifying'
        ? t.proposalVerifying
        : proposal.status === 'waiting'
          ? t.proposalWaiting(blockers.join(', ') || '…')
          : proposal.status === 'revertWaiting'
            ? t.proposalRevertWaitingText(blockers.join(', ') || '…')
            : proposal.status === 'applied'
              ? t.proposalApplied(short(proposal.appliedCommit))
              : proposal.status === 'reverted'
                ? t.proposalReverted(short(proposal.revertCommit))
                : proposal.status === 'discarded'
                  ? t.proposalDiscarded
                  : undefined;
  return (
    <p class="head-status" data-testid="proposal-status" data-status={proposal.status}>
      <StatusMark status={proposal.status} />
      {text !== undefined && <span class="t-small muted">{text}</span>}
    </p>
  );
}

/**
 * One proposal, in the order a decision needs (audit H4, M17): what was
 * asked, the changes, the checks on them, the safety notice right before the
 * decision (LEEME), then the decision; how it was prepared sits beside.
 */
function ProposalBody({ page, reload }: { page: ProposalPage; reload: () => void }) {
  const { t, lang } = useApp();
  const { proposal, blockers } = page;
  return (
    <>
      <header class="page-head">
        <div class="page-head-text">
          <p class="meta">
            <a class="link" href={routeHash({ page: 'improve', id: undefined })}>
              ← {t.improveTitle}
            </a>
            <span aria-hidden="true">·</span>
            <span>{proposal.id}</span>
          </p>
          <h1 class="t-1">{proposal.title ?? t.proposalHeading(proposal.id)}</h1>
          <StatusLine proposal={proposal} blockers={blockers} />
        </div>
      </header>
      <div class="page">
        {proposal.error !== undefined && (
          <Note tone="danger" role="alert" testId="proposal-error">
            {proposal.error}
          </Note>
        )}
        <div class="cols">
          <div class="col-main">
            <section class="card" aria-labelledby="request-title">
              <h2 class="t-2" id="request-title">
                {t.proposalRequest}
              </h2>
              <p class="t-body quote" data-testid="proposal-request">
                {proposal.request}
              </p>
              {proposal.expectedEffect !== undefined && (
                <>
                  <h3 class="t-3">{t.proposalExpected}</h3>
                  <p data-testid="proposal-expected">{proposal.expectedEffect}</p>
                </>
              )}
            </section>

            <section class="stack-4" aria-labelledby="changes-title">
              <h2 class="section-title" id="changes-title">
                {t.proposalChanges}
              </h2>
              {proposal.files.length === 0 && <p class="muted">{t.proposalNoChanges}</p>}
              {proposal.files.map((file) => (
                <div key={file.path} class="stack-2" data-testid="proposal-file" data-path={file.path}>
                  {file.rationale !== undefined && (
                    <p>
                      <span class="strong">{t.proposalRationale}</span> {file.rationale}
                      {file.evidence !== undefined && file.evidence.length > 0 && <span class="muted"> ({file.evidence.join(', ')})</span>}
                    </p>
                  )}
                  <Diff hunks={file.hunks} testId="proposal-diff" file={{ path: file.path, added: file.added, removed: file.removed }} />
                </div>
              ))}
            </section>

            <section class="card" aria-labelledby="checks-title">
              <h2 class="t-2" id="checks-title">
                {t.proposalChecks}
              </h2>
              <h3 class="t-3">{t.proposalValidation}</h3>
              {proposal.validation === undefined ? (
                <p class="muted">…</p>
              ) : proposal.validation.ok ? (
                <p class="msg msg-ok" data-testid="validation" data-ok="true">
                  <IconCheck />
                  {t.proposalValidationOk}
                </p>
              ) : (
                <ul class="stack-2" data-testid="validation" data-ok="false">
                  {proposal.validation.problems.map((problem, index) => (
                    <li key={index} class="msg msg-err" data-kind={problem.kind}>
                      <IconCross />
                      <span>
                        <span class="strong">{t.problemKind(problem.kind)}</span>
                        {problem.file !== undefined && (
                          <>
                            {' '}
                            <code class="mono-s">{problem.file}</code>
                            {problem.line !== undefined && `:${problem.line}`}
                          </>
                        )}
                        {` — ${problem.detail}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {proposal.safety !== undefined && proposal.safety.state !== 'flagged' && (
                <p class="t-small muted" data-testid="safety" data-state={proposal.safety.state}>
                  {proposal.safety.state === 'clear' ? t.safetyClear(proposal.safety.model) : t.safetyUnavailable(proposal.safety.reason)}
                </p>
              )}
              <h3 class="t-3">{t.proposalTests}</h3>
              {proposal.checks === undefined ? (
                <p class="muted">{proposal.validation?.ok === false ? t.proposalNotTested : '…'}</p>
              ) : (
                <ul class="checks" data-testid="checks" data-ok={String(proposal.checks.ok)}>
                  {proposal.checks.error !== undefined && (
                    <li class="st-fail">
                      <IconCross />
                      <span class="ct">{proposal.checks.error}</span>
                    </li>
                  )}
                  {proposal.checks.steps.map((step) => (
                    // The line already names the step, its result and its time: the icon and that line.
                    <li key={step.name} data-step={step.name} data-ok={String(step.ok)}>
                      <span class={step.ok ? 'st-run' : 'st-fail'}>{step.ok ? <IconCheck /> : <IconCross />}</span>
                      <span class="ct">{t.testStep(step.name, step.ok, formatDuration(step.ms, lang))}</span>
                      {!step.ok && <pre class="request check-tail">{step.tail}</pre>}
                    </li>
                  ))}
                </ul>
              )}
              {proposal.realCheck !== undefined && (
                <div class="stack-2" data-testid="real-check" data-state={proposal.realCheck.state}>
                  <h3 class="t-3">{t.proposalCheckTitle(proposal.realCheck.name)}</h3>
                  <p>{t.realCheckState(proposal.realCheck.state)}</p>
                  {proposal.realCheck.output !== undefined && <pre class="request check-tail">{proposal.realCheck.output}</pre>}
                </div>
              )}
            </section>

            {/* The safety notice comes right before the decision, in coral (LEEME). */}
            {proposal.safety?.state === 'flagged' && (
              <div class="note note-danger note-sec" role="alert" data-testid="safety-warning">
                <IconAlert />
                <div class="note-body">
                  <p class="note-title">{t.safetyFlaggedTitle}</p>
                  <p>{proposal.safety.reason}</p>
                  <p class="t-small">{t.safetyFlaggedNote(proposal.safety.model)}</p>
                </div>
              </div>
            )}

            {DECIDABLE.has(proposal.status) && (
              <section class="dec" aria-labelledby="decision-title">
                <h2 id="decision-title">{t.proposalDecision}</h2>
                {proposal.status === 'ready' && <p class="muted">{t.proposalDecisionNote}</p>}
                <Actions proposal={proposal} check={page.check} reload={reload} />
              </section>
            )}
          </div>

          <aside class="col-side">
            <section class="card" aria-labelledby="making-title">
              <h2 class="t-2" id="making-title">
                {t.proposalMaking}
              </h2>
              <h3 class="t-3">{t.proposalEvidence}</h3>
              <ul class="stack-2" data-testid="evidence">
                {proposal.evidence.map((item) => (
                  <li key={item.file} class="mono-s">
                    {item.kind === 'session' ? (
                      <a class="link" href={routeHash({ page: 'session', id: item.ref })}>
                        {item.ref}
                      </a>
                    ) : (
                      <code>{item.file}</code>
                    )}
                  </li>
                ))}
              </ul>
              <h3 class="t-3">{t.proposalRounds}</h3>
              <ol class="history" data-testid="rounds">
                {proposal.rounds.map((round) => (
                  <li key={round.n}>
                    <span>{t.roundLine(round.n, round.outcome, round.denials.length)}</span>
                    {round.feedback !== undefined && (
                      <span class="t-small muted">
                        {t.roundFeedback} {round.feedback}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          </aside>
        </div>
      </div>
    </>
  );
}

function ProposalView({ id }: { id: string }) {
  const { t } = useApp();
  const loaded = useLoad<ProposalPage>(`/api/improve/proposals/${encodeURIComponent(id)}`);
  useDocumentTitle(loaded.data?.proposal.title ?? t.proposalKind);
  const live = loaded.data === undefined || LIVE.has(loaded.data.proposal.status) || loaded.data.proposal.realCheck?.state === 'running';
  usePoll(loaded.reload, live, 1500);
  return (
    <LoadState loaded={loaded}>
      {(page) => <ProposalBody page={page} reload={loaded.reload} />}
    </LoadState>
  );
}

export function ImprovePage({ id }: { id: string | undefined }) {
  return id === undefined ? <Overview /> : <ProposalView key={id} id={id} />;
}

/** The suggestions a creation produced, for its result screen. They come a moment after it finishes. */
export function CreationSuggestions({ creationId }: { creationId: string }) {
  const { t } = useApp();
  const loaded = useLoad<ImproveOverview>('/api/improve');
  const [tries, setTries] = useState(0);
  const mine = loaded.data?.suggestions.filter((s) => s.creationId === creationId) ?? [];
  useEffect(() => {
    if (loaded.data === undefined || mine.length > 0 || tries >= 5) return;
    const timer = setTimeout(() => {
      setTries((value) => value + 1);
      loaded.reload();
    }, 1000);
    return () => clearTimeout(timer);
  }, [loaded.data, mine.length, tries, loaded.reload]);
  if (mine.length === 0) return null;
  return (
    <section class="card" aria-labelledby="creation-suggestions-title" data-testid="creation-suggestions">
      <h2 class="t-2" id="creation-suggestions-title">
        {t.creationSuggestions}
      </h2>
      <p class="t-small muted">{t.suggestionsNothingYet}</p>
      <SuggestionList suggestions={mine} />
    </section>
  );
}
