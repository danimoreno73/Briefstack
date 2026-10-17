import { CopyButton, Loader, Markdown } from './common.js';
import { formatWhen, isUnfinished, openCommandLines } from './format.js';
import { useApp, useLoad } from './hooks.js';
import { routeHash } from './route.js';
import type { ProjectDetail, ProjectListing, SessionSummary } from './types.js';

export function ProjectsView() {
  const { t, lang } = useApp();
  const projects = useLoad<{ projects: ProjectListing[] }>('/api/projects');
  const sessions = useLoad<{ sessions: SessionSummary[] }>('/api/sessions');
  return (
    <section>
      <h1>{t.projectsTitle}</h1>
      <Loader loaded={projects}>
        {({ projects: list }) =>
          list.length === 0 ? (
            <p>{t.projectsEmpty}</p>
          ) : (
            <div class="table-wrap">
            <table data-testid="projects">
              <thead>
                <tr>
                  <th>{t.colName}</th>
                  <th>{t.colTarget}</th>
                  <th>{t.colStatus}</th>
                  <th>{t.colProfile}</th>
                  <th>{t.colCreated}</th>
                  <th>{t.colPath}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((project) => (
                  <tr key={project.slug}>
                    <td>
                      <a href={routeHash({ page: 'project', slug: project.slug })}>{project.name}</a>
                    </td>
                    <td>{project.status?.target ?? '—'}</td>
                    <td>{project.status?.status ?? <span class="badge badge-warn">{t.invalidNote}</span>}</td>
                    <td>{project.status?.profile ?? '—'}</td>
                    <td>{formatWhen(project.created, lang)}</td>
                    <td class="path">{project.status?.path ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )
        }
      </Loader>

      <h2>{t.unfinishedTitle}</h2>
      <Loader loaded={sessions}>
        {({ sessions: all }) => {
          const unfinished = all.filter(isUnfinished);
          if (unfinished.length === 0) return <p>{t.unfinishedEmpty}</p>;
          return (
            <ul data-testid="unfinished">
              {unfinished.map((session) => (
                <li key={session.id}>
                  <a href={routeHash({ page: 'session', id: session.id })}>
                    <code>{session.id}</code>
                  </a>{' '}
                  · {t.outcome(session.outcome ?? session.status)} ·{' '}
                  {formatWhen(session.lastEventAt ?? session.startedAt, lang)} · {t.lastStep(session.lastStep?.step)}
                </li>
              ))}
            </ul>
          );
        }}
      </Loader>
    </section>
  );
}

export function ProjectView({ slug }: { slug: string }) {
  const { t, lang } = useApp();
  const loaded = useLoad<ProjectDetail>(`/api/projects/${encodeURIComponent(slug)}`);
  return (
    <section>
      <p>
        <a href={routeHash({ page: 'projects' })}>← {t.allProjects}</a>
      </p>
      <Loader loaded={loaded}>
        {(detail) => {
          const { project, timeline, nextSteps, instructions, openCommand, targetChoice } = detail;
          const status = project.status;
          const projectPath = openCommand?.cwd ?? status?.path;
          const commands = openCommand === null ? undefined : openCommandLines(openCommand.cwd, openCommand.command);
          return (
            <>
              <h1>{project.name}</h1>
              {status?.summary !== undefined && <p>{status.summary}</p>}
              {status === undefined && (
                <p class="banner banner-error">
                  {t.invalidNote}. {t.invalidIssues(project.issues ?? [])}
                </p>
              )}

              {status !== undefined && (
                <>
                  <h2>{t.statusBlock}</h2>
                  <dl data-testid="status">
                    <dt>{t.colTarget}</dt>
                    <dd>{status.target}</dd>
                    {targetChoice?.chosenBy !== undefined && (
                      <>
                        <dt>{t.targetChosenBy}</dt>
                        <dd data-testid="target-chosen-by">{t.chooser(targetChoice.chosenBy)}</dd>
                      </>
                    )}
                    {targetChoice?.reason !== undefined && (
                      <>
                        <dt>{t.targetReason}</dt>
                        <dd>{targetChoice.reason}</dd>
                      </>
                    )}
                    <dt>{t.colStatus}</dt>
                    <dd>{status.status}</dd>
                    <dt>{t.colProfile}</dt>
                    <dd>{status.profile}</dd>
                    <dt>{t.colCreated}</dt>
                    <dd>{formatWhen(project.created, lang)}</dd>
                    <dt>{t.colPath}</dt>
                    <dd class="path">{status.path}</dd>
                  </dl>
                </>
              )}

              <div class="actions">
                {projectPath !== undefined && <CopyButton text={projectPath} label={t.copyPath} testId="copy-path" />}
                {instructions !== null && (
                  <CopyButton text={instructions} label={t.copyInstructions} testId="copy-instructions" />
                )}
              </div>

              {commands !== undefined && (
                <>
                  <h2>{t.openInClaude}</h2>
                  <p>{t.openHint}</p>
                  <pre data-testid="open-command">{commands.join('\n')}</pre>
                  <CopyButton text={commands.join('\n')} label={t.copyCommand} testId="copy-command" />
                </>
              )}

              <h2>{t.timelineTitle}</h2>
              {project.session !== undefined && timeline !== null && (
                <p>
                  <a href={routeHash({ page: 'session', id: project.session })} data-testid="open-panel">
                    {t.panelOpen}
                  </a>
                </p>
              )}
              {timeline === null || timeline.steps.length === 0 ? (
                <p>{t.timelineEmpty}</p>
              ) : (
                <div class="table-wrap">
                <table data-testid="timeline">
                  <thead>
                    <tr>
                      <th>{t.stepColumn}</th>
                      <th>{t.startedColumn}</th>
                      <th>{t.finishedColumn}</th>
                      <th>{t.resultColumn}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {timeline.steps.map((step) => (
                      <tr key={`${step.step}-${step.startedAt}`}>
                        <td>{step.step}</td>
                        <td>{formatWhen(step.startedAt, lang)}</td>
                        <td>{formatWhen(step.finishedAt, lang)}</td>
                        <td>{step.outcome === undefined ? t.stillRunning : t.outcome(step.outcome)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}

              {nextSteps !== null && (
                <>
                  <h2>{t.nextSteps}</h2>
                  <Markdown text={nextSteps} />
                </>
              )}
            </>
          );
        }}
      </Loader>
    </section>
  );
}
