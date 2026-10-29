import { useEffect } from 'preact/hooks';
import { formatWhen } from './format.js';
import { useApp, useDocumentTitle, useLoad } from './hooks.js';
import { Empty, LoadState } from './kit.js';
import { STEPS } from './progress.js';
import { routeHash } from './route.js';
import type { CreationState, SettingsView, TaskViewUi } from './types.js';

/** Task states that keep a task's branch and worktree: shown in the sessions list. */
const OPEN_TASK = new Set(['running', 'checking', 'proposal', 'failed', 'cancelled', 'interrupted']);

/** What an active creation waits for, as a `waitingFor` key. */
export function waitingKind(creation: CreationState): string {
  if (creation.cancelling === true) return 'cancelling';
  if (creation.pending !== undefined) return creation.pending.kind;
  if (creation.awaitingReply !== undefined) return 'reply';
  return 'working';
}

/** Every active creation: idea, current step, what it waits for, and a link to its page and panel. */
export function CreationsPage() {
  const { t, lang } = useApp();
  const list = useLoad<{ creations: CreationState[] }>('/api/creations');
  const settings = useLoad<SettingsView>('/api/settings');
  const taskList = useLoad<{ tasks: TaskViewUi[] }>('/api/tasks');
  useDocumentTitle(t.creationsTitle);

  // Kept current while the page is open: steps and requests change by themselves.
  useEffect(() => {
    const timer = setInterval(() => {
      list.reload();
      taskList.reload();
    }, 2000);
    return () => clearInterval(timer);
  }, [list.reload, taskList.reload]);

  const newHref = routeHash({ page: 'new', id: undefined });

  return (
    <>
      <header class="page-head">
        <div class="page-head-text">
          <h1 class="t-1">{t.creationsTitle}</h1>
          <p class="lead">{t.creationsIntro}</p>
        </div>
        <div class="btn-row">
          <a class="btn btn-primary" href={newHref}>
            {t.navNew}
          </a>
        </div>
      </header>
      <div class="page">
        <LoadState loaded={list}>
          {({ creations }) => {
            const active = creations.filter((creation) => creation.status !== 'finished');
            // Tasks (phase 7): the open ones are listed; the running ones share the limit.
            const openTasks = (taskList.data?.tasks ?? []).filter((task) => OPEN_TASK.has(task.state));
            const used = active.length + openTasks.filter((task) => task.state === 'running' || task.state === 'checking').length;
            const limit = settings.data?.maxActiveCreations;
            return (
              <>
                {limit !== undefined && (
                  <div class="use-row limit-meter">
                    <span class="mono-s faint">{t.maxActiveLabel}</span>
                    <div class="meter" role="img" aria-label={t.creationsCount(used, limit)}>
                      <span class="m-now" style={{ width: `${Math.min(100, (used / Math.max(1, limit)) * 100)}%` }} />
                    </div>
                    <span class="mono-s">
                      <span data-testid="creations-count">{t.creationsCount(used, limit)}</span>{' '}
                      <a class="link" href={routeHash({ page: 'settings' })}>
                        {t.changeLimit}
                      </a>
                    </span>
                  </div>
                )}
                {active.length === 0 && openTasks.length > 0 ? null : active.length === 0 ? (
                  <Empty title={t.creationsEmpty} action={{ href: newHref, label: t.navNew }} />
                ) : (
                  <ul class="stack-4" data-testid="creations">
                    {active.map((creation) => {
                      const kind = waitingKind(creation);
                      // What waits for the user is cream; working and cancelling stay quiet (audit M18).
                      const forYou = kind !== 'working' && kind !== 'cancelling';
                      const stepIndex = creation.currentStep === undefined ? -1 : (STEPS as readonly string[]).indexOf(creation.currentStep);
                      return (
                        <li key={creation.id} class={forYou ? 'cr-card dec' : 'cr-card'} data-creation={creation.id}>
                          <div class="cr-meta">
                            <div class="cr-top">
                              <span class="mono-s">{formatWhen(creation.startedAt, lang)}</span>
                              {creation.currentStep !== undefined && (
                                <span class="chip">
                                  {!forYou && kind === 'working' && <span class="dot pulse" />}
                                  {stepIndex === -1 ? t.stepLabel(creation.currentStep) : t.stepOf(t.stepLabel(creation.currentStep), stepIndex + 1, STEPS.length)}
                                </span>
                              )}
                            </div>
                            <h2 class="cr-title">{creation.idea.slice(0, 300)}</h2>
                            <p class={forYou ? 'strong' : 'muted'}>
                              {forYou ? `${t.waitingForYou}: ` : ''}
                              <span data-testid="waiting">{t.waitingFor(kind)}</span>
                            </p>
                          </div>
                          <a class={forYou ? 'btn btn-primary' : 'btn btn-secondary'} href={routeHash({ page: 'new', id: creation.id })}>
                            {t.openCreation}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {openTasks.length > 0 && (
                  <section class="stack-2" aria-labelledby="session-tasks-title">
                    <h2 class="t-2" id="session-tasks-title">
                      {t.sessionsTasks}
                    </h2>
                    <ul class="stack-4" data-testid="session-tasks">
                      {openTasks.map((task) => {
                        const forYou = task.pending !== undefined || task.awaitingReply !== undefined || task.state === 'proposal';
                        return (
                          <li key={task.id} class={forYou ? 'cr-card dec' : 'cr-card'} data-task={task.id}>
                            <div class="cr-meta">
                              <div class="cr-top">
                                <span class="chip chip-outline">{t.sessionsTaskKind}</span>
                                <span class="chip">{task.project}</span>
                                <span class="mono-s">{formatWhen(task.createdAt, lang)}</span>
                              </div>
                              <h2 class="cr-title">{task.description.split(/\r?\n/, 1)[0]}</h2>
                              <p class={forYou ? 'strong' : 'muted'} data-testid="task-session-state">
                                {t.taskState(task.state)}
                              </p>
                            </div>
                            <a class={forYou ? 'btn btn-primary' : 'btn btn-secondary'} href={routeHash({ page: 'task', id: task.id })}>
                              {t.taskOpen}
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
                {active.length > 0 && limit !== undefined && used < limit && (
                  <div class="card card-dash free-slots">
                    <span class="muted">{t.freeSlots(limit - used)}</span>
                    <a class="btn btn-ghost btn-sm" href={newHref}>
                      {t.startAnother}
                    </a>
                  </div>
                )}
              </>
            );
          }}
        </LoadState>
      </div>
    </>
  );
}
