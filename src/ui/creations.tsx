import { useEffect } from 'preact/hooks';
import { Loader } from './common.js';
import { useApp, useLoad } from './hooks.js';
import { routeHash } from './route.js';
import type { CreationState, SettingsView } from './types.js';

/** What an active creation waits for, as a `waitingFor` key. */
export function waitingKind(creation: CreationState): string {
  if (creation.cancelling === true) return 'cancelling';
  if (creation.pending !== undefined) return creation.pending.kind;
  if (creation.awaitingReply !== undefined) return 'reply';
  return 'working';
}

/** Every active creation: idea, current step, what it waits for, and a link to its page and panel. */
export function CreationsPage() {
  const { t } = useApp();
  const list = useLoad<{ creations: CreationState[] }>('/api/creations');
  const settings = useLoad<SettingsView>('/api/settings');

  // Kept current while the page is open: steps and requests change by themselves.
  useEffect(() => {
    const timer = setInterval(() => list.reload(), 2000);
    return () => clearInterval(timer);
  }, [list.reload]);

  return (
    <section>
      <h1>{t.creationsTitle}</h1>
      <Loader loaded={list}>
        {({ creations }) => {
          const active = creations.filter((creation) => creation.status !== 'finished');
          return (
            <>
              {settings.data !== undefined && (
                <p class="muted" data-testid="creations-count">
                  {t.creationsCount(active.length, settings.data.maxActiveCreations)}
                </p>
              )}
              {active.length === 0 ? (
                <p class="empty">{t.creationsEmpty}</p>
              ) : (
                <div class="table-wrap">
                  <table data-testid="creations">
                    <thead>
                      <tr>
                        <th scope="col">{t.colIdea}</th>
                        <th scope="col">{t.colStep}</th>
                        <th scope="col">{t.colWaiting}</th>
                        <th scope="col">
                          <span class="visually-hidden">{t.openCreation}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {active.map((creation) => (
                        <tr key={creation.id} data-creation={creation.id}>
                          <td>{creation.idea.slice(0, 120)}</td>
                          <td>{creation.currentStep === undefined ? '—' : t.stepLabel(creation.currentStep)}</td>
                          <td data-testid="waiting">{t.waitingFor(waitingKind(creation))}</td>
                          <td>
                            <a href={routeHash({ page: 'new', id: creation.id })}>{t.openCreation}</a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          );
        }}
      </Loader>
    </section>
  );
}
