import { useEffect, useState } from 'preact/hooks';
import { MANY_CREATIONS_NOTE_ABOVE } from '../config/limits.js';
import { isLang } from '../i18n/index.js';
import { api } from './api.js';
import { ClaudeCard } from './claude.js';
import { PathText } from './common.js';
import { useApp, useDocumentTitle, useLoad, useSend } from './hooks.js';
import { ErrorNote, LoadState, Note } from './kit.js';
import type { PathsView, SettingsView } from './types.js';

/** The quick picks beside the limit's field; any whole number from 1 up is still allowed (BRIEF-phase-4 §8). */
const QUICK_LIMITS = [1, 2, 3, 4, 5];

export function SettingsPage() {
  const { t, setLang, token } = useApp();
  const loaded = useLoad<SettingsView>('/api/settings');
  const paths = useLoad<PathsView>('/api/paths');
  const send = useSend();
  const settings = loaded.data;
  const [projectsDir, setProjectsDir] = useState('');
  const [language, setLanguage] = useState('');
  const [policy, setPolicy] = useState<'ask' | 'unattended'>('ask');
  const [maxActive, setMaxActive] = useState('');
  const [warnFiveHour, setWarnFiveHour] = useState('');
  const [warnWeek, setWarnWeek] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [saved, setSaved] = useState(false);
  const [willCreate, setWillCreate] = useState(false);
  useDocumentTitle(t.settingsTitle);

  useEffect(() => {
    if (settings === undefined) return;
    setProjectsDir(settings.projectsDir);
    setLanguage(settings.configLang ?? '');
    setPolicy(settings.permissionPolicy);
    setMaxActive(String(settings.maxActiveCreations));
    setWarnFiveHour(String(settings.usageWarning.fiveHour));
    setWarnWeek(String(settings.usageWarning.week));
  }, [settings]);

  // Before saving, say whether the folder exists: a missing one is created by the save.
  useEffect(() => {
    if (settings === undefined || projectsDir.trim() === '' || projectsDir === settings.projectsDir) {
      setWillCreate(false);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      api<{ status: string }>(token, 'GET', `/api/paths/check?dir=${encodeURIComponent(projectsDir.trim())}`).then(
        (result) => current && setWillCreate(result.status === 'missing'),
        () => current && setWillCreate(false),
      );
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [projectsDir, settings, token]);

  const save = async (event: Event) => {
    event.preventDefault();
    if (settings === undefined) return;
    const body: Record<string, unknown> = {};
    if (projectsDir !== settings.projectsDir) body.projectsDir = projectsDir;
    if (language !== (settings.configLang ?? '')) body.lang = language === '' ? null : language;
    if (policy !== settings.permissionPolicy) body.permissionPolicy = policy;
    if (maxActive.trim() !== String(settings.maxActiveCreations)) body.maxActiveCreations = Number(maxActive.trim());
    if (warnFiveHour.trim() !== String(settings.usageWarning.fiveHour)) body.usageWarnFiveHour = Number(warnFiveHour.trim());
    if (warnWeek.trim() !== String(settings.usageWarning.week)) body.usageWarnWeek = Number(warnWeek.trim());
    if (Object.keys(body).length === 0) return;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      const next = await send<SettingsView>('PUT', '/api/settings', body);
      if (isLang(next.lang)) setLang(next.lang);
      setSaved(true);
      loaded.reload();
      paths.reload();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const languages: { value: string; label: string }[] = [
    { value: '', label: t.langSystem },
    { value: 'en', label: t.langEn },
    { value: 'es', label: t.langEs },
  ];
  const policies: { value: 'ask' | 'unattended'; label: string; hint: string }[] = [
    { value: 'ask', label: t.policyAsk, hint: t.policyAskHint },
    { value: 'unattended', label: t.policyUnattended, hint: t.policyUnattendedHint },
  ];

  return (
    <>
      <header class="page-head">
        <div class="page-head-text">
          <h1 class="t-1">{t.settingsTitle}</h1>
          <p class="lead">{t.settingsIntro}</p>
        </div>
      </header>
      <div class="page">
        <ClaudeCard />
        <LoadState loaded={loaded}>
          {() => (
            <form class="settings" onSubmit={(event) => void save(event)}>
              {error !== undefined && <ErrorNote error={error} />}
              {saved && (
                <Note tone="ok" role="status">
                  {t.settingsSaved}
                </Note>
              )}

              <section class="card card-roomy">
                <h2 class="t-2" id="dir-title">
                  {t.projectsDirLabel}
                </h2>
                <div class="field">
                  <label class="label" for="projects-dir">
                    {t.projectsDirLabel}
                  </label>
                  <input
                    id="projects-dir"
                    class="input input-mono"
                    type="text"
                    value={projectsDir}
                    spellcheck={false}
                    aria-describedby="projects-dir-hint"
                    onInput={(event) => setProjectsDir(event.currentTarget.value)}
                  />
                  <p class="help" id="projects-dir-hint">
                    {t.projectsDirHint}
                  </p>
                  {willCreate && (
                    <Note tone="warn" role="status" testId="folder-note">
                      {t.folderWillBeCreated}
                    </Note>
                  )}
                </div>
              </section>

              <section class="card card-roomy" aria-labelledby="lang-title">
                <h2 class="t-2" id="lang-title">
                  {t.languageLabel}
                </h2>
                <div class="seg" role="group" aria-labelledby="lang-title">
                  {languages.map((option) => (
                    <button key={option.value} type="button" aria-pressed={language === option.value} onClick={() => setLanguage(option.value)}>
                      {option.label}
                    </button>
                  ))}
                </div>
              </section>

              <section class="card card-roomy" aria-labelledby="policy-title">
                <h2 class="t-2" id="policy-title">
                  {t.policyLabel}
                </h2>
                <fieldset>
                  <legend class="sr-only">{t.policyLabel}</legend>
                  <div class="choice">
                    {policies.map((option) => (
                      <label key={option.value} class="choice-item">
                        <input class="opt-input" type="radio" name="policy" checked={policy === option.value} onChange={() => setPolicy(option.value)} />
                        <span class="c-t">{option.label}</span>
                        <span class="c-d">{option.hint}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </section>

              <section class="card card-roomy">
                <h2 class="t-2" id="limit-title">
                  {t.maxActiveLabel}
                </h2>
                <div class="limit-row">
                  <div class="field">
                    <label class="label" for="max-active">
                      {t.maxActiveLabel}
                    </label>
                    <input
                      id="max-active"
                      class="input input-mono limit-input"
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      value={maxActive}
                      aria-describedby="max-active-hint"
                      onInput={(event) => setMaxActive(event.currentTarget.value)}
                    />
                  </div>
                  <div class="steps-pick" role="group" aria-label={t.maxActiveQuick}>
                    {QUICK_LIMITS.map((value) => (
                      <button key={value} type="button" aria-pressed={maxActive.trim() === String(value)} onClick={() => setMaxActive(String(value))}>
                        {value}
                      </button>
                    ))}
                  </div>
                </div>
                <p class="help" id="max-active-hint">
                  {t.maxActiveHint}
                </p>
                {Number(maxActive) > MANY_CREATIONS_NOTE_ABOVE && (
                  <Note tone="warn" role="status" testId="max-active-note">
                    {t.maxActiveNote}
                  </Note>
                )}
              </section>

              <section class="card card-roomy" aria-labelledby="usage-warn-title">
                <h2 class="t-2" id="usage-warn-title">
                  {t.settingsUsageWarnTitle}
                </h2>
                <div class="limit-row">
                  <div class="field">
                    <label class="label" for="warn-five-hour">
                      {t.settingsWarnFiveHour}
                    </label>
                    <input
                      id="warn-five-hour"
                      class="input input-mono limit-input"
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      inputMode="numeric"
                      value={warnFiveHour}
                      aria-describedby="usage-warn-hint"
                      onInput={(event) => setWarnFiveHour(event.currentTarget.value)}
                    />
                  </div>
                  <div class="field">
                    <label class="label" for="warn-week">
                      {t.settingsWarnWeek}
                    </label>
                    <input
                      id="warn-week"
                      class="input input-mono limit-input"
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      inputMode="numeric"
                      value={warnWeek}
                      aria-describedby="usage-warn-hint"
                      onInput={(event) => setWarnWeek(event.currentTarget.value)}
                    />
                  </div>
                </div>
                <p class="help" id="usage-warn-hint">
                  {t.settingsUsageWarnHelp}
                </p>
              </section>

              <div class="btn-row">
                <button type="submit" class="btn btn-primary" disabled={busy}>
                  {busy ? t.saving : t.save}
                </button>
              </div>
            </form>
          )}
        </LoadState>

        <section class="card card-roomy settings" aria-labelledby="paths-title">
          <h2 class="t-2" id="paths-title">
            {t.pathsTitle}
          </h2>
          <LoadState loaded={paths}>
            {(view) => (
              <dl class="kv paths-kv" data-testid="paths">
                <dt>{t.pathHome}</dt>
                <dd class="mono">
                  <PathText value={view.home} />
                </dd>
                <dt>{t.pathConfig}</dt>
                <dd class="mono">
                  <PathText value={view.configFile} />
                </dd>
                <dt>{t.pathLibrary}</dt>
                <dd class="mono">
                  <PathText value={view.libraryDir} />
                </dd>
                <dt>{t.pathProjects}</dt>
                <dd class="mono">
                  <PathText value={view.projectsDir} />
                </dd>
                <dt>{t.pathSessions}</dt>
                <dd class="mono">
                  <PathText value={view.sessionsDir} />
                </dd>
                <dt>{t.pathRepo}</dt>
                <dd class="mono">
                  <PathText value={view.repoDir} />
                </dd>
                <dt>{t.pathAllowed}</dt>
                <dd>
                  {view.allowedDirs.length === 0 ? (
                    t.none
                  ) : (
                    <ul class="path-list">
                      {view.allowedDirs.map((dir) => (
                        <li key={dir} class="chip chip-mono">
                          <PathText value={dir} />
                        </li>
                      ))}
                    </ul>
                  )}
                </dd>
              </dl>
            )}
          </LoadState>
        </section>
      </div>
    </>
  );
}
