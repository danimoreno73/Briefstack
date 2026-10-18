import { useEffect, useState } from 'preact/hooks';
import { ConfirmDialog, ErrorBanner, Loader } from './common.js';
import { formatWhen } from './format.js';
import { useApp, useLoad, useSend } from './hooks.js';
import { routeHash } from './route.js';
import type { DiffHunkView, ImproveOverview, ProposalDetail, ProposalPage, SuggestionView, UsageView } from './types.js';

/**
 * Improvements of the creation flow (BRIEF-phase-5 §3.3–§3.5): suggestions,
 * proposals and the applied history, and one proposal's page, the only place
 * where an improvement is approved, discarded or reverted.
 */

const LIVE = new Set(['preparing', 'verifying', 'waiting', 'revertWaiting']);

/** Reloads every `ms` while `active` holds. */
function usePoll(reload: () => void, active: boolean, ms = 2000): void {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(reload, ms);
    return () => clearInterval(timer);
  }, [reload, active, ms]);
}

/** A unified diff, as the note-change card shows one. */
export function Diff({ hunks, testId }: { hunks: readonly DiffHunkView[]; testId?: string }) {
  const { t } = useApp();
  return (
    <pre class="diff" data-testid={testId}>
      {hunks.flatMap((hunk, index) => [
        ...(hunk.skipped > 0 ? [<span key={`s${index}`} class="diff-skip">{`${t.cardSkipped(hunk.skipped)}\n`}</span>] : []),
        ...hunk.lines.map((line, position) => (
          <span key={`${index}-${position}`} class={line.op === '+' ? 'diff-add' : line.op === '-' ? 'diff-del' : undefined}>
            {`${line.op} ${line.text}\n`}
          </span>
        )),
      ])}
    </pre>
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
    <form class="improve-form" onSubmit={(event) => void submit(event)} data-testid="prepare-form">
      <label>
        {t.improveRequestLabel}
        <textarea rows={4} value={request} maxLength={10_000} onInput={(event) => setRequest((event.target as HTMLTextAreaElement).value)} required />
      </label>
      <label class="inline">
        <input type="checkbox" checked={lessons} onChange={(event) => setLessons((event.target as HTMLInputElement).checked)} /> {t.improveLessonsLabel}
      </label>
      <p class="muted">{t.improveUsesPlan(usage.data?.sessionModel ?? '…')}</p>
      {error !== undefined && <ErrorBanner error={error} />}
      <div class="actions">
        {onCancel !== undefined && (
          <button type="button" onClick={onCancel}>
            {t.cancel}
          </button>
        )}
        <button type="submit" disabled={busy || request.trim() === ''}>
          {t.improvePrepareButton}
        </button>
      </div>
    </form>
  );
}

/** Suggestions, each with a way to ask for it to be prepared. Used on the improvements page, the result screen and the chat. */
export function SuggestionList({ suggestions }: { suggestions: readonly SuggestionView[] }) {
  const { t } = useApp();
  const [open, setOpen] = useState<string | undefined>(undefined);
  return (
    <ul class="suggestions" data-testid="suggestions">
      {suggestions.map((s) => {
        const text = t.suggestionText(s.kind, s.params, s.target);
        return (
          <li key={s.id} data-testid="suggestion" data-kind={s.kind}>
            <p>{text}</p>
            <p class="muted">{t.suggestionFrom(s.idea)}</p>
            {s.proposalId !== undefined ? (
              <p>
                {t.suggestionPrepared} <a href={routeHash({ page: 'improve', id: s.proposalId })}>{s.proposalId}</a>
              </p>
            ) : open === s.id ? (
              <PrepareForm initial={t.suggestionRequest(s.kind, text)} suggestionId={s.id} lessons={s.kind === 'lessons'} onCancel={() => setOpen(undefined)} />
            ) : (
              <button type="button" onClick={() => setOpen(s.id)}>
                {t.suggestionPrepare}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ProposalTable({ proposals, testId }: { proposals: ImproveOverview['proposals']; testId: string }) {
  const { t, lang } = useApp();
  return (
    <div class="table-wrap">
      <table data-testid={testId}>
        <thead>
          <tr>
            <th scope="col">{t.colRequest}</th>
            <th scope="col">{t.colStatus}</th>
            <th scope="col">{t.colFiles}</th>
            <th scope="col">{t.colUpdated}</th>
            <th scope="col">
              <span class="visually-hidden">{t.openProposal}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {proposals.map((p) => (
            <tr key={p.id} data-proposal={p.id}>
              <td>{p.title ?? p.request.slice(0, 120)}</td>
              <td data-testid="proposal-row-status">{t.proposalStatus(p.status)}</td>
              <td>{p.files.join(', ')}</td>
              <td>{formatWhen(p.updatedAt, lang)}</td>
              <td>
                <a href={routeHash({ page: 'improve', id: p.id })}>{t.openProposal}</a>
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
  return (
    <section>
      <h1>{t.improveTitle}</h1>
      <p class="muted">{t.improveIntro}</p>
      <Loader loaded={loaded}>
        {(data) => {
          const applied = data.proposals.filter((p) => p.status === 'applied' || p.status === 'reverted' || p.status === 'revertWaiting');
          const open = data.proposals.filter((p) => !applied.includes(p));
          return (
            <>
              {data.active !== undefined && (
                <p class="banner banner-ok" role="status">
                  {t.improveRunning} <a href={routeHash({ page: 'improve', id: data.active })}>{data.active}</a>
                </p>
              )}
              <h2>{t.improveSuggestions}</h2>
              {data.suggestions.length === 0 ? <p class="muted">{t.improveNoSuggestions}</p> : <SuggestionList suggestions={data.suggestions} />}
              <h2>{t.improvePrepareTitle}</h2>
              <PrepareForm initial="" />
              <h2>{t.improveProposals}</h2>
              {open.length === 0 ? <p class="muted">{t.improveNoProposals}</p> : <ProposalTable proposals={open} testId="proposals" />}
              <h2>{t.improveHistory}</h2>
              {applied.length === 0 ? <p class="muted">{t.improveNoHistory}</p> : <ProposalTable proposals={applied} testId="history" />}
            </>
          );
        }}
      </Loader>
    </section>
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
    approve: { title: t.proposalApproveTitle, body: t.proposalApproveBody, label: t.proposalApprove, path: 'approve' },
    discard: { title: t.proposalDiscardTitle, body: t.proposalDiscardBody, label: t.proposalDiscard, path: 'discard' },
    revert: { title: t.proposalRevertTitle, body: t.proposalRevertBody, label: t.proposalRevert, path: 'revert' },
  } as const;
  return (
    <div>
      {error !== undefined && <ErrorBanner error={error} />}
      {check !== undefined && proposal.status === 'ready' && proposal.realCheck?.state !== 'running' && (
        <div class="improve-check" data-testid="real-check-offer">
          <h3>{t.proposalCheckTitle(check.name)}</h3>
          <p class="muted">{check.cost[lang]}</p>
          <button type="button" disabled={busy} onClick={() => void run(() => send('POST', `${base}/check`))}>
            {t.proposalCheck}
          </button>
        </div>
      )}
      <div class="actions">
        {proposal.status === 'ready' && (
          <button type="button" disabled={busy} data-testid="approve" onClick={() => setConfirm('approve')}>
            {t.proposalApprove}
          </button>
        )}
        {canChange && changes === undefined && (
          <button type="button" disabled={busy} data-testid="ask-changes" onClick={() => setChanges('')}>
            {t.proposalAskChanges}
          </button>
        )}
        {canDiscard && (
          <button type="button" class="danger" disabled={busy} data-testid="discard" onClick={() => setConfirm('discard')}>
            {t.proposalDiscard}
          </button>
        )}
        {proposal.status === 'applied' && (
          <button type="button" class="danger" disabled={busy} data-testid="revert" onClick={() => setConfirm('revert')}>
            {t.proposalRevert}
          </button>
        )}
      </div>
      {changes !== undefined && (
        <form
          class="improve-form"
          data-testid="changes-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => send('POST', `${base}/changes`, { text: changes })).then(() => setChanges(undefined));
          }}
        >
          <label>
            {t.proposalChangesLabel}
            <textarea rows={3} value={changes} maxLength={10_000} onInput={(event) => setChanges((event.target as HTMLTextAreaElement).value)} required />
          </label>
          <div class="actions">
            <button type="button" onClick={() => setChanges(undefined)}>
              {t.cancel}
            </button>
            <button type="submit" disabled={busy || changes.trim() === ''}>
              {t.proposalSendChanges}
            </button>
          </div>
        </form>
      )}
      {confirm !== undefined && (
        <ConfirmDialog
          title={dialogs[confirm].title}
          body={dialogs[confirm].body}
          confirmLabel={dialogs[confirm].label}
          onCancel={() => setConfirm(undefined)}
          onConfirm={() =>
            void run(() =>
              // Approving names the round this page shows, so a round checked since is not approved unseen.
              confirm === 'approve' ? send('POST', `${base}/approve`, { head: proposal.head ?? '' }) : send('POST', `${base}/${dialogs[confirm].path}`),
            )
          }
        />
      )}
    </div>
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
    <>
      <p data-testid="proposal-status" data-status={proposal.status}>
        <strong>{t.proposalStatus(proposal.status)}</strong>
        {text !== undefined && ` · ${text}`}
      </p>
      {proposal.error !== undefined && (
        <p class="banner banner-error" role="alert" data-testid="proposal-error">
          {proposal.error}
        </p>
      )}
    </>
  );
}

function ProposalBody({ page, reload }: { page: ProposalPage; reload: () => void }) {
  const { t } = useApp();
  const { proposal, blockers } = page;
  return (
    <section>
      <p>
        <a href={routeHash({ page: 'improve', id: undefined })}>{t.improveTitle}</a>
      </p>
      <h1>{proposal.title ?? t.proposalHeading(proposal.id)}</h1>
      <StatusLine proposal={proposal} blockers={blockers} />
      {proposal.safety?.state === 'flagged' && (
        <div class="banner banner-warn" role="alert" data-testid="safety-warning">
          <strong>{t.safetyFlaggedTitle}</strong>
          <p>{proposal.safety.reason}</p>
          <p class="muted">{t.safetyFlaggedNote(proposal.safety.model)}</p>
        </div>
      )}
      <h2>{t.proposalRequest}</h2>
      <blockquote data-testid="proposal-request">{proposal.request}</blockquote>
      {proposal.expectedEffect !== undefined && (
        <>
          <h2>{t.proposalExpected}</h2>
          <p data-testid="proposal-expected">{proposal.expectedEffect}</p>
        </>
      )}
      <Actions proposal={proposal} check={page.check} reload={reload} />
      <h2>{t.proposalChanges}</h2>
      {proposal.files.length === 0 && <p class="muted">{t.proposalNoChanges}</p>}
      {proposal.files.map((file) => (
        <div key={file.path} class="improve-file" data-testid="proposal-file" data-path={file.path}>
          <h3>
            <code>{file.path}</code> <span class="muted">{t.cardNoteCounts(file.added, file.removed)}</span>
          </h3>
          {file.rationale !== undefined && (
            <p>
              <strong>{t.proposalRationale}</strong> {file.rationale}
              {file.evidence !== undefined && file.evidence.length > 0 && <span class="muted"> ({file.evidence.join(', ')})</span>}
            </p>
          )}
          <Diff hunks={file.hunks} testId="proposal-diff" />
        </div>
      ))}
      <h2>{t.proposalValidation}</h2>
      {proposal.validation === undefined ? (
        <p class="muted">…</p>
      ) : proposal.validation.ok ? (
        <p data-testid="validation" data-ok="true">
          {t.proposalValidationOk}
        </p>
      ) : (
        <ul data-testid="validation" data-ok="false">
          {proposal.validation.problems.map((problem, index) => (
            <li key={index} data-kind={problem.kind}>
              <strong>{t.problemKind(problem.kind)}</strong>
              {problem.file !== undefined && (
                <>
                  {' '}
                  <code>{problem.file}</code>
                  {problem.line !== undefined && `:${problem.line}`}
                </>
              )}
              {` — ${problem.detail}`}
            </li>
          ))}
        </ul>
      )}
      {proposal.safety !== undefined && proposal.safety.state !== 'flagged' && (
        <p class="muted" data-testid="safety" data-state={proposal.safety.state}>
          {proposal.safety.state === 'clear' ? t.safetyClear(proposal.safety.model) : t.safetyUnavailable(proposal.safety.reason)}
        </p>
      )}
      <h2>{t.proposalTests}</h2>
      {proposal.checks === undefined ? (
        <p class="muted">{proposal.validation?.ok === false ? t.proposalNotTested : '…'}</p>
      ) : (
        <ul data-testid="checks" data-ok={String(proposal.checks.ok)}>
          {proposal.checks.error !== undefined && <li>{proposal.checks.error}</li>}
          {proposal.checks.steps.map((step) => (
            <li key={step.name} data-step={step.name} data-ok={String(step.ok)}>
              {t.testStep(step.name, step.ok, Math.round(step.ms / 1000))}
              {!step.ok && <pre class="tail">{step.tail}</pre>}
            </li>
          ))}
        </ul>
      )}
      {proposal.realCheck !== undefined && (
        <div data-testid="real-check" data-state={proposal.realCheck.state}>
          <h2>{t.proposalCheckTitle(proposal.realCheck.name)}</h2>
          <p>{t.realCheckState(proposal.realCheck.state)}</p>
          {proposal.realCheck.output !== undefined && <pre class="tail">{proposal.realCheck.output}</pre>}
        </div>
      )}
      <h2>{t.proposalEvidence}</h2>
      <ul data-testid="evidence">
        {proposal.evidence.map((item) => (
          <li key={item.file}>
            {item.kind === 'session' ? <a href={routeHash({ page: 'session', id: item.ref })}>{item.ref}</a> : <code>{item.file}</code>}
          </li>
        ))}
      </ul>
      <h2>{t.proposalRounds}</h2>
      <ol data-testid="rounds">
        {proposal.rounds.map((round) => (
          <li key={round.n}>
            {t.roundLine(round.n, round.outcome, round.denials.length)}
            {round.feedback !== undefined && (
              <span class="muted">
                {' '}
                {t.roundFeedback} {round.feedback}
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function ProposalView({ id }: { id: string }) {
  const loaded = useLoad<ProposalPage>(`/api/improve/proposals/${encodeURIComponent(id)}`);
  const live = loaded.data === undefined || LIVE.has(loaded.data.proposal.status) || loaded.data.proposal.realCheck?.state === 'running';
  usePoll(loaded.reload, live, 1500);
  return <Loader loaded={loaded}>{(page) => <ProposalBody page={page} reload={loaded.reload} />}</Loader>;
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
    <div data-testid="creation-suggestions">
      <h2>{t.creationSuggestions}</h2>
      <SuggestionList suggestions={mine} />
    </div>
  );
}
