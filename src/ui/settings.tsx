import { useEffect, useState } from 'preact/hooks';
import { MANY_CREATIONS_NOTE_ABOVE } from '../config/limits.js';
import { isLang } from '../i18n/index.js';
import { api } from './api.js';
import { ErrorBanner, Loader, Notice } from './common.js';
import { useApp, useLoad, useSend } from './hooks.js';
import type { PathsView, SettingsView } from './types.js';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [saved, setSaved] = useState(false);
  const [willCreate, setWillCreate] = useState(false);

  useEffect(() => {
    if (settings === undefined) return;
    setProjectsDir(settings.projectsDir);
    setLanguage(settings.configLang ?? '');
    setPolicy(settings.permissionPolicy);
    setMaxActive(String(settings.maxActiveCreations));
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

  return (
    <section>
      <h1>{t.settingsTitle}</h1>
      <Loader loaded={loaded}>
        {() => (
          <form class="panel settings-form" onSubmit={(event) => void save(event)}>
            {error !== undefined && <ErrorBanner error={error} />}
            {saved && <Notice>{t.settingsSaved}</Notice>}
            <p>
              <label for="projects-dir">{t.projectsDirLabel}</label>
              <input
                id="projects-dir"
                type="text"
                value={projectsDir}
                spellcheck={false}
                onInput={(event) => setProjectsDir(event.currentTarget.value)}
              />
              <span class="hint">{t.projectsDirHint}</span>
              {willCreate && (
                <span class="banner banner-warn" role="status" data-testid="folder-note">
                  {t.folderWillBeCreated}
                </span>
              )}
            </p>
            <p>
              <label for="language">{t.languageLabel}</label>
              <select id="language" value={language} onChange={(event) => setLanguage(event.currentTarget.value)}>
                <option value="">{t.langSystem}</option>
                <option value="en">{t.langEn}</option>
                <option value="es">{t.langEs}</option>
              </select>
            </p>
            <fieldset>
              <legend>{t.policyLabel}</legend>
              <label>
                <input type="radio" name="policy" checked={policy === 'ask'} onChange={() => setPolicy('ask')} /> {t.policyAsk}
                <span class="muted"> — {t.policyAskHint}</span>
              </label>
              <label>
                <input type="radio" name="policy" checked={policy === 'unattended'} onChange={() => setPolicy('unattended')} />{' '}
                {t.policyUnattended}
                <span class="muted"> — {t.policyUnattendedHint}</span>
              </label>
            </fieldset>
            <p>
              <label for="max-active">{t.maxActiveLabel}</label>
              <input
                id="max-active"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={maxActive}
                onInput={(event) => setMaxActive(event.currentTarget.value)}
              />
              <span class="hint">{t.maxActiveHint}</span>
              {Number(maxActive) > MANY_CREATIONS_NOTE_ABOVE && (
                <span class="banner banner-warn" role="status" data-testid="max-active-note">
                  {t.maxActiveNote}
                </span>
              )}
            </p>
            <div class="actions">
              <button type="submit" disabled={busy}>
                {busy ? t.saving : t.save}
              </button>
            </div>
          </form>
        )}
      </Loader>

      <h2>{t.pathsTitle}</h2>
      <Loader loaded={paths}>
        {(view) => (
          <dl class="panel paths" data-testid="paths">
            <dt>{t.pathHome}</dt>
            <dd class="path">{view.home}</dd>
            <dt>{t.pathConfig}</dt>
            <dd class="path">{view.configFile}</dd>
            <dt>{t.pathLibrary}</dt>
            <dd class="path">{view.libraryDir}</dd>
            <dt>{t.pathProjects}</dt>
            <dd class="path">{view.projectsDir}</dd>
            <dt>{t.pathSessions}</dt>
            <dd class="path">{view.sessionsDir}</dd>
            <dt>{t.pathRepo}</dt>
            <dd class="path">{view.repoDir}</dd>
            <dt>{t.pathAllowed}</dt>
            <dd>
              {view.allowedDirs.length === 0 ? (
                t.none
              ) : (
                <ul>
                  {view.allowedDirs.map((dir) => (
                    <li key={dir} class="path">
                      {dir}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
        )}
      </Loader>
    </section>
  );
}
