import { CopyButton, Markdown, PathText } from './common.js';
import { formatWhen, isUnfinished, openCommandLines, withoutLeadingHeading } from './format.js';
import { useApp, useDocumentTitle, useLoad } from './hooks.js';
import { setIdeaDraft } from './ideaDraft.js';
import { Empty, LoadState, MetaLine, Note } from './kit.js';
import { routeHash } from './route.js';
import type { ProjectDetail, ProjectListing, SessionSummary } from './types.js';

export function ProjectsView() {
  const { t, lang } = useApp();
  const projects = useLoad<{ projects: ProjectListing[] }>('/api/projects');
  const sessions = useLoad<{ sessions: SessionSummary[] }>('/api/sessions');
  useDocumentTitle(t.projectsTitle);

  /** Opens New project with this idea in the box (the idea as `/api/sessions` gives it: redacted, maybe cut). */
  const startAgain = (idea: string) => {
    setIdeaDraft(idea);
    window.location.hash = routeHash({ page: 'new', id: undefined });
  };

  return (
    <>
      <header class="page-head">
        <div class="page-head-text">
          <h1 class="t-1">{t.projectsTitle}</h1>
          <p class="lead">{t.projectsIntro}</p>
        </div>
        <div class="btn-row">
          <a class="btn btn-primary" href={routeHash({ page: 'new', id: undefined })}>
            {t.navNew}
          </a>
        </div>
      </header>
      <div class="page">
        <LoadState loaded={projects}>
          {({ projects: list }) =>
            list.length === 0 ? (
              <Empty title={t.projectsEmpty} action={{ href: routeHash({ page: 'new', id: undefined }), label: t.navNew }} />
            ) : (
              <div class="table-card">
                <table class="table" data-testid="projects">
                  <caption class="sr-only">{t.projectsTitle}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t.colName}</th>
                      <th scope="col">{t.colTarget}</th>
                      <th scope="col">{t.colStatus}</th>
                      <th scope="col">{t.colProfile}</th>
                      <th scope="col" class="th-num">
                        {t.colCreated}
                      </th>
                      <th scope="col">{t.colPath}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((project) => (
                      <tr key={project.slug}>
                        <td class="td-name">
                          <a href={routeHash({ page: 'project', slug: project.slug })}>{project.name}</a>
                        </td>
                        <td class="td-mono">{project.status?.target ?? '—'}</td>
                        <td>{project.status === undefined ? <span class="chip chip-warn">{t.invalidNote}</span> : <span class="chip">{project.status.status}</span>}</td>
                        <td>{project.status?.profile ?? '—'}</td>
                        <td class="td-mono td-num">{formatWhen(project.created, lang)}</td>
                        <td class="td-mono td-path">{project.status?.path === undefined ? '—' : <PathText value={project.status.path} />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </LoadState>

        <section class="stack-4" aria-labelledby="unfinished-title">
          <div class="stack-2">
            <h2 class="section-title" id="unfinished-title">
              {t.unfinishedTitle}
            </h2>
            <p class="sub">{t.unfinishedIntro}</p>
          </div>
          <LoadState loaded={sessions}>
            {({ sessions: all }) => {
              const unfinished = all.filter(isUnfinished);
              if (unfinished.length === 0) return <p class="muted">{t.unfinishedEmpty}</p>;
              // Named by their idea, then told apart by when and where they stopped; the id too (audit M8).
              return (
                <ul class="card-grid" data-testid="unfinished">
                  {unfinished.map((session) => (
                    <li key={session.id} class="card">
                      <h3 class="t-3">
                        <a class={session.idea === undefined ? 'link muted' : 'link'} href={routeHash({ page: 'session', id: session.id })}>
                          {session.idea ?? t.ideaNotRecorded}
                        </a>
                      </h3>
                      <MetaLine
                        parts={[
                          session.id,
                          t.outcome(session.outcome ?? session.status),
                          session.lastStep === undefined ? t.lastStep(undefined) : t.stepLabel(session.lastStep.step),
                          formatWhen(session.lastEventAt ?? session.startedAt, lang),
                        ]}
                      />
                      {session.idea !== undefined && (
                        <div class="btn-row">
                          <button type="button" class="btn btn-secondary btn-sm" onClick={() => startAgain(session.idea ?? '')}>
                            {t.startAgain}
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              );
            }}
          </LoadState>
        </section>
      </div>
    </>
  );
}

export function ProjectView({ slug }: { slug: string }) {
  const { t, lang } = useApp();
  const loaded = useLoad<ProjectDetail>(`/api/projects/${encodeURIComponent(slug)}`);
  useDocumentTitle(loaded.data?.project.name ?? t.projectKind);
  return (
    <LoadState loaded={loaded}>
      {(detail) => {
        const { project, timeline, nextSteps, instructions, openCommand, targetChoice } = detail;
        const status = project.status;
        const projectPath = openCommand?.cwd ?? status?.path;
        const commands = openCommand === null ? undefined : openCommandLines(openCommand.cwd, openCommand.command).join('\n');
        const isApp = status?.target === 'claude-app';
        return (
          <>
            <header class="page-head">
              <div class="page-head-text">
                <p class="meta">
                  <a class="link" href={routeHash({ page: 'projects' })}>
                    ← {t.allProjects}
                  </a>
                </p>
                <h1 class="t-1">{project.name}</h1>
                {status !== undefined && (
                  <div class="head-status">
                    <span class="chip">{status.status}</span>
                    <span class="chip chip-mono chip-outline">
                      {status.target}
                      {targetChoice?.chosenBy !== undefined && ` · ${t.chosenBy(t.chooser(targetChoice.chosenBy))}`}
                    </span>
                    {project.session !== undefined && <span class="mono-s faint">{project.session}</span>}
                  </div>
                )}
              </div>
            </header>
            <div class="page">
              {status === undefined && (
                <Note tone="danger" title={t.invalidNote}>
                  {t.invalidIssues(project.issues ?? [])}
                </Note>
              )}
              <div class="cols">
                <div class="col-main">
                  {nextSteps !== null && (
                    <section class="card" aria-labelledby="next-title">
                      <h2 class="t-2" id="next-title">
                        {t.nextSteps}
                      </h2>
                      <Markdown text={withoutLeadingHeading(nextSteps, t.nextSteps)} cls="md" />
                    </section>
                  )}
                  {isApp && instructions !== null && (
                    <section class="card" aria-labelledby="app-title">
                      <h2 class="t-2" id="app-title">
                        {t.openInApp}
                      </h2>
                      <p class="sub">{t.openInAppHint}</p>
                      <pre class="request request-clip">{instructions}</pre>
                      <div class="btn-row">
                        <CopyButton text={instructions} label={t.copyInstructions} testId="copy-instructions" cls="btn btn-primary" />
                      </div>
                    </section>
                  )}
                  {commands !== undefined && (
                    <section class="card" aria-labelledby="code-title">
                      <h2 class="t-2" id="code-title">
                        {t.openInClaude}
                      </h2>
                      <p class="sub">{t.openHint}</p>
                      <div class="command-row">
                        <pre class="request" data-testid="open-command">
                          {commands}
                        </pre>
                        <CopyButton text={commands} label={t.copyCommand} testId="copy-command" cls={isApp ? 'btn btn-secondary' : 'btn btn-primary'} />
                      </div>
                    </section>
                  )}

                  <section class="card card-flush" aria-labelledby="history-title">
                    <div class="card-head">
                      <h2 class="t-2" id="history-title">
                        {t.timelineTitle}
                      </h2>
                    </div>
                    {timeline === null || timeline.steps.length === 0 ? (
                      <p class="muted card-foot">{t.timelineEmpty}</p>
                    ) : (
                      <div class="table-scroll">
                        <table class="table" data-testid="timeline">
                          <thead>
                            <tr>
                              <th scope="col">{t.stepColumn}</th>
                              <th scope="col">{t.startedColumn}</th>
                              <th scope="col">{t.finishedColumn}</th>
                              <th scope="col">{t.resultColumn}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {timeline.steps.map((step) => (
                              <tr key={`${step.step}-${step.startedAt}`}>
                                <td>{t.stepLabel(step.step)}</td>
                                <td class="td-mono">{formatWhen(step.startedAt, lang)}</td>
                                <td class="td-mono">{formatWhen(step.finishedAt, lang)}</td>
                                <td>{step.outcome === undefined ? t.stillRunning : t.outcome(step.outcome)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {project.session !== undefined && timeline !== null && (
                      <p class="card-foot">
                        <a class="link" href={routeHash({ page: 'session', id: project.session })} data-testid="open-panel">
                          {t.panelOpen}
                        </a>
                      </p>
                    )}
                  </section>
                </div>

                {status !== undefined && (
                  <aside class="col-side">
                    <section class="card" aria-labelledby="summary-title">
                      <h2 class="t-2" id="summary-title">
                        {t.statusBlock}
                      </h2>
                      {status.summary !== undefined && <p class="muted">{status.summary}</p>}
                      <hr class="divider" />
                      <dl class="kv" data-testid="status">
                        <dt>{t.colStatus}</dt>
                        <dd>{status.status}</dd>
                        <dt>{t.colTarget}</dt>
                        <dd class="mono">{status.target}</dd>
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
                        <dt>{t.colProfile}</dt>
                        <dd>{status.profile}</dd>
                        <dt>{t.colCreated}</dt>
                        <dd class="mono">{formatWhen(project.created, lang)}</dd>
                        <dt>{t.colPath}</dt>
                        <dd class="mono td-path">
                          <PathText value={status.path} />
                        </dd>
                      </dl>
                      {projectPath !== undefined && (
                        <div class="btn-row">
                          <CopyButton text={projectPath} label={t.copyPath} testId="copy-path" cls="btn btn-secondary btn-sm" />
                        </div>
                      )}
                    </section>
                  </aside>
                )}
              </div>
            </div>
          </>
        );
      }}
    </LoadState>
  );
}
