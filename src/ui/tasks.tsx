import { useEffect, useState } from 'preact/hooks';
import { formatWhen } from './format.js';
import { useApp, useDocumentTitle, useLoad, useSend } from './hooks.js';
import { Diff } from './improve.js';
import { ConfirmModal, ErrorNote, LoadState, Note, UsageWarningModal, usageWarningIn } from './kit.js';
import { formatDuration } from './panelData.js';
import { routeHash } from './route.js';
import type { ProjectTasksUi, TaskProposalUi, TaskViewUi, UsageView, UsageWarningView } from './types.js';

/**
 * Tasks in existing projects (BRIEF-phase-7 §3): the project page's section
 * (start a task, its checks, its tasks) and one task's page, the only place
 * where a task is approved, sent back for changes, discarded or reverted.
 */

const LIVE = new Set(['running', 'checking']);

function usePoll(reload: () => void, active: boolean, ms = 1000): void {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(reload, ms);
    return () => clearInterval(timer);
  }, [reload, active, ms]);
}

/** Runs one request at a time with its error kept for the page. */
function useAction(): { busy: boolean; error: unknown; run(action: () => Promise<unknown>): Promise<boolean> } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  return {
    busy,
    error,
    async run(action) {
      setBusy(true);
      setError(undefined);
      try {
        await action();
        return true;
      } catch (failure) {
        setError(failure);
        return false;
      } finally {
        setBusy(false);
      }
    },
  };
}

const shortSha = (sha: string | undefined): string => (sha === undefined ? '' : sha.slice(0, 7));

// ---- the project page's section ------------------------------------------------------------------

export function ProjectTasks({ slug }: { slug: string }) {
  const { t, lang } = useApp();
  const send = useSend();
  const loaded = useLoad<ProjectTasksUi>(`/api/projects/${encodeURIComponent(slug)}/tasks`);
  const usage = useLoad<UsageView>('/api/usage');
  const [text, setText] = useState('');
  const [usageWarning, setUsageWarning] = useState<UsageWarningView | undefined>(undefined);
  const [confirmInit, setConfirmInit] = useState(false);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [confirmChecks, setConfirmChecks] = useState<string[] | undefined>(undefined);
  const action = useAction();

  const begin = async (force: boolean) => {
    setUsageWarning(undefined);
    await action.run(async () => {
      try {
        const { id } = await send<{ id: string }>('POST', '/api/tasks', { project: slug, description: text, ...(force ? { force: true } : {}) });
        window.location.hash = routeHash({ page: 'task', id });
      } catch (failure) {
        const warning = usageWarningIn(failure);
        if (warning === undefined) throw failure;
        setUsageWarning(warning);
      }
    });
  };

  return (
    <LoadState loaded={loaded}>
      {(data) => {
        const { start, checks, tasks } = data;
        const work = usage.data?.work;
        return (
          <section class="card" aria-labelledby="tasks-title" data-testid="project-tasks">
            <h2 class="t-2" id="tasks-title">
              {t.tasksTitle}
            </h2>
            <p class="sub">{t.tasksIntro}</p>
            {action.error !== undefined && <ErrorNote error={action.error} />}
            {usageWarning !== undefined && <UsageWarningModal warning={usageWarning} onStart={() => void begin(true)} onCancel={() => setUsageWarning(undefined)} />}
            {start.ok ? (
              <form
                class="stack-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void begin(false);
                }}
              >
                <label class="label" for="task-text">
                  {t.taskStartLabel}
                </label>
                <textarea id="task-text" class="textarea" rows={3} value={text} onInput={(event) => setText((event.target as HTMLTextAreaElement).value)} data-testid="task-text" />
                {work !== undefined && (
                  <p class="t-small muted" data-testid="task-start-notes">
                    {t.taskStartNotes(work.model, work.effort)}
                  </p>
                )}
                {start.uncommitted.length > 0 && (
                  <Note tone="warn" testId="task-uncommitted">
                    {t.taskUncommitted(start.uncommitted.slice(0, 10).join(', '))}
                  </Note>
                )}
                <div class="btn-row">
                  <button type="submit" class="btn btn-primary" disabled={action.busy || text.trim() === ''} data-testid="task-start">
                    {t.taskStartButton}
                  </button>
                </div>
              </form>
            ) : (
              <Note tone="plain" title={t.taskCannotStart} testId="task-cannot-start">
                {start.message}
                {start.code === 'task.notGitRepo' && (
                  <div class="btn-row">
                    <button type="button" class="btn btn-secondary btn-sm" onClick={() => setConfirmInit(true)} data-testid="task-git-init">
                      {t.taskInitOffer}
                    </button>
                  </div>
                )}
              </Note>
            )}
            {confirmInit && (
              <ConfirmModal
                title={t.taskInitTitle}
                body={t.taskInitBody}
                confirmLabel={t.taskInitOffer}
                cancelLabel={t.cancel}
                tone="normal"
                onConfirm={() => {
                  setConfirmInit(false);
                  void action.run(async () => {
                    await send('POST', `/api/projects/${encodeURIComponent(slug)}/git-init`, { confirm: true });
                    loaded.reload();
                  });
                }}
                onCancel={() => setConfirmInit(false)}
              />
            )}

            <hr class="divider" />
            <h3 class="t-3">{t.taskChecksTitle}</h3>
            <p class="t-small muted">{t.taskChecksIntro}</p>
            {checks.length === 0 ? (
              <p class="muted">{t.taskChecksNone}</p>
            ) : (
              <ul class="plain-list" data-testid="task-checks">
                {checks.map((check) => (
                  <li key={check.command}>
                    <code>{check.command}</code>
                    {!check.confirmed && <span class="t-small faint"> — {t.taskCheckUnconfirmed}</span>}
                  </li>
                ))}
              </ul>
            )}
            {editing === undefined ? (
              <div class="btn-row">
                <button type="button" class="btn btn-secondary btn-sm" onClick={() => setEditing(checks.map((check) => check.command).join('\n'))} data-testid="task-checks-edit">
                  {t.taskChecksEdit}
                </button>
              </div>
            ) : (
              <div class="stack-2">
                <label class="label" for="task-checks-text">
                  {t.taskChecksLabel}
                </label>
                <textarea id="task-checks-text" class="textarea mono" rows={4} value={editing} onInput={(event) => setEditing((event.target as HTMLTextAreaElement).value)} data-testid="task-checks-text" />
                <div class="btn-row">
                  <button
                    type="button"
                    class="btn btn-primary btn-sm"
                    onClick={() => setConfirmChecks(editing.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== ''))}
                    data-testid="task-checks-save"
                  >
                    {t.taskChecksSave}
                  </button>
                  <button type="button" class="btn btn-ghost btn-sm" onClick={() => setEditing(undefined)}>
                    {t.cancel}
                  </button>
                </div>
              </div>
            )}
            {confirmChecks !== undefined && (
              <ConfirmModal
                title={t.taskChecksConfirmTitle}
                body={t.taskChecksConfirmBody(confirmChecks.join(' · '))}
                confirmLabel={t.taskChecksSave}
                cancelLabel={t.cancel}
                tone="normal"
                onConfirm={() => {
                  const commands = confirmChecks;
                  setConfirmChecks(undefined);
                  void action
                    .run(() => send('PUT', `/api/projects/${encodeURIComponent(slug)}/checks`, { commands, confirm: true }))
                    .then((ok) => {
                      if (ok) {
                        setEditing(undefined);
                        loaded.reload();
                      }
                    });
                }}
                onCancel={() => setConfirmChecks(undefined)}
              />
            )}

            <hr class="divider" />
            {tasks.length === 0 ? (
              <p class="muted">{t.taskListEmpty}</p>
            ) : (
              <div class="table-scroll">
                <table class="table" data-testid="task-list">
                  <thead>
                    <tr>
                      <th scope="col">{t.taskColText}</th>
                      <th scope="col">{t.taskColState}</th>
                      <th scope="col">{t.taskColStarted}</th>
                      <th scope="col">{t.taskColCommit}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((task) => (
                      <tr key={task.id}>
                        <td>
                          <a class="link" href={routeHash({ page: 'task', id: task.id })}>
                            {task.description.split(/\r?\n/, 1)[0]}
                          </a>
                        </td>
                        <td>{t.taskState(task.state)}</td>
                        <td class="td-mono">{formatWhen(task.createdAt, lang)}</td>
                        <td class="td-mono">{shortSha(task.reverted?.commit ?? task.applied?.commit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      }}
    </LoadState>
  );
}

// ---- one task ------------------------------------------------------------------------------------

function ApprovalDialog({ task, onDone }: { task: TaskViewUi; onDone(): void }) {
  const { t } = useApp();
  const send = useSend();
  const action = useAction();
  const pending = task.pending;
  if (pending === undefined || pending.kind !== 'approval') return null;
  const { payload } = pending;
  const answer = (value: 'once' | 'task' | 'deny') => void action.run(() => send('POST', `/api/tasks/${task.id}/answer`, { pendingId: pending.id, answer: value })).then(onDone);
  return (
    <section class="card card-accent" role="alertdialog" aria-labelledby="approval-title" data-testid="task-approval">
      <h2 class="t-2" id="approval-title">
        {t.taskApprovalTitle(payload.kind)}
      </h2>
      {payload.agentType !== undefined && <p class="t-small muted">{t.taskApprovalBy(payload.agentType)}</p>}
      <pre class="request" data-testid="task-approval-command">
        {payload.text}
      </pre>
      {payload.compound && <Note tone="warn" testId="task-approval-compound">{t.taskApprovalCompound}</Note>}
      {payload.runsGit && <Note tone="warn">{t.taskApprovalGit}</Note>}
      {payload.redacted && <Note tone="plain">{t.taskApprovalRedacted}</Note>}
      {action.error !== undefined && <ErrorNote error={action.error} />}
      <div class="btn-row">
        <button type="button" class="btn btn-primary" disabled={action.busy} onClick={() => answer('once')} data-testid="task-allow-once">
          {t.taskAllowOnce}
        </button>
        <button type="button" class="btn btn-secondary" disabled={action.busy} onClick={() => answer('task')} data-testid="task-allow-task">
          {t.taskAllowTask}
        </button>
        <button type="button" class="btn btn-danger" disabled={action.busy} onClick={() => answer('deny')} data-testid="task-deny">
          {t.taskDeny}
        </button>
      </div>
    </section>
  );
}

function QuestionDialog({ task, onDone }: { task: TaskViewUi; onDone(): void }) {
  const { t } = useApp();
  const send = useSend();
  const action = useAction();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const pending = task.pending;
  if (pending === undefined || pending.kind !== 'question') return null;
  const questions = pending.payload.questions;
  const complete = questions.every((question) => answers[question.question] !== undefined);
  return (
    <section class="card card-accent" aria-labelledby="question-title" data-testid="task-question">
      <h2 class="t-2" id="question-title">
        {t.taskQuestionTitle}
      </h2>
      {questions.map((question) => (
        <fieldset key={question.question} class="stack-2">
          <legend>{question.question}</legend>
          {question.options.map((option) => (
            <label key={option.label} class="radio">
              <input type="radio" name={question.question} checked={answers[question.question] === option.label} onChange={() => setAnswers({ ...answers, [question.question]: option.label })} />
              <span>
                {option.label}
                {option.description !== '' && <span class="t-small muted"> — {option.description}</span>}
              </span>
            </label>
          ))}
        </fieldset>
      ))}
      {action.error !== undefined && <ErrorNote error={action.error} />}
      <div class="btn-row">
        <button type="button" class="btn btn-primary" disabled={!complete || action.busy} onClick={() => void action.run(() => send('POST', `/api/tasks/${task.id}/answer`, { pendingId: pending.id, answer: answers })).then(onDone)}>
          {t.taskSendAnswer}
        </button>
      </div>
    </section>
  );
}

function RoundControls({ task, onDone }: { task: TaskViewUi; onDone(): void }) {
  const { t } = useApp();
  const send = useSend();
  const action = useAction();
  const [reply, setReply] = useState('');
  const turn = task.awaitingReply;
  return (
    <section class="card" aria-live="polite" data-testid="task-round">
      {action.error !== undefined && <ErrorNote error={action.error} />}
      {task.state === 'checking' && <p data-testid="task-checking">{t.taskChecking}</p>}
      {task.state === 'running' && turn === undefined && task.pending === undefined && <p data-testid="task-working">{task.cancelling === true ? t.taskCancelling : t.taskWorking}</p>}
      {task.state === 'running' && turn !== undefined && (
        <div class="stack-2" data-testid="task-turn-ended">
          <p class="t-strong">{t.taskTurnEnded}</p>
          {turn.lastMessage !== '' && <pre class="request request-clip">{turn.lastMessage}</pre>}
          <div class="btn-row">
            <button type="button" class="btn btn-primary" disabled={action.busy} onClick={() => void action.run(() => send('POST', `/api/tasks/${task.id}/finish`)).then(onDone)} data-testid="task-finish">
              {t.taskFinish}
            </button>
          </div>
          <p class="t-small muted">{t.taskFinishHint}</p>
          <label class="label" for="task-reply">
            {t.taskReplyLabel}
          </label>
          <textarea id="task-reply" class="textarea" rows={2} value={reply} onInput={(event) => setReply((event.target as HTMLTextAreaElement).value)} data-testid="task-reply" />
          <div class="btn-row">
            <button
              type="button"
              class="btn btn-secondary"
              disabled={action.busy || reply.trim() === ''}
              onClick={() =>
                void action.run(() => send('POST', `/api/tasks/${task.id}/reply`, { text: reply })).then((ok) => {
                  if (ok) setReply('');
                  onDone();
                })
              }
              data-testid="task-reply-send"
            >
              {t.taskReplySend}
            </button>
          </div>
        </div>
      )}
      {task.state === 'running' && task.cancelling !== true && (
        <div class="btn-row">
          <button type="button" class="btn btn-ghost btn-sm" disabled={action.busy} onClick={() => void action.run(() => send('POST', `/api/tasks/${task.id}/cancel`)).then(onDone)} data-testid="task-cancel">
            {t.taskCancel}
          </button>
        </div>
      )}
    </section>
  );
}

function ProposalActions({ task, onDone }: { task: TaskViewUi; onDone(): void }) {
  const { t } = useApp();
  const send = useSend();
  const action = useAction();
  const [confirm, setConfirm] = useState<'approve' | 'discard' | 'revert' | undefined>(undefined);
  const [changes, setChanges] = useState('');
  const canApprove = task.state === 'proposal' && !(task.validations ?? []).some((item) => item.level === 'error');
  const canRound = ['proposal', 'failed', 'cancelled', 'interrupted'].includes(task.state);
  const post = (path: string, body?: unknown) => void action.run(() => send('POST', `/api/tasks/${task.id}/${path}`, body)).then(onDone);
  const modal =
    confirm === 'approve'
      ? { title: t.taskApproveTitle, body: t.taskApproveBody(task.baseBranch), label: t.taskApprove, tone: 'normal' as const }
      : confirm === 'discard'
        ? { title: t.taskDiscardTitle, body: t.taskDiscardBody, label: t.taskDiscard, tone: 'danger' as const }
        : confirm === 'revert'
          ? { title: t.taskRevertTitle, body: t.taskRevertBody(task.baseBranch), label: t.taskRevert, tone: 'danger' as const }
          : undefined;
  if (!canRound && task.state !== 'applied') return null;
  return (
    <section class="card" aria-labelledby="actions-title" data-testid="task-actions">
      {action.error !== undefined && <ErrorNote error={action.error} />}
      <div class="btn-row">
        {task.state === 'proposal' && (
          <button type="button" class="btn btn-primary" disabled={!canApprove || action.busy} onClick={() => setConfirm('approve')} data-testid="task-approve">
            {t.taskApprove}
          </button>
        )}
        {canRound && (
          <button type="button" class="btn btn-danger" disabled={action.busy} onClick={() => setConfirm('discard')} data-testid="task-discard">
            {t.taskDiscard}
          </button>
        )}
        {task.state === 'applied' && (
          <button type="button" class="btn btn-danger" disabled={action.busy} onClick={() => setConfirm('revert')} data-testid="task-revert">
            {t.taskRevert}
          </button>
        )}
      </div>
      {canRound && (
        <div class="stack-2">
          <h2 class="t-3" id="actions-title">
            {t.taskAskChanges}
          </h2>
          <label class="label" for="task-changes">
            {t.taskChangesLabel}
          </label>
          <textarea id="task-changes" class="textarea" rows={2} value={changes} onInput={(event) => setChanges((event.target as HTMLTextAreaElement).value)} data-testid="task-changes" />
          <div class="btn-row">
            <button type="button" class="btn btn-secondary" disabled={action.busy || changes.trim() === ''} onClick={() => post('changes', { text: changes })} data-testid="task-changes-send">
              {t.taskChangesSend}
            </button>
          </div>
        </div>
      )}
      {modal !== undefined && (
        <ConfirmModal
          title={modal.title}
          body={modal.body}
          confirmLabel={modal.label}
          cancelLabel={t.cancel}
          tone={modal.tone}
          onConfirm={() => {
            const which = confirm;
            setConfirm(undefined);
            if (which !== undefined) post(which, { confirm: true });
          }}
          onCancel={() => setConfirm(undefined)}
        />
      )}
    </section>
  );
}

function ProposalBody({ data }: { data: TaskProposalUi }) {
  const { t } = useApp();
  const { task, diff } = data;
  const round = task.rounds.at(-1);
  return (
    <>
      {round?.summary !== undefined && (
        <section class="card" aria-labelledby="summary-title" data-testid="task-summary">
          <h2 class="t-2" id="summary-title">
            {t.taskSummary}
          </h2>
          <p class="t-small muted">{t.taskSummaryNote}</p>
          <pre class="request request-clip">{round.summary}</pre>
        </section>
      )}
      {task.checks !== undefined && (
        <section class="card" aria-labelledby="checks-title" data-testid="task-check-results">
          <h2 class="t-2" id="checks-title">
            {t.taskChecksResults}
          </h2>
          {task.checks.length === 0 ? (
            <p class="muted">{t.taskNoChecks}</p>
          ) : (
            task.checks.map((check) => (
              <details key={check.command} class="stack-2" open={check.exitCode !== 0}>
                <summary>
                  <code>{check.command}</code> — <span data-ok={check.exitCode === 0 ? 'yes' : 'no'}>{t.taskCheckResult(check.exitCode, check.timedOut)}</span>{' '}
                  <span class="faint">{formatDuration(check.durationMs)}</span>
                </summary>
                {check.output !== '' && <pre class="request request-clip">{check.output}</pre>}
              </details>
            ))
          )}
        </section>
      )}
      {task.validations !== undefined && (
        <section class="card" aria-labelledby="validations-title" data-testid="task-validations">
          <h2 class="t-2" id="validations-title">
            {t.taskValidations}
          </h2>
          {task.validations.length === 0 ? (
            <p class="muted">{t.taskValidationsNone}</p>
          ) : (
            <ul class="plain-list">
              {task.validations.map((item) => (
                <li key={`${item.kind}-${item.file}`} data-level={item.level}>
                  <Note tone={item.level === 'error' ? 'danger' : 'warn'}>
                    <code>{item.file}</code>: {t.taskValidationText(item.kind)}
                  </Note>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {diff !== null && (
        <section class="card" aria-labelledby="diff-title" data-testid="task-diff">
          <h2 class="t-2" id="diff-title">
            {t.taskDiffTitle}
          </h2>
          {diff.files.length === 0 && <p class="muted">{t.taskNoDiff}</p>}
          {diff.files.map((file) =>
            file.shown ? (
              <Diff key={file.path} hunks={file.hunks} file={{ path: file.path, added: file.added, removed: file.removed }} testId={`task-diff-${file.path}`} />
            ) : (
              <p key={file.path}>
                <code>{file.path}</code> — <span class="muted">{t.taskDiffNotShown}</span>
              </p>
            ),
          )}
          {diff.more > 0 && <p class="muted">{t.taskDiffMore(diff.more)}</p>}
        </section>
      )}
    </>
  );
}

export function TaskPage({ id }: { id: string }) {
  const { t, lang } = useApp();
  const loaded = useLoad<TaskProposalUi>(`/api/tasks/${encodeURIComponent(id)}/proposal`);
  const task = loaded.data?.task;
  useDocumentTitle(task?.description.split(/\r?\n/, 1)[0] ?? t.taskTitle);
  usePoll(loaded.reload, task !== undefined && LIVE.has(task.state));
  return (
    <LoadState loaded={loaded}>
      {(data) => {
        const view = data.task;
        const round = view.rounds.at(-1);
        return (
          <>
            <header class="page-head">
              <div class="page-head-text">
                <p class="meta">
                  <a class="link" href={routeHash({ page: 'project', slug: view.project })}>
                    ← {view.project}
                  </a>
                </p>
                <h1 class="t-1">{view.description.split(/\r?\n/, 1)[0]}</h1>
                <div class="head-status">
                  <span class="chip" data-testid="task-state">
                    {t.taskState(view.state)}
                  </span>
                  <span class="chip chip-mono chip-outline">{t.taskModel(view.model, view.effort)}</span>
                  {round !== undefined && <span class="chip chip-outline">{t.taskRound(round.n)}</span>}
                  {round?.sessionId !== undefined && (
                    <a class="link" href={routeHash({ page: 'session', id: round.sessionId })} data-testid="task-panel-link">
                      {t.taskPanel}
                    </a>
                  )}
                </div>
              </div>
            </header>
            <div class="page stack-3">
              {view.uncommitted !== undefined && <Note tone="warn">{t.taskUncommitted(view.uncommitted.slice(0, 10).join(', '))}</Note>}
              {view.warnings !== undefined && view.warnings.agentsWithoutTools.length > 0 && <Note tone="warn">{t.taskWarnAgents(view.warnings.agentsWithoutTools.join(', '))}</Note>}
              {view.warnings !== undefined && view.warnings.externalImports.length > 0 && (
                <Note tone="warn" testId="task-external-imports">
                  {t.taskWarnImports(view.warnings.externalImports.map((item) => `${item.file} → ${item.target}`).join(', '))}
                </Note>
              )}
              {view.allowedForTask !== undefined && <p class="t-small muted">{t.taskAllowedForTask(view.allowedForTask)}</p>}
              {view.error !== undefined && (
                <Note tone="danger" testId="task-error">
                  {view.error}
                </Note>
              )}
              {view.applied !== undefined && <Note tone="plain" testId="task-applied">{t.taskApplied(shortSha(view.applied.commit), formatWhen(view.applied.at, lang))}</Note>}
              {view.reverted !== undefined && <Note tone="plain" testId="task-reverted">{t.taskReverted(shortSha(view.reverted.commit), formatWhen(view.reverted.at, lang))}</Note>}
              <ApprovalDialog task={view} onDone={loaded.reload} />
              <QuestionDialog task={view} onDone={loaded.reload} />
              {LIVE.has(view.state) && <RoundControls task={view} onDone={loaded.reload} />}
              <ProposalActions task={view} onDone={loaded.reload} />
              {!LIVE.has(view.state) && <ProposalBody data={data} />}
            </div>
          </>
        );
      }}
    </LoadState>
  );
}
