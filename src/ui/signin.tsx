import { useState } from 'preact/hooks';
import type { uiMessages } from '../i18n/ui.js';
import { signIn } from './api.js';
import { describeError } from './errors.js';
import { formatWhen } from './format.js';
import { useApp, useLoad, useSend } from './hooks.js';
import { ConfirmModal, ErrorNote, LoadState, Note } from './kit.js';

type Messages = (typeof uiMessages)['en'];

/**
 * Server mode's sign-in (phase 12): the access secret, once per device, in
 * a password field. It goes in the request's body, never in the address,
 * and the field is emptied whatever the answer.
 */
export function SignIn({ t, onSignedIn }: { t: Messages; onSignedIn(): void }) {
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  const submit = async (event: Event) => {
    event.preventDefault();
    if (secret === '' || busy) return;
    setBusy(true);
    setError(undefined);
    const typed = secret;
    setSecret('');
    try {
      await signIn(typed);
      onSignedIn();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="gate">
      <span class="brand-row" translate={false}>
        <span class="logo" aria-hidden="true">
          b
        </span>
        <span class="brand-name">briefstack</span>
      </span>
      <section class="card" aria-labelledby="signin-title" data-testid="sign-in">
        <h1 class="t-2" id="signin-title">
          {t.signInTitle}
        </h1>
        <p class="muted">{t.signInIntro}</p>
        <form class="settings" onSubmit={(event) => void submit(event)}>
          {error !== undefined && (
            <Note tone="danger" role="alert" testId="sign-in-error">
              {describeError(error, t)}
            </Note>
          )}
          <div class="field">
            <label class="label" for="access-secret">
              {t.signInLabel}
            </label>
            <input id="access-secret" class="input" type="password" autocomplete="current-password" value={secret} disabled={busy} onInput={(event) => setSecret(event.currentTarget.value)} />
          </div>
          <div>
            <button type="submit" class="btn btn-primary" disabled={busy || secret === ''}>
              {t.signInButton}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

interface DevicesView {
  devices: { id: string; label: string; createdAt: string; lastSeenAt: string; current: boolean }[];
}

/**
 * The Settings card of server mode: the signed-in devices, sign out of
 * this one, revoke another, and revoke all (this one included).
 */
export function DevicesCard() {
  const { t, lang } = useApp();
  const loaded = useLoad<DevicesView>('/api/server/devices');
  const send = useSend();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [confirmAll, setConfirmAll] = useState(false);

  // Signing this device out answers with a cleared cookie: the next call is refused and the page asks for the secret.
  const act = async (path: string, ends: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await send('POST', path);
      if (ends) window.location.reload();
      else loaded.reload();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="card card-roomy settings" aria-labelledby="devices-title" data-testid="devices-card">
      <h2 class="t-2" id="devices-title">
        {t.devicesTitle}
      </h2>
      <p class="help">{t.devicesIntro}</p>
      {error !== undefined && <ErrorNote error={error} />}
      <LoadState loaded={loaded}>
        {(view) => (
          <ul class="stack-2" data-testid="devices">
            {view.devices.map((device) => (
              <li key={device.id} class="device-row" data-testid="device" data-current={device.current ? 'true' : 'false'}>
                <div>
                  <p class="t-body">
                    {device.label}
                    {device.current && <span class="chip">{t.deviceCurrent}</span>}
                  </p>
                  <p class="t-small muted">{t.deviceTimes(formatWhen(device.createdAt, lang), formatWhen(device.lastSeenAt, lang))}</p>
                </div>
                <button type="button" class="btn btn-secondary btn-sm" disabled={busy} data-testid="device-revoke" onClick={() => void act(device.current ? '/api/server/sign-out' : `/api/server/devices/${encodeURIComponent(device.id)}/revoke`, device.current)}>
                  {device.current ? t.signOut : t.deviceRevoke}
                </button>
              </li>
            ))}
          </ul>
        )}
      </LoadState>
      <div>
        <button type="button" class="btn btn-secondary" disabled={busy} data-testid="devices-revoke-all" onClick={() => setConfirmAll(true)}>
          {t.devicesRevokeAll}
        </button>
      </div>
      {confirmAll && (
        <ConfirmModal
          title={t.devicesRevokeAllTitle}
          body={t.devicesRevokeAllBody}
          confirmLabel={t.devicesRevokeAll}
          cancelLabel={t.cancel}
          onConfirm={() => {
            setConfirmAll(false);
            void act('/api/server/devices/revoke-all', true);
          }}
          onCancel={() => setConfirmAll(false)}
        />
      )}
    </section>
  );
}
