import { useEffect, useState } from 'preact/hooks';
import { ApiError } from './apiError.js';
import { describeError } from './errors.js';
import { formatWhen } from './format.js';
import { useApp, useDocumentTitle, useLoad, useSend } from './hooks.js';
import { ConfirmModal, ErrorNote, LoadState, Note, UsageWarningModal, usageWarningIn } from './kit.js';
import { routeHash } from './route.js';
import type { BuildViewUi, ProjectBuildsUi, QueueItemUi, UsageWarningView } from './types.js';

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

/** A queue item being edited: its dependencies are kept by key, so moving or removing items keeps them right. */
interface Draft extends Omit<QueueItemUi, 'dependsOn'> {
  key: number;
  deps: number[];
}

function StartForm({ build, onStarted, defaults }: { build: BuildViewUi; onStarted(): void; defaults: { fiveHour: number; week: number } }) {
  const { t } = useApp();
  const send = useSend();
  const plan = build.plan;
  const [items, setItems] = useState<Draft[]>(() => (plan?.tasks ?? []).map((task, i) => ({ key: i + 1, title: task.title, instruction: task.instruction, doneWhen: task.doneWhen, deps: [...task.dependsOn] })));
  const [limit, setLimit] = useState(String(plan?.tasks.length ?? 1));
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
  const remove = (key: number) => setItems((current) => current.filter((item) => item.key !== key).map((item) => ({ ...item, deps: item.deps.filter((dep) => dep !== key) })));
  const queue = (): QueueItemUi[] => items.map((item) => ({ title: item.title, instruction: item.instruction, doneWhen: item.doneWhen, dependsOn: item.deps.map(position).filter((n) => n > 0) }));

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
          confirm: true,
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
            <div class="btn-row">
              <button type="button" class="btn btn-ghost btn-sm" disabled={i === 0} onClick={() => move(i, -1)}>
                {t.buildTaskUp}
              </button>
              <button type="button" class="btn btn-ghost btn-sm" disabled={i === items.length - 1} onClick={() => move(i, 1)} data-testid="build-item-down">
                {t.buildTaskDown}
              </button>
              <button type="button" class="btn btn-ghost btn-sm" onClick={() => remove(item.key)} data-testid="build-item-remove">
                {t.buildTaskRemove}
              </button>
            </div>
          </li>
        ))}
      </ol>
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
        <button type="button" class="btn btn-primary" disabled={action.busy || items.length === 0} onClick={() => setConfirm(true)} data-testid="build-start">
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
  const { t } = useApp();
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
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---- one build -----------------------------------------------------------------------------------

export function BuildPage({ id }: { id: string }) {
  const { t } = useApp();
  const loaded = useLoad<BuildViewUi>(`/api/builds/${encodeURIComponent(id)}`);
  const project = useLoad<ProjectBuildsUi>(loaded.data === undefined ? `/api/builds/${encodeURIComponent(id)}` : `/api/projects/${encodeURIComponent(loaded.data.project)}/builds`);
  const build = loaded.data;
  useDocumentTitle(build === undefined ? t.buildTitle : `${t.buildTitle} · ${build.project}`);
  usePoll(loaded.reload, build !== undefined && (LIVE.has(build.state) || build.pausing === true || build.cancelling === true));
  const defaults = (project.data as ProjectBuildsUi | undefined)?.thresholds ?? { fiveHour: 80, week: 90 };
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
            {view.state === 'planned' && <StartForm build={view} defaults={defaults} onStarted={loaded.reload} />}
            {view.tasks.length > 0 && <Progress build={view} />}
          </div>
        </>
      )}
    </LoadState>
  );
}
