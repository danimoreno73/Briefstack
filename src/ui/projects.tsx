import { CopyButton, Loader, Markdown } from './common.js';
import { formatWhen, isUnfinished, openCommandLines, withoutLeadingHeading } from './format.js';
import { useApp, useDocumentTitle, useLoad } from './hooks.js';
import { routeHash } from './route.js';
import type { ProjectDetail, ProjectListing, SessionSummary } from './types.js';

export function ProjectsView() {
  const { t, lang } = useApp();
  const projects = useLoad<{ projects: ProjectListing[] }>('/api/projects');
  const sessions = useLoad<{ sessions: SessionSummary[] }>('/api/sessions');
  useDocumentTitle(t.projectsTitle);
  return (
    <section>
      <h1>{t.projectsTitle}</h1>
      <Loader loaded={projects}>
        {({ projects: list }) =>
          list.length === 0 ? (
            <p class="empty">{t.projectsEmpty}</p>
          ) : (
            <div class="table-wrap">
            <table class="stack-on-phone" data-testid="projects">
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
                    <td class="id">{project.status?.target ?? '—'}</td>
                    <td>{project.status?.status ?? <span class="badge badge-warn">{t.invalidNote}</span>}</td>
                    <td>{project.status?.profile ?? '—'}</td>
                    <td class="num">{formatWhen(project.created, lang)}</td>
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
          if (unfinished.length === 0) return <p class="empty">{t.unfinishedEmpty}</p>;
          // Named by their idea, then told apart by when and where they stopped; the id last (audit M8).
          return (
            <div class="table-wrap">
              <table class="stack-on-phone" data-testid="unfinished">
                <thead>
                  <tr>
                    <th scope="col">{t.colIdea}</th>
                    <th scope="col">{t.colWhen}</th>
                    <th scope="col">{t.colStatus}</th>
                    <th scope="col">{t.colLastStep}</th>
                    <th scope="col">{t.colSession}</th>
                  </tr>
                </thead>
                <tbody>
                  {unfinished.map((session) => (
                    <tr key={session.id}>
                      <td class="idea-cell">
                        <a href={routeHash({ page: 'session', id: session.id })} class={session.idea === undefined ? 'muted' : undefined}>
                          {session.idea ?? t.ideaNotRecorded}
                        </a>
                      </td>
                      <td class="num">{formatWhen(session.lastEventAt ?? session.startedAt, lang)}</td>
                      <td>{t.outcome(session.outcome ?? session.status)}</td>
                      <td>{session.lastStep === undefined ? t.lastStep(undefined) : t.stepLabel(session.lastStep.step)}</td>
                      <td class="id">{session.id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </Loader>
    </section>
  );
}

export function ProjectView({ slug }: { slug: string }) {
  const { t, lang } = useApp();
  const loaded = useLoad<ProjectDetail>(`/api/projects/${encodeURIComponent(slug)}`);
  useDocumentTitle(loaded.data?.project.name ?? t.projectKind);
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
              <div class="page-head">
                <div class="page-head-text">
                  <p class="page-kind">{t.projectKind}</p>
                  <h1>{project.name}</h1>
                  {status?.summary !== undefined && <p class="idea">{status.summary}</p>}
                </div>
                <div class="page-actions">
                  {projectPath !== undefined && <CopyButton text={projectPath} label={t.copyPath} testId="copy-path" />}
                  {instructions !== null && <CopyButton text={instructions} label={t.copyInstructions} testId="copy-instructions" />}
                </div>
              </div>
              {status === undefined && (
                <p class="banner banner-error">
                  {t.invalidNote}. {t.invalidIssues(project.issues ?? [])}
                </p>
              )}

              {status !== undefined && (
                <div class="panel">
                  <h2>{t.statusBlock}</h2>
                  <dl data-testid="status">
                    <dt>{t.colTarget}</dt>
                    <dd class="id">{status.target}</dd>
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
                </div>
              )}

              {commands !== undefined && (
                <div class="panel">
                  <h2>{t.openInClaude}</h2>
                  <p>{t.openHint}</p>
                  <pre data-testid="open-command">{commands.join('\n')}</pre>
                  <CopyButton text={commands.join('\n')} label={t.copyCommand} testId="copy-command" />
                </div>
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
                <p class="empty">{t.timelineEmpty}</p>
              ) : (
                <div class="table-wrap">
                <table class="stack-on-phone" data-testid="timeline">
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
                  <Markdown text={withoutLeadingHeading(nextSteps, t.nextSteps)} />
                </>
              )}
            </>
          );
        }}
      </Loader>
    </section>
  );
}
