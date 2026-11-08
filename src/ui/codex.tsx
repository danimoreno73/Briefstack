import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useApp, useLoad, useSend } from './hooks.js';
import { formatWhen } from './format.js';
import { ErrorNote, LoadState, Note } from './kit.js';
import type { CodexModeView, CodexView } from './types.js';

/**
 * The Settings card for Codex in tasks (phase 8): the switch (off by
 * default), the Windows sandbox mode, the calls per round, and the status.
 * Opening the page runs nothing: `GET /api/codex` only reads the last
 * check; "Check" runs it (`POST /api/codex/check`).
 */
export function CodexCard() {
  const { t, lang } = useApp();
  const loaded = useLoad<CodexView>('/api/codex');
  const send = useSend();
  const [view, setView] = useState<CodexView | undefined>(undefined);
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<CodexModeView>('unelevated');
  const [maxCalls, setMaxCalls] = useState('');
  const [busy, setBusy] = useState<'save' | 'check' | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (loaded.data === undefined) return;
    setView(loaded.data);
    setEnabled(loaded.data.enabled);
    setMode(loaded.data.mode);
    setMaxCalls(String(loaded.data.maxCalls));
  }, [loaded.data]);

  const save = async (event: Event) => {
    event.preventDefault();
    if (view === undefined) return;
    const body: Record<string, unknown> = {};
    if (enabled !== view.enabled) body.codexEnabled = enabled;
    if (view.modeOffered && mode !== view.mode) body.codexMode = mode;
    if (maxCalls.trim() !== String(view.maxCalls)) body.codexMaxCalls = Number(maxCalls.trim());
    if (Object.keys(body).length === 0) return;
    setBusy('save');
    setError(undefined);
    setSaved(false);
    try {
      await send('PUT', '/api/settings', body);
      setSaved(true);
      loaded.reload();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(undefined);
    }
  };

  const check = async () => {
    setBusy('check');
    setError(undefined);
    try {
      setView(await send<CodexView>('POST', '/api/codex/check'));
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(undefined);
    }
  };

  const modes: { value: CodexModeView; label: string; hint: string }[] = [
    { value: 'unelevated', label: t.codexModeUnelevated, hint: t.codexModeUnelevatedHint },
    { value: 'elevated', label: t.codexModeElevated, hint: t.codexModeElevatedHint },
  ];

  return (
    <section class="card card-roomy settings" aria-labelledby="codex-title" data-testid="codex-card">
      <h2 class="t-2" id="codex-title">
        {t.codexTitle}
      </h2>
      <p class="help">{t.codexIntro}</p>
      <LoadState loaded={loaded}>
        {() =>
          view === undefined ? null : (
            <form class="stack-2" onSubmit={(event) => void save(event)}>
              {error !== undefined && <ErrorNote error={error} />}
              {saved && (
                <Note tone="ok" role="status" testId="codex-saved">
                  {t.codexSaved}
                </Note>
              )}
              <label class="choice-item">
                <input class="opt-input" type="checkbox" checked={enabled} data-testid="codex-enabled" onChange={(event) => setEnabled(event.currentTarget.checked)} />
                <span class="c-t">{t.codexEnable}</span>
              </label>
              {enabled && (
                <Note tone="warn" testId="codex-warning">
                  {t.codexWarning.map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part))}
                  {view.modeOffered && ` ${mode === 'elevated' ? t.codexWarningElevated : t.codexWarningUnelevated}`}
                </Note>
              )}

              {view.modeOffered ? (
                <fieldset>
                  <legend class="label">{t.codexModeLabel}</legend>
                  <div class="choice">
                    {modes.map((option) => (
                      <label key={option.value} class="choice-item">
                        <input class="opt-input" type="radio" name="codex-mode" value={option.value} checked={mode === option.value} onChange={() => setMode(option.value)} />
                        <span class="c-t">{option.label}</span>
                        <span class="c-d">{option.hint}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : (
                <p class="help" data-testid="codex-mode-not-offered">
                  {t.codexModeNotOffered}
                </p>
              )}

              <div class="field">
                <label class="label" for="codex-max-calls">
                  {t.codexMaxCallsLabel}
                </label>
                <input
                  id="codex-max-calls"
                  class="input input-mono limit-input"
                  type="number"
                  min={1}
                  max={10}
                  step={1}
                  inputMode="numeric"
                  value={maxCalls}
                  aria-describedby="codex-max-calls-hint"
                  onInput={(event) => setMaxCalls(event.currentTarget.value)}
                />
                <p class="help" id="codex-max-calls-hint">
                  {t.codexMaxCallsHint}
                </p>
              </div>
              <div class="btn-row">
                <button type="submit" class="btn btn-primary btn-sm" disabled={busy !== undefined}>
                  {busy === 'save' ? t.saving : t.codexSave}
                </button>
              </div>

              <h3 class="t-3" id="codex-status-title">
                {t.codexStatusTitle}
              </h3>
              <p class="help">{t.codexStatusHelp}</p>
              {view.last === undefined ? (
                <p class="t-small muted" data-testid="codex-never-checked">
                  {t.codexNeverChecked}
                </p>
              ) : (
                <div class="stack-2" data-testid="codex-last">
                  <p class="t-small muted">{t.codexCheckedAt(formatWhen(view.last.at, lang))}</p>
                  {view.last.mode !== undefined && <p class="t-small muted">{t.codexCheckedMode(view.last.mode)}</p>}
                  {view.last.found ? (
                    <dl class="kv" data-testid="codex-facts">
                      {(
                        [
                          ['version', t.codexVersionLabel, view.last.version],
                          ['login', t.codexLoginLabel, view.last.login],
                          ['sandbox', t.codexSandboxLabel, view.last.sandbox],
                        ] as const
                      ).map(([key, label, item]) => (
                        <Fragment key={key}>
                          <dt>{label}</dt>
                          <dd data-testid={`codex-${key}`} data-ok={String(item.ok)}>
                            {item.ok ? t.codexPassed : t.codexFailed}
                            {item.text !== '' && (
                              <>
                                {' · '}
                                <span class="mono">{item.text}</span>
                              </>
                            )}
                          </dd>
                        </Fragment>
                      ))}
                    </dl>
                  ) : (
                    <Note tone="danger" testId="codex-not-found">
                      {t.codexNotFound}
                    </Note>
                  )}
                </div>
              )}
              {view.available ? (
                <Note tone="ok" testId="codex-availability">
                  {t.codexAvailable}
                </Note>
              ) : (
                <Note tone={view.reason === 'off' ? 'plain' : 'warn'} testId="codex-availability">
                  {t.codexUnavailable(view.reason ?? 'off')}
                </Note>
              )}
              <div class="btn-row">
                <button type="button" class="btn btn-secondary btn-sm" disabled={busy !== undefined} onClick={() => void check()}>
                  {busy === 'check' ? t.codexChecking : t.codexCheck}
                </button>
              </div>
            </form>
          )
        }
      </LoadState>
    </section>
  );
}
