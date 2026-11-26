import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from './apiError.js';
import { areaPaths, canSwap, columnOf, COLUMNS, type Column } from './board.js';
import { formatCount } from './codexData.js';
import { Diff } from './improve.js';
import { describeError } from './errors.js';
import { formatWhen } from './format.js';
import { useApp, useDocumentTitle, useLoad, useSend } from './hooks.js';
import { ConfirmModal, ErrorNote, LoadState, Note, UsageWarningModal, usageWarningIn } from './kit.js';
import { routeHash } from './route.js';
import type { BuildTaskUi, BuildViewUi, ProjectBuildsUi, QueueItemUi, TaskProposalUi, UsageWarningView } from './types.js';

/**
 * Builds (BRIEF-phase-9 §3): the project page's section with the
 * "Implement" button, and one build's page: planning, the start page (the
 * queue, the commands, the checks and the limits, with the warning of §4),
 * and the progress.
 */

const LIVE = new Set(['planning', 'running']);

function usePoll(reload: () => void, active: boolean, ms = 1000): void {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(reload, ms);
    return () => clearInterval(timer);
  }, [reload, active, ms]);
}

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

const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

// ---- the project page's section ------------------------------------------------------------------

export function ProjectBuilds({ slug }: { slug: string }) {
  const { t, lang } = useApp();
  const send = useSend();
  const loaded = useLoad<ProjectBuildsUi>(`/api/projects/${encodeURIComponent(slug)}/builds`);
  const [usageWarning, setUsageWarning] = useState<UsageWarningView | undefined>(undefined);
  const action = useAction();

  const begin = async (force: boolean) => {
    setUsageWarning(undefined);
    await action.run(async () => {
      try {
        const { id } = await send<{ id: string }>('POST', `/api/projects/${encodeURIComponent(slug)}/builds`, force ? { force: true } : {});
        window.location.hash = routeHash({ page: 'build', id });
      } catch (failure) {
        const warning = usageWarningIn(failure);
        if (warning === undefined) throw failure;
        setUsageWarning(warning);
      }
    });
  };

  return (
    <LoadState loaded={loaded}>
      {(data) => (
        <section class="card" aria-labelledby="builds-title" data-testid="project-builds">
          <h2 class="t-2" id="builds-title">
            {t.buildsTitle}
          </h2>
          <p class="sub">{t.buildsIntro}</p>
          {action.error !== undefined && <ErrorNote error={action.error} />}
          {usageWarning !== undefined && <UsageWarningModal warning={usageWarning} onStart={() => void begin(true)} onCancel={() => setUsageWarning(undefined)} />}
          {data.plan.ok ? (
            <div class="btn-row">
              <button type="button" class="btn btn-primary" disabled={action.busy} onClick={() => void begin(false)} data-testid="build-implement">
                {t.buildImplement}
              </button>
            </div>
          ) : (
            <Note tone="plain" title={t.buildCannotPlan} testId="build-cannot-plan">
              {describeError(new ApiError(409, data.plan.code, data.plan.params), t)}
            </Note>
          )}
          {data.builds.length === 0 ? (
            <p class="muted">{t.buildListEmpty}</p>
          ) : (
            <div class="table-scroll">
              <table class="table" data-testid="build-list">
                <thead>
                  <tr>
                    <th scope="col">{t.buildColStarted}</th>
                    <th scope="col">{t.buildColState}</th>
                    <th scope="col">{t.buildColTasks}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.builds.map((build) => (
                    <tr key={build.id}>
                      <td class="td-mono">
                        <a class="link" href={routeHash({ page: 'build', id: build.id })}>
                          {formatWhen(build.createdAt, lang)}
                        </a>
                      </td>
                      <td>{t.buildState(build.state)}</td>
                      <td>{build.tasks.length === 0 ? '—' : `${build.tasks.filter((task) => task.state === 'applied').length} / ${build.tasks.length}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </LoadState>
  );
}

// ---- the start page ------------------------------------------------------------------------------

/** A card being edited: its dependencies are kept by key, so moving or removing cards keeps them right; its area as typed. */
interface Draft extends Omit<QueueItemUi, 'dependsOn' | 'area' | 'size'> {
  key: number;
  deps: number[];
  area: string;
  /** Empty when the plan gave none (a build planned before phase 11) and the user chose none: then none is sent. */
  size: 'S' | 'M' | 'L' | '';
}

/** What the start page offers for the slots (phase 11; the API's default without a value is one). */
const PAGE_SLOTS = 2;
const MAX_PAGE_SLOTS = 4;

function StartForm({ build, onStarted, defaults }: { build: BuildViewUi; onStarted(): void; defaults: { fiveHour: number; week: number } }) {
  const { t } = useApp();
  const send = useSend();
  const plan = build.plan;
  const [items, setItems] = useState<Draft[]>(() =>
    (plan?.tasks ?? []).map((task, i) => ({ key: i + 1, title: task.title, instruction: task.instruction, doneWhen: task.doneWhen, deps: [...task.dependsOn], area: (task.area ?? []).join('\n'), size: task.size ?? '' })),
  );
  const [limit, setLimit] = useState(String(plan?.tasks.length ?? 1));
  const [slots, setSlots] = useState(String(PAGE_SLOTS));
  const nextKey = useRef((plan?.tasks.length ?? 0) + 1);
  const [commands, setCommands] = useState((plan?.commands ?? []).join('\n'));
  const [checks, setChecks] = useState((plan?.checks ?? []).join('\n'));
  const [fixRounds, setFixRounds] = useState('1');
  const [fiveHour, setFiveHour] = useState(String(defaults.fiveHour));
  const [week, setWeek] = useState(String(defaults.week));
  const [confirm, setConfirm] = useState(false);
  const action = useAction();

  const position = (key: number): number => items.findIndex((item) => item.key === key) + 1;
  const update = (key: number, change: Partial<Draft>) => setItems((current) => current.map((item) => (item.key === key ? { ...item, ...change } : item)));
  const move = (index: number, delta: -1 | 1) =>
    setItems((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      if (item !== undefined) next.splice(index + delta, 0, item);
      return next;
    });
  const add = () => {
    const key = nextKey.current;
    nextKey.current += 1;
    const length = items.length;
    setItems((current) => [...current, { key, title: '', instruction: '', doneWhen: '', deps: [], area: '', size: 'M' }]);
    // "How many tasks to run" follows the board up when it ran them all.
    setLimit((current) => (Number(current) === length ? String(length + 1) : current));
  };
  const remove = (key: number) => {
    const left = items.filter((item) => item.key !== key).length;
    setItems((current) => current.filter((item) => item.key !== key).map((item) => ({ ...item, deps: item.deps.filter((dep) => dep !== key) })));
    // "How many tasks to run" never stays above the queue's length (review of M3, minor; step 33).
    setLimit((current) => String(Math.max(1, Math.min(Number(current) || left, left))));
  };
  const noChecks = lines(checks).length === 0;
  const [noChecksConfirmed, setNoChecksConfirmed] = useState(false);
  const queue = (): QueueItemUi[] =>
    items.map((item) => {
      const area = areaPaths(item.area);
      return { title: item.title, instruction: item.instruction, doneWhen: item.doneWhen, dependsOn: item.deps.map(position).filter((n) => n > 0), ...(area.length === 0 ? {} : { area }), ...(item.size === '' ? {} : { size: item.size }) };
    });

  const start = () =>
    void action
      .run(() =>
        send('POST', `/api/builds/${build.id}/start`, {
          tasks: queue(),
          limit: Number(limit),
          commands: lines(commands),
          checks: lines(checks),
          fixRounds: Number(fixRounds),
          thresholds: { fiveHour: Number(fiveHour), week: Number(week) },
          slots: Number(slots),
          confirm: true,
          ...(noChecks && noChecksConfirmed ? { noChecks: true } : {}),
        }),
      )
      .then((ok) => ok && onStarted());

  return (
    <section class="card stack-2" aria-labelledby="build-start-title" data-testid="build-start-form">
      <h2 class="t-2" id="build-start-title">
        {t.buildStartTitle}
      </h2>
      <p class="sub">{t.buildStartIntro}</p>
      <h3 class="t-3">{t.buildQueueTitle}</h3>
      <ol class="stack-2" data-testid="build-queue">
        {items.map((item, i) => (
          <li key={item.key} class="card stack-1" data-testid="build-queue-item">
            <p class="t-small muted">{t.buildTaskLabel(i + 1)}</p>
            <label class="label">
              {t.buildTaskTitleLabel}
              <input class="input" value={item.title} onInput={(event) => update(item.key, { title: (event.target as HTMLInputElement).value })} data-testid="build-item-title" />
            </label>
            <label class="label">
              {t.buildTaskInstructionLabel}
              <textarea class="textarea" rows={3} value={item.instruction} onInput={(event) => update(item.key, { instruction: (event.target as HTMLTextAreaElement).value })} data-testid="build-item-instruction" />
            </label>
            <label class="label">
              {t.buildTaskDoneWhenLabel}
              <input class="input" value={item.doneWhen} onInput={(event) => update(item.key, { doneWhen: (event.target as HTMLInputElement).value })} data-testid="build-item-done" />
            </label>
            <label class="label">
              {t.buildTaskDependsLabel}
              <input
                class="input mono"
                value={item.deps.map(position).filter((n) => n > 0).join(', ')}
                onChange={(event) => {
                  const numbers = (event.target as HTMLInputElement).value.split(/[\s,]+/).filter((part) => /^\d+$/.test(part)).map(Number);
                  update(item.key, { deps: numbers.map((n) => items[n - 1]?.key).filter((key): key is number => key !== undefined && key !== item.key) });
                }}
                data-testid="build-item-deps"
              />
            </label>
            <label class="label">
              {t.buildCardAreaLabel}
              <textarea class="textarea mono" rows={2} value={item.area} onInput={(event) => update(item.key, { area: (event.target as HTMLTextAreaElement).value })} data-testid="build-item-area" />
            </label>
            <label class="label">
              {t.buildCardSizeLabel}
              <select class="input" value={item.size} onChange={(event) => update(item.key, { size: (event.target as HTMLSelectElement).value as Draft['size'] })} data-testid="build-item-size">
                {item.size === '' && <option value="">{t.buildCardSizeNone}</option>}
                {(['S', 'M', 'L'] as const).map((size) => (
                  <option key={size} value={size}>
                    {t.buildCardSize(size)}
                  </option>
                ))}
              </select>
            </label>
            <div class="btn-row">
              <button type="button" class="btn btn-ghost btn-sm" disabled={i === 0 || !canSwap(items, i - 1)} onClick={() => move(i, -1)} data-testid="build-item-up">
                {t.buildTaskUp}
              </button>
              <button type="button" class="btn btn-ghost btn-sm" disabled={i === items.length - 1 || !canSwap(items, i)} onClick={() => move(i, 1)} data-testid="build-item-down">
                {t.buildTaskDown}
              </button>
              <button type="button" class="btn btn-ghost btn-sm" onClick={() => remove(item.key)} data-testid="build-item-remove">
                {t.buildTaskRemove}
              </button>
            </div>
          </li>
        ))}
      </ol>
      <div class="btn-row">
        <button type="button" class="btn btn-ghost" onClick={add} data-testid="build-item-add">
          {t.buildCardAdd}
        </button>
      </div>
      <p class="t-small muted">{t.buildCardAreaHint}</p>
      <label class="label">
        {t.buildSlotsLabel}
        <input class="input" type="number" min={1} max={MAX_PAGE_SLOTS} value={slots} onInput={(event) => setSlots((event.target as HTMLInputElement).value)} data-testid="build-slots" />
      </label>
      <p class="t-small muted" data-testid="build-slots-note">
        {t.buildSlotsNote}
      </p>
      <label class="label">
        {t.buildLimitLabel}
        <input class="input" type="number" min={1} max={items.length} value={limit} onInput={(event) => setLimit((event.target as HTMLInputElement).value)} data-testid="build-limit" />
      </label>
      <label class="label">
        {t.buildCommandsLabel}
        <textarea class="textarea mono" rows={4} value={commands} onInput={(event) => setCommands((event.target as HTMLTextAreaElement).value)} data-testid="build-commands" />
      </label>
      <p class="t-small muted">{t.buildCommandsHint}</p>
      <label class="label">
        {t.buildChecksLabel}
        <textarea class="textarea mono" rows={3} value={checks} onInput={(event) => setChecks((event.target as HTMLTextAreaElement).value)} data-testid="build-checks" />
      </label>
      <p class="t-small muted">{t.buildChecksHint}</p>
      {noChecks && (
        <Note tone="danger" title={t.buildNoChecksTitle} testId="build-no-checks">
          {t.buildNoChecksBody}
          <label class="check-line">
            <input type="checkbox" checked={noChecksConfirmed} onChange={(event) => setNoChecksConfirmed((event.target as HTMLInputElement).checked)} data-testid="build-no-checks-confirm" />{' '}
            {t.buildNoChecksConfirm}
          </label>
        </Note>
      )}
      <label class="label">
        {t.buildFixRoundsLabel}
        <input class="input" type="number" min={0} max={2} value={fixRounds} onInput={(event) => setFixRounds((event.target as HTMLInputElement).value)} data-testid="build-fix-rounds" />
      </label>
      <p class="t-small muted">{t.buildFixRoundsHint}</p>
      <p class="t-small muted" data-testid="build-no-codex">
        {t.buildNoCodex}
      </p>
      <div class="btn-row">
        <label class="label">
          {t.buildThresholdFive}
          <input class="input" type="number" min={1} max={100} value={fiveHour} onInput={(event) => setFiveHour((event.target as HTMLInputElement).value)} data-testid="build-threshold-five" />
        </label>
        <label class="label">
          {t.buildThresholdWeek}
          <input class="input" type="number" min={1} max={100} value={week} onInput={(event) => setWeek((event.target as HTMLInputElement).value)} data-testid="build-threshold-week" />
        </label>
      </div>
      <Note tone="danger" title={t.buildWarningTitle} testId="build-warning">
        {t.buildWarningBody}
      </Note>
      {action.error !== undefined && <ErrorNote error={action.error} />}
      <div class="btn-row">
        <button type="button" class="btn btn-primary" disabled={action.busy || items.length === 0 || (noChecks && !noChecksConfirmed)} onClick={() => setConfirm(true)} data-testid="build-start">
          {t.buildStart}
        </button>
      </div>
      {confirm && (
        <ConfirmModal
          title={t.buildStartConfirmTitle}
          body={t.buildStartConfirmBody(Math.min(Number(limit) || items.length, items.length))}
          items={[...lines(commands), ...lines(checks)].filter((command, i, all) => all.indexOf(command) === i)}
          confirmLabel={t.buildStart}
          cancelLabel={t.cancel}
          tone="normal"
          onConfirm={() => {
            setConfirm(false);
            start();
          }}
          onCancel={() => setConfirm(false)}
        />
      )}
    </section>
  );
}

// ---- the progress --------------------------------------------------------------------------------

function Progress({ build }: { build: BuildViewUi }) {
  const { t, lang } = useApp();
  return (
    <section class="card" aria-labelledby="build-progress-title" data-testid="build-progress">
      <h2 class="t-2" id="build-progress-title">
        {t.buildProgressTitle}
      </h2>
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{t.buildColTask}</th>
              <th scope="col">{t.buildColState}</th>
              <th scope="col">{t.buildColRounds}</th>
              <th scope="col">{t.buildColChecks}</th>
              <th scope="col">{t.buildColCodex}</th>
              <th scope="col">{t.buildColTokens}</th>
              <th scope="col">{t.buildColDetail}</th>
            </tr>
          </thead>
          <tbody>
            {build.tasks.map((task) => (
              <tr key={task.n} data-testid="build-task-row">
                <td class="td-mono">{task.n}</td>
                <td>{task.title}</td>
                <td data-testid="build-task-state">{t.buildTaskState(task.state)}</td>
                <td class="td-mono">{task.rounds}</td>
                <td class="t-small" data-testid="build-task-checks">
                  {task.task?.checks === undefined || task.task.checks.length === 0
                    ? '—'
                    : t.buildChecksPassed(task.task.checks.filter((check) => check.exitCode === 0 && !check.timedOut).length, task.task.checks.length)}
                </td>
                <td class="td-mono">{task.task === undefined ? '—' : task.task.codexCalls === 0 ? '0' : `${task.task.codexCalls} · ${formatCount(task.task.codexTokens, lang)}`}</td>
                <td class="td-mono" data-testid="build-task-tokens">
                  {task.task?.claudeTokens === undefined ? '—' : `${formatCount(task.task.claudeTokens.noCache, lang)} (${formatCount(task.task.claudeTokens.withCache, lang)})`}
                </td>
                <td class="t-small">
                  {task.reason !== undefined && <span data-testid="build-task-reason">{t.buildWaitReason(task.reason)}</span>}
                  {task.skippedFor !== undefined && <span>{t.buildSkippedFor(task.skippedFor)}</span>}
                  {task.commit !== undefined && <code>{task.commit.slice(0, 7)}</code>}
                  {task.taskId !== undefined && task.state === 'waiting' && (
                    <>
                      {' '}
                      <a class="link" href={routeHash({ page: 'task', id: task.taskId })} data-testid="build-open-task">
                        {t.buildOpenTask}
                      </a>
                    </>
                  )}
                  {(task.denied ?? []).length > 0 && (
                    <details>
                      <summary>{t.buildDeniedTitle}</summary>
                      <ul class="plain-list" data-testid="build-denied">
                        {(task.denied ?? []).map((entry, i) => (
                          <li key={`${i}-${entry.text}`}>
                            <code>{entry.text}</code>
                          </li>
                        ))}
                      </ul>
                      {(task.deniedOmitted ?? 0) > 0 && <p class="t-small muted" data-testid="build-denied-more">{t.buildDeniedMore(task.deniedOmitted ?? 0)}</p>}
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="t-small muted">{t.buildTokensHint}</p>
    </section>
  );
}

// ---- the board (phase 11) ------------------------------------------------------------------------

/** The started build's cards in columns, read-only, live while it runs. The table below keeps every detail. */
function Board({ build }: { build: BuildViewUi }) {
  const { t, lang } = useApp();
  const byColumn = new Map<Column, BuildTaskUi[]>(COLUMNS.map((column) => [column, []]));
  for (const task of build.tasks) byColumn.get(columnOf(task, build.tasks))?.push(task);
  return (
    <section class="card stack-2" aria-labelledby="build-board-title" data-testid="build-board">
      <h2 class="t-2" id="build-board-title">
        {t.buildBoardTitle}
      </h2>
      <p class="sub">{t.buildBoardSlots(build.settings?.slots ?? 1)}</p>
      <div class="board-columns">
        {COLUMNS.map((column) => {
          const cards = byColumn.get(column) ?? [];
          return (
            <section key={column} class="board-column stack-1" aria-labelledby={`build-column-${column}`} data-testid={`build-column-${column}`}>
              <h3 class="t-3" id={`build-column-${column}`}>
                {t.buildColumn(column)} <span class="muted">({cards.length})</span>
              </h3>
              <ul class="plain-list stack-1">
                {cards.map((task) => (
                  <li key={task.n} class="card board-card stack-1" data-testid="build-card" data-n={task.n}>
                    <p>
                      <span class="td-mono">#{task.n}</span> {task.title}
                    </p>
                    <p class="t-small muted">
                      {task.size === undefined ? '' : `${t.buildCardSize(task.size)} · `}
                      {/* Each path on its own: a comma may be part of one (review of M4). */}
                      {task.area === undefined || task.area.length === 0
                        ? t.buildCardWholeProject
                        : task.area.map((path, i) => (
                            <span key={`${i}-${path}`}>
                              {i > 0 && ' '}
                              <code>{path}</code>
                            </span>
                          ))}
                    </p>
                    <p class="t-small">
                      {t.buildCardRounds(task.rounds)}
                      {task.task?.claudeTokens === undefined ? '' : ` · ${formatCount(task.task.claudeTokens.noCache, lang)} ${t.buildCardTokens}`}
                      {task.task?.checks === undefined || task.task.checks.length === 0 ? '' : ` · ${t.buildChecksPassed(task.task.checks.filter((check) => check.exitCode === 0 && !check.timedOut).length, task.task.checks.length)}`}
                    </p>
                    {task.redo !== undefined && (
                      <p class="t-small" data-testid="build-card-redo">
                        {t.buildCardRedo(task.redo.reason)}
                      </p>
                    )}
                    {task.join !== undefined && (
                      <p class="t-small" data-testid="build-card-join">
                        {t.buildCardJoin(task.join.outcome, task.join.merged, (task.join.checks ?? []).length > 0)}
                        {(task.join.files ?? []).length > 0 && <code> {(task.join.files ?? []).join(', ')}</code>}
                        {task.join.outcome === 'checksFailed' && (
                          <code>
                            {' '}
                            {(task.join.checks ?? [])
                              .filter((check) => check.exitCode !== 0 || check.timedOut)
                              .map((check) => check.command)
                              .join(', ')}
                          </code>
                        )}
                      </p>
                    )}
                    {task.reason !== undefined && <p class="t-small">{t.buildWaitReason(task.reason)}</p>}
                    {/* Why it is under Skipped, as phase 9's table says it (review of M4). */}
                    {task.state === 'skipped' && task.skippedFor !== undefined && (
                      <p class="t-small" data-testid="build-card-skipped">
                        {t.buildCardSkipped(task.skippedFor)}
                      </p>
                    )}
                    {task.state === 'cancelled' && (
                      <p class="t-small" data-testid="build-card-skipped">
                        {t.buildCardCancelled}
                      </p>
                    )}
                    {(task.denied ?? []).length > 0 && <p class="t-small">{t.buildCardDenied((task.denied ?? []).length + (task.deniedOmitted ?? 0))}</p>}
                    {task.taskId !== undefined && task.state === 'waiting' && (
                      <a class="link t-small" href={routeHash({ page: 'task', id: task.taskId })}>
                        {t.buildOpenTask}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
}

// ---- one build -----------------------------------------------------------------------------------

/** Why the build is where it is: paused (by whom, until when), pausing, interrupted, cancelled, applied, reverted. */
function StatusNotes({ build }: { build: BuildViewUi }) {
  const { t, lang } = useApp();
  const until = formatWhen(build.pause?.until, lang);
  return (
    <>
      {build.state === 'paused' && build.pause?.reason === 'usage' && <Note tone="plain" testId="build-paused">{t.buildPausedUsage(until)}</Note>}
      {build.state === 'paused' && build.pause?.reason === 'usageUnread' && <Note tone="plain" testId="build-paused">{t.buildPausedUnread(until)}</Note>}
      {build.state === 'paused' && build.pause?.reason === 'user' && <Note tone="plain" testId="build-paused">{t.buildPausedUser}</Note>}
      {build.pausing === true && <Note tone="plain" testId="build-pausing">{t.buildPausing}</Note>}
      {build.cancelling === true && <Note tone="plain" testId="build-cancelling">{t.buildCancelling}</Note>}
      {build.state === 'interrupted' && (
        <Note tone="plain" testId="build-interrupted">
          {t.buildInterrupted}
          {/* An unexpected failure says what it was (redacted, no paths; review of M5, minor; step 33). */}
          {build.error !== undefined && <span data-testid="build-interrupted-error"> {build.error}</span>}
        </Note>
      )}
      {build.state === 'cancelled' && <Note tone="plain" testId="build-cancelled">{t.buildCancelledNote}</Note>}
      {build.applied !== undefined && <Note tone="plain" testId="build-applied">{t.buildAppliedAt(build.applied.commit.slice(0, 7))}</Note>}
      {build.reverted !== undefined && <Note tone="plain" testId="build-reverted">{t.buildRevertedAt(build.reverted.commit.slice(0, 7))}</Note>}
    </>
  );
}

type BuildAction = 'pause' | 'resume' | 'cancel' | 'apply' | 'revert' | 'discard';

/** The build's actions, each confirmed when it changes something that stays (BRIEF §3.4, §3.5). */
function Actions({ build, head, onDone, onRefused }: { build: BuildViewUi; head: string | undefined; onDone(): void; onRefused(): void }) {
  const { t } = useApp();
  const send = useSend();
  const action = useAction();
  const [confirm, setConfirm] = useState<BuildAction | undefined>(undefined);
  const settled = ['paused', 'interrupted', 'cancelled', 'finished'].includes(build.state) && build.cancelling !== true;
  const can: Record<BuildAction, boolean> = {
    pause: (build.state === 'running' && build.pausing !== true && build.cancelling !== true) || (build.state === 'paused' && build.pause?.reason !== 'user'),
    resume: ['paused', 'interrupted', 'finished'].includes(build.state) && build.cancelling !== true,
    cancel: (build.state === 'running' && build.cancelling !== true) || build.state === 'paused' || build.state === 'interrupted',
    apply: settled && head !== undefined,
    // Also once discarded: discarding deleted only the branch, which a revert does not need (review of step 33, A, I-1).
    revert: build.applied !== undefined && build.reverted === undefined && (build.state === 'applied' || build.state === 'discarded'),
    // An applied or reverted build loses only its branch (the user's decision, step 33).
    discard: settled || build.state === 'applied' || build.state === 'reverted',
  };
  const landed = build.state === 'applied' || build.state === 'reverted';
  // Confirmed actions say so in the body; apply also names the change the page shows (review of M5, I2 and I3).
  const body = (name: BuildAction): Record<string, unknown> => (name === 'apply' ? { confirm: true, head } : dialogs[name] === undefined ? {} : { confirm: true });
  // A refused action reads the build and its diff again, so a second Apply sends the head the page now shows (review of M6, minor; step 33).
  const run = (name: BuildAction) => void action.run(() => send('POST', `/api/builds/${encodeURIComponent(build.id)}/${name}`, body(name))).then((ok) => (ok ? onDone() : onRefused()));
  const dialogs: Partial<Record<BuildAction, { title: string; body: string; label: string; tone: 'normal' | 'danger' }>> = {
    cancel: { title: t.buildCancelTitle, body: t.buildCancelBody, label: t.buildCancel, tone: 'danger' },
    apply: { title: t.buildApplyTitle, body: `${t.buildApplyBody(build.baseBranch ?? '')} ${t.buildApplyHint}`, label: t.buildApply, tone: 'normal' },
    revert: { title: t.buildRevertTitle, body: t.buildRevertBody, label: t.buildRevert, tone: 'normal' },
    discard: { title: t.buildDiscardTitle, body: landed ? t.buildDiscardAppliedBody : t.buildDiscardBody, label: t.buildDiscard, tone: 'danger' },
  };
  const labels: Record<BuildAction, string> = { pause: t.buildPause, resume: t.buildResume, cancel: t.buildCancel, apply: t.buildApply, revert: t.buildRevert, discard: t.buildDiscard };
  const shown = (Object.keys(can) as BuildAction[]).filter((name) => can[name]);
  if (shown.length === 0) return null;
  const dialog = confirm === undefined ? undefined : dialogs[confirm];
  return (
    <section class="card stack-1" data-testid="build-actions">
      {action.error !== undefined && <ErrorNote error={action.error} />}
      <div class="btn-row">
        {shown.map((name) => (
          <button
            key={name}
            type="button"
            class={name === 'apply' || name === 'resume' ? 'btn btn-primary' : 'btn btn-ghost'}
            disabled={action.busy}
            onClick={() => (dialogs[name] === undefined ? run(name) : setConfirm(name))}
            data-testid={`build-${name}`}
          >
            {labels[name]}
          </button>
        ))}
      </div>
      {can.resume && <p class="t-small muted">{t.buildResumeHint}</p>}
      {confirm !== undefined && dialog !== undefined && (
        <ConfirmModal
          title={dialog.title}
          body={dialog.body}
          confirmLabel={dialog.label}
          cancelLabel={t.cancel}
          tone={dialog.tone}
          onConfirm={() => {
            setConfirm(undefined);
            run(confirm);
          }}
          onCancel={() => setConfirm(undefined)}
        />
      )}
    </section>
  );
}

/** The whole change on the build's branch since its start (the applied commit's, once applied). */
interface BuildDiffUi {
  diff: TaskProposalUi['diff'];
  /** The integration head the diff shows: apply sends it back. */
  head?: string;
}

/** The build's diff, read again when its state or its applied tasks change. */
function useBuildDiff(build: BuildViewUi | undefined, id: string) {
  const loaded = useLoad<BuildDiffUi>(`/api/builds/${encodeURIComponent(id)}/diff`);
  const { reload } = loaded;
  const applied = build?.tasks.filter((task) => task.state === 'applied').length ?? 0;
  const state = build?.state;
  const first = useRef(true);
  useEffect(() => {
    // The first load is `useLoad`'s own.
    if (first.current) {
      first.current = false;
      return;
    }
    reload();
  }, [reload, state, applied]);
  return loaded;
}

function BuildDiff({ loaded }: { loaded: ReturnType<typeof useBuildDiff> }) {
  const { t } = useApp();
  return (
    <LoadState loaded={loaded}>
      {(data) =>
        data.diff === null ? null : (
          <section class="card" aria-labelledby="build-diff-title" data-testid="build-diff">
            <h2 class="t-2" id="build-diff-title">
              {t.buildDiffTitle}
            </h2>
            {data.diff.files.length === 0 && <p class="muted">{t.buildDiffNone}</p>}
            {data.diff.files.map((file) =>
              file.shown ? (
                <Diff key={file.path} hunks={file.hunks} file={{ path: file.path, added: file.added, removed: file.removed }} testId={`build-diff-${file.path}`} />
              ) : (
                <p key={file.path}>
                  <code>{file.path}</code> — <span class="muted">{t.taskDiffNotShown}</span>
                </p>
              ),
            )}
            {data.diff.more > 0 && <p class="muted">{t.taskDiffMore(data.diff.more)}</p>}
          </section>
        )
      }
    </LoadState>
  );
}

/** The start page once the Settings' default thresholds are loaded, so the form starts from them (review of M3, minor). */
function PlannedStart({ build, onStarted }: { build: BuildViewUi; onStarted(): void }) {
  const project = useLoad<ProjectBuildsUi>(`/api/projects/${encodeURIComponent(build.project)}/builds`);
  return <LoadState loaded={project}>{(data) => <StartForm build={build} defaults={data.thresholds} onStarted={onStarted} />}</LoadState>;
}

/** Discarding a build that never started: nothing ran, the project is free again (review of M3, I4). */
function DiscardUnstarted({ build, onDone }: { build: BuildViewUi; onDone(): void }) {
  const { t } = useApp();
  const send = useSend();
  const action = useAction();
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      {action.error !== undefined && <ErrorNote error={action.error} />}
      <div class="btn-row">
        <button type="button" class="btn btn-ghost" disabled={action.busy} onClick={() => setConfirm(true)} data-testid="build-discard">
          {t.buildDiscard}
        </button>
      </div>
      {confirm && (
        <ConfirmModal
          title={t.buildDiscardTitle}
          body={t.buildDiscardUnstartedBody}
          confirmLabel={t.buildDiscard}
          cancelLabel={t.cancel}
          onConfirm={() => {
            setConfirm(false);
            void action.run(() => send('POST', `/api/builds/${encodeURIComponent(build.id)}/discard`, { confirm: true })).then((ok) => ok && onDone());
          }}
          onCancel={() => setConfirm(false)}
        />
      )}
    </>
  );
}

export function BuildPage({ id }: { id: string }) {
  const { t } = useApp();
  const loaded = useLoad<BuildViewUi>(`/api/builds/${encodeURIComponent(id)}`);
  const build = loaded.data;
  useDocumentTitle(build === undefined ? t.buildTitle : `${t.buildTitle} · ${build.project}`);
  // A build paused for usage resumes by itself: the page keeps reading it (review of M3, minor).
  const autoResume = build?.state === 'paused' && build.pause?.reason !== 'user';
  usePoll(loaded.reload, build !== undefined && (LIVE.has(build.state) || build.pausing === true || build.cancelling === true || autoResume), autoResume ? 5000 : 1000);
  const diff = useBuildDiff(build, id);
  return (
    <LoadState loaded={loaded}>
      {(view) => (
        <>
          <header class="page-head">
            <div class="page-head-text">
              <p class="meta">
                <a class="link" href={routeHash({ page: 'project', slug: view.project })}>
                  ← {view.project}
                </a>
              </p>
              <h1 class="t-1">{t.buildTitle}</h1>
              <div class="head-status">
                <span class="chip" data-testid="build-state">
                  {t.buildState(view.state)}
                </span>
                <span class="chip chip-mono chip-outline">{view.branch}</span>
              </div>
            </div>
          </header>
          <div class="page stack-3">
            {view.state === 'planning' && <Note tone="plain" testId="build-planning">{t.buildPlanning}</Note>}
            {view.state === 'planFailed' && (
              <Note tone="danger" title={t.buildPlanFailedTitle} testId="build-plan-failed">
                {view.error}
              </Note>
            )}
            {view.state === 'discarded' && <Note tone="plain" testId="build-discarded">{t.buildDiscarded}</Note>}
            {view.waitingSlot === true && <Note tone="plain" testId="build-waiting-slot">{t.buildWaitingSlot}</Note>}
            <StatusNotes build={view} />
            {view.state === 'planned' && <PlannedStart build={view} onStarted={loaded.reload} />}
            {(view.state === 'planned' || view.state === 'planFailed') && <DiscardUnstarted build={view} onDone={loaded.reload} />}
            {view.tasks.length > 0 && (
              <Actions
                build={view}
                head={diff.data?.head}
                onDone={loaded.reload}
                onRefused={() => {
                  loaded.reload();
                  diff.reload();
                }}
              />
            )}
            {view.tasks.length > 0 && <Board build={view} />}
            {view.tasks.length > 0 && <Progress build={view} />}
            {view.tasks.length > 0 && (view.state !== 'discarded' || view.applied !== undefined) && <BuildDiff loaded={diff} />}
          </div>
        </>
      )}
    </LoadState>
  );
}
