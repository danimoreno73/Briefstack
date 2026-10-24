import { useMemo, useState } from 'preact/hooks';
import { formatWhen } from './format.js';
import { useApp, useDocumentTitle, useLoad, useSend } from './hooks.js';
import { Diff } from './improve.js';
import { ConfirmModal, Empty, ErrorNote, LoadState, MetaLine, Note } from './kit.js';
import { routeHash } from './route.js';
import type { SkillDetailView, SkillFileView, SkillFindingView, SkillStatus, SkillSummaryView, SkillVersionView } from './types.js';

/**
 * The Skills page (BRIEF-phase-6 §3.4): the third-party skills of the
 * library, added from a GitHub link into quarantine, and one skill's page,
 * the only place where a skill is approved, rejected or deleted. Text that
 * comes from a skill is shown as plain text, never rendered as HTML.
 */

export function SkillsPage({ name }: { name: string | undefined }) {
  if (name !== undefined) return <SkillPage key={name} name={name} />;
  return <SkillsList />;
}

const STATUS_CHIP: Record<SkillStatus, string> = { quarantine: 'chip chip-warn', approved: 'chip chip-ok', rejected: 'chip chip-danger' };

function StatusChip({ status }: { status: SkillStatus }) {
  const { t } = useApp();
  return (
    <span class={STATUS_CHIP[status]} data-testid="skill-status" data-status={status}>
      {t.skillStatus(status)}
    </span>
  );
}

/** Tags as the user types them, comma separated. */
const splitTags = (text: string): string[] =>
  text
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');

function AddSkillForm({ onAdded }: { onAdded(name: string): void }) {
  const { t } = useApp();
  const send = useSend();
  const [url, setUrl] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await send<{ detail: SkillDetailView }>('POST', '/api/skills', { url: url.trim(), tags: splitTags(tags) });
      onAdded(result.detail.record.name);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="card stack-4" onSubmit={(event) => void submit(event)} data-testid="add-skill">
      <h2 class="t-3">{t.skillsAddTitle}</h2>
      <div class="field">
        <label class="label" for="skill-url">
          {t.skillsUrlLabel}
        </label>
        <input
          id="skill-url"
          class="input input-mono"
          type="url"
          value={url}
          placeholder="https://github.com/…"
          aria-describedby="skill-url-help"
          onInput={(event) => setUrl(event.currentTarget.value)}
          required
        />
        <p class="help" id="skill-url-help">
          {t.skillsUrlHelp}
        </p>
      </div>
      <div class="field">
        <label class="label" for="skill-tags">
          {t.skillsTagsLabel}
        </label>
        <input id="skill-tags" class="input" value={tags} onInput={(event) => setTags(event.currentTarget.value)} />
      </div>
      {error !== undefined && <ErrorNote error={error} />}
      <div class="btn-row">
        <button type="submit" class="btn btn-primary" disabled={busy || url.trim() === ''}>
          {busy ? t.skillsAdding : t.skillsAddButton}
        </button>
      </div>
    </form>
  );
}

function SkillsList() {
  const { t, lang } = useApp();
  const loaded = useLoad<{ skills: SkillSummaryView[] }>('/api/skills');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'' | SkillStatus>('');
  const [tag, setTag] = useState('');
  useDocumentTitle(t.skillsTitle);
  const allTags = useMemo(() => [...new Set((loaded.data?.skills ?? []).flatMap((skill) => skill.tags))].sort(), [loaded.data]);

  return (
    <>
      <header class="page-head">
        <div class="page-head-text">
          <h1 class="t-1">{t.skillsTitle}</h1>
          <p class="lead">{t.skillsIntro}</p>
        </div>
      </header>
      <div class="page">
        <AddSkillForm onAdded={(name) => (window.location.hash = routeHash({ page: 'skills', name }))} />
        <LoadState loaded={loaded}>
          {({ skills }) => {
            if (skills.length === 0) return <Empty title={t.skillsEmpty} />;
            const words = search.trim().toLowerCase();
            const shown = skills.filter(
              (skill) =>
                (status === '' || skill.status === status) &&
                (tag === '' || skill.tags.includes(tag)) &&
                (words === '' || `${skill.name} ${skill.description} ${skill.repo} ${skill.tags.join(' ')}`.toLowerCase().includes(words)),
            );
            return (
              <section class="stack-4">
                <div class="btn-row" role="search">
                  <div class="field">
                    <label class="label" for="skill-search">
                      {t.skillsSearchLabel}
                    </label>
                    <input id="skill-search" class="input" type="search" value={search} onInput={(event) => setSearch(event.currentTarget.value)} />
                  </div>
                  <div class="field">
                    <label class="label" for="skill-status">
                      {t.skillsFilterStatus}
                    </label>
                    <select id="skill-status" class="select" value={status} onChange={(event) => setStatus(event.currentTarget.value as '' | SkillStatus)}>
                      <option value="">{t.skillsFilterAll}</option>
                      {(['quarantine', 'approved', 'rejected'] as const).map((value) => (
                        <option key={value} value={value}>
                          {t.skillStatus(value)}
                        </option>
                      ))}
                    </select>
                  </div>
                  {allTags.length > 0 && (
                    <div class="field">
                      <label class="label" for="skill-tag">
                        {t.skillsFilterTag}
                      </label>
                      <select id="skill-tag" class="select" value={tag} onChange={(event) => setTag(event.currentTarget.value)}>
                        <option value="">{t.skillsFilterAll}</option>
                        {allTags.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
                {shown.length === 0 ? (
                  <p class="muted">{t.skillsNoMatch}</p>
                ) : (
                  <div class="table-card table-scroll">
                    <table class="table" data-testid="skills">
                      <caption class="sr-only">{t.skillsTitle}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{t.colSkill}</th>
                          <th scope="col">{t.colStatus}</th>
                          <th scope="col">{t.colTags}</th>
                          <th scope="col">{t.colSource}</th>
                          <th scope="col">{t.skillScripts}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((skill) => (
                          <tr key={skill.name} data-name={skill.name}>
                            <td class="td-name">
                              <a href={routeHash({ page: 'skills', name: skill.name })}>{skill.name}</a>
                              <p class="t-small muted">{skill.description}</p>
                            </td>
                            <td>
                              <StatusChip status={skill.status} />
                              {skill.update && <span class="chip chip-warn">{t.skillUpdateChip}</span>}
                            </td>
                            <td>{skill.tags.join(', ')}</td>
                            <td class="td-mono">
                              {skill.repo}
                              {skill.path === '' ? '' : ` · ${skill.path}`}
                              <br />
                              <span class="muted">{formatWhen(skill.statusChanged, lang)}</span>
                            </td>
                            <td>
                              {skill.hasScripts ? <span class="chip chip-warn">{t.skillScriptsChip}</span> : t.skillNo}
                              {skill.network && <span class="chip chip-warn">{t.skillNetworkChip}</span>}
                            </td>
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
      </div>
    </>
  );
}

function Findings({ findings, testId }: { findings: readonly SkillFindingView[]; testId: string }) {
  const { t } = useApp();
  if (findings.length === 0) return <p class="muted">{t.skillNoFindings}</p>;
  return (
    <ul class="suggestion-list" data-testid={testId}>
      {findings.map((finding, index) => (
        <li key={index} class="suggestion" data-rule={finding.rule} data-severity={finding.severity}>
          <MetaLine
            parts={[
              <span class={finding.severity === 'high' ? 'chip chip-danger' : finding.severity === 'medium' ? 'chip chip-warn' : 'chip'}>{t.severity(finding.severity)}</span>,
              t.findingRule(finding.rule),
              finding.file === '' ? undefined : <span class="mono">{finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`}</span>,
            ]}
          />
          {finding.excerpt !== undefined && <code class="mono t-small quote">{finding.excerpt}</code>}
        </li>
      ))}
    </ul>
  );
}

/** One file of a version, shown as plain text on demand. */
function FileRow({ name, file, version }: { name: string; file: SkillVersionView['files'][number]; version: 'current' | 'next' }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <li class="suggestion" data-path={file.path}>
      <div class="btn-row">
        <span class="mono">{file.path}</span>
        <MetaLine parts={[file.kind, `${file.size} B`, file.executable && 'x']} />
        <button type="button" class="btn btn-secondary btn-sm push-end" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t.skillFileHide : t.skillFileShow}
        </button>
      </div>
      {open && <FileText name={name} path={file.path} version={version} />}
    </li>
  );
}

function FileText({ name, path, version }: { name: string; path: string; version: 'current' | 'next' }) {
  const { t } = useApp();
  const loaded = useLoad<SkillFileView>(`/api/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}&version=${version}`);
  return (
    <LoadState loaded={loaded}>
      {(file) =>
        file.text === undefined ? (
          <p class="muted">{file.kind === 'binary' ? t.skillFileBinary : t.skillFileTooLarge}</p>
        ) : (
          <pre class="code-view" data-testid="skill-file-text">
            {file.text}
          </pre>
        )
      }
    </LoadState>
  );
}

function VersionSummary({ version }: { version: SkillVersionView }) {
  const { t, lang } = useApp();
  const yesNo = (value: boolean) => (value ? t.skillYes : t.skillNo);
  const license = version.license.spdx ?? (version.license.source === 'none' ? t.skillLicenseNone : t.skillLicenseUnknown);
  const modelTone = version.model.state === 'flagged' ? 'danger' : version.model.state === 'clear' ? 'ok' : version.model.state === 'failed' ? 'warn' : 'plain';
  const cut = version.model.cut ?? [];
  return (
    <div class="stack-4">
      <div class="stack-2">
        <h3 class="t-3">{t.skillWhatItDoes}</h3>
        <p data-testid="skill-description">{version.description === '' ? t.skillNoDescription : version.description}</p>
      </div>
      <dl class="kv" data-testid="skill-facts">
        <dt>{t.skillScripts}</dt>
        <dd data-testid="skill-has-scripts">{yesNo(version.hasScripts)}</dd>
        <dt>{t.skillNetwork}</dt>
        <dd data-testid="skill-network">{yesNo(version.network)}</dd>
        <dt>{t.skillLicense}</dt>
        <dd data-testid="skill-license">{license}</dd>
        <dt>{t.skillSource}</dt>
        <dd class="mono">
          <a class="link" href={version.source.link} target="_blank" rel="noopener noreferrer">
            {version.source.repo}
            {version.source.path === '' ? '' : ` · ${version.source.path}`}
          </a>
          <br />
          {t.skillPinned(version.source.commit.slice(0, 7), version.source.ref)}
        </dd>
        <dt>{t.skillFetched}</dt>
        <dd>{formatWhen(version.fetched, lang)}</dd>
        {version.allowedTools !== undefined && (
          <>
            <dt>{t.skillAllowedTools}</dt>
            <dd class="mono">{version.allowedTools}</dd>
          </>
        )}
      </dl>
      {version.hasScripts && (
        <Note tone="warn" testId="skill-scripts-warning">
          {t.skillScriptsWarning}
        </Note>
      )}
      <Note tone={modelTone} title={`${t.skillModelTitle}: ${t.skillModelState(version.model.state)}`} testId="skill-model">
        {version.model.reason}
      </Note>
      {cut.length > 0 && (
        <Note tone="warn" title={t.skillModelPartialTitle} testId="skill-model-partial">
          {t.skillModelPartial(cut.length)} <span class="mono">{cut.join(', ')}</span>
        </Note>
      )}
    </div>
  );
}

type Action = 'approve' | 'reject' | 'delete' | 'approveUpdate' | 'rejectUpdate';

function SkillPage({ name }: { name: string }) {
  const { t } = useApp();
  const send = useSend();
  const loaded = useLoad<SkillDetailView>(`/api/skills/${encodeURIComponent(name)}`);
  const [confirm, setConfirm] = useState<Action | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [tags, setTags] = useState<string | undefined>(undefined);
  const [checked, setChecked] = useState<'updated' | 'upToDate' | 'pinned' | undefined>(undefined);
  useDocumentTitle(name);
  const base = `/api/skills/${encodeURIComponent(name)}`;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const act = (action: Action) =>
    run(async () => {
      setConfirm(undefined);
      const path = { approve: '/approve', reject: '/reject', delete: '/delete', approveUpdate: '/update/approve', rejectUpdate: '/update/reject' }[action];
      await send('POST', `${base}${path}`);
      if (action === 'delete') window.location.hash = routeHash({ page: 'skills', name: undefined });
      else loaded.reload();
    });

  return (
    <LoadState loaded={loaded}>
      {({ record, diff }) => {
        const confirmText: Record<Action, { title: string; body: string; label: string; tone: 'danger' | 'normal' }> = {
          approve: { title: t.skillApproveTitle(name), body: t.skillApproveBody, label: t.skillApprove, tone: 'normal' },
          reject: { title: t.skillRejectTitle(name), body: t.skillRejectBody, label: t.skillReject, tone: 'danger' },
          delete: { title: t.skillDeleteTitle(name), body: t.skillDeleteBody, label: t.skillDelete, tone: 'danger' },
          approveUpdate: { title: t.skillApproveUpdateTitle, body: t.skillApproveUpdateBody, label: t.skillApproveUpdate, tone: 'normal' },
          rejectUpdate: { title: t.skillRejectUpdate, body: t.skillNextIntro, label: t.skillRejectUpdate, tone: 'danger' },
        };
        const tagText = tags ?? record.tags.join(', ');
        return (
          <>
            <header class="page-head">
              <div class="page-head-text">
                <p class="meta">
                  <a class="link" href={routeHash({ page: 'skills', name: undefined })}>
                    {t.skillsBack}
                  </a>
                </p>
                <h1 class="t-1 mono">{record.name}</h1>
                <p>
                  <StatusChip status={record.status} />
                </p>
              </div>
            </header>
            <div class="page">
              {error !== undefined && <ErrorNote error={error} />}
              <section class="card stack-4" aria-labelledby="skill-summary">
                <h2 class="section-title" id="skill-summary">
                  {t.skillSummaryTitle}
                </h2>
                <VersionSummary version={record} />
              </section>

              <section class="card stack-4" aria-labelledby="skill-actions">
                <h2 class="section-title" id="skill-actions">
                  {t.skillActionsTitle}
                </h2>
                <div class="btn-row">
                  {record.status !== 'approved' && (
                    <button type="button" class="btn btn-primary" disabled={busy} onClick={() => setConfirm('approve')}>
                      {t.skillApprove}
                    </button>
                  )}
                  {record.status !== 'rejected' && (
                    <button type="button" class="btn btn-secondary" disabled={busy} onClick={() => setConfirm('reject')}>
                      {t.skillReject}
                    </button>
                  )}
                  {record.status === 'approved' && record.next === undefined && (
                    <button
                      type="button"
                      class="btn btn-secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const result = await send<{ outcome: 'updated' | 'upToDate' | 'pinned' }>('POST', `${base}/check-update`);
                          setChecked(result.outcome);
                          if (result.outcome === 'updated') loaded.reload();
                        })
                      }
                    >
                      {busy ? t.skillChecking : t.skillCheckUpdate}
                    </button>
                  )}
                  <button type="button" class="btn btn-danger-quiet push-end" disabled={busy} onClick={() => setConfirm('delete')}>
                    {t.skillDelete}
                  </button>
                </div>
                {checked !== undefined && (
                  <Note tone={checked === 'updated' ? 'warn' : 'ok'} role="status" testId="skill-check-result">
                    {checked === 'updated' ? t.skillUpdated : checked === 'pinned' ? t.skillPinnedNote : t.skillUpToDate}
                  </Note>
                )}
                <form
                  class="btn-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      await send('PUT', `${base}/tags`, { tags: splitTags(tagText) });
                      setTags(undefined);
                      loaded.reload();
                    });
                  }}
                >
                  <div class="field">
                    <label class="label" for="skill-tags-edit">
                      {t.skillTagsTitle}
                    </label>
                    <input id="skill-tags-edit" class="input" value={tagText} onInput={(event) => setTags(event.currentTarget.value)} />
                  </div>
                  <button type="submit" class="btn btn-secondary btn-sm" disabled={busy || tags === undefined}>
                    {t.skillTagsSave}
                  </button>
                </form>
              </section>

              {record.next !== undefined && (
                <section class="dec stack-4" aria-labelledby="skill-next" data-testid="skill-next">
                  <h2 class="t-2" id="skill-next">
                    {t.skillNextTitle}
                  </h2>
                  <p class="t-small">{t.skillNextIntro}</p>
                  <VersionSummary version={record.next} />
                  <h3 class="t-3">{t.skillDiffTitle}</h3>
                  <ul class="stack-4" data-testid="skill-diff">
                    {(diff ?? []).map((file) => (
                      <li key={file.path} class="stack-2" data-path={file.path} data-change={file.change}>
                        <MetaLine parts={[<span class="mono">{file.path}</span>, t.skillDiffChange(file.change)]} />
                        {file.binary === true && <p class="muted">{t.skillDiffBinary}</p>}
                        {file.hunks !== undefined && <Diff hunks={file.hunks} />}
                      </li>
                    ))}
                  </ul>
                  <h3 class="t-3">{t.skillFindingsTitle(record.next.findings.length)}</h3>
                  <Note tone="plain" testId="skill-next-heuristic">
                    {t.skillHeuristicNote}
                  </Note>
                  <Findings findings={record.next.findings} testId="skill-next-findings" />
                  <div class="btn-row">
                    <button type="button" class="btn btn-primary" disabled={busy} onClick={() => setConfirm('approveUpdate')}>
                      {t.skillApproveUpdate}
                    </button>
                    <button type="button" class="btn btn-secondary" disabled={busy} onClick={() => setConfirm('rejectUpdate')}>
                      {t.skillRejectUpdate}
                    </button>
                  </div>
                </section>
              )}

              <section class="card stack-4" aria-labelledby="skill-findings">
                <h2 class="section-title" id="skill-findings">
                  {t.skillFindingsTitle(record.findings.length)}
                </h2>
                <Note tone="plain" testId="skill-heuristic">
                  {t.skillHeuristicNote}
                </Note>
                <Findings findings={record.findings} testId="skill-findings-list" />
              </section>

              <section class="card stack-4" aria-labelledby="skill-files">
                <h2 class="section-title" id="skill-files">
                  {t.skillFilesTitle(record.files.length)}
                </h2>
                <ul class="suggestion-list" data-testid="skill-files-list">
                  {record.files.map((file) => (
                    <FileRow key={file.path} name={record.name} file={file} version="current" />
                  ))}
                </ul>
              </section>
            </div>
            {confirm !== undefined && (
              <ConfirmModal
                title={confirmText[confirm].title}
                body={confirmText[confirm].body}
                confirmLabel={confirmText[confirm].label}
                cancelLabel={t.cancel}
                tone={confirmText[confirm].tone}
                onConfirm={() => void act(confirm)}
                onCancel={() => setConfirm(undefined)}
              />
            )}
          </>
        );
      }}
    </LoadState>
  );
}
