import { useState } from 'preact/hooks';
import { PathText } from './common.js';
import { formatWhen } from './format.js';
import { useApp, useLoad, useSend } from './hooks.js';
import { ErrorNote } from './kit.js';
import type { ProviderCheckUi, ProviderUi } from './types.js';

/**
 * The Settings card of reserve providers (phase 12): the list from
 * config.json, read-only, and each provider's status check. Nothing here
 * writes a provider, and no key ever reaches the page.
 */
export function ProvidersCard() {
  const { t, lang } = useApp();
  const loaded = useLoad<{ providers: ProviderUi[] }>('/api/providers');
  const send = useSend();
  const [checks, setChecks] = useState<Record<string, ProviderCheckUi>>({});
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const providers = loaded.data?.providers ?? [];
  if (providers.length === 0) return null;

  const check = async (name: string) => {
    setBusy(name);
    setError(undefined);
    try {
      const result = await send<ProviderCheckUi>('POST', `/api/providers/${encodeURIComponent(name)}/check`);
      setChecks((current) => ({ ...current, [name]: result }));
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section class="card card-roomy settings" aria-labelledby="providers-title" data-testid="providers-card">
      <h2 class="t-2" id="providers-title">
        {t.providersTitle}
      </h2>
      <p class="help">{t.providersIntro}</p>
      {error !== undefined && <ErrorNote error={error} />}
      <ul class="stack-2">
        {providers.map((provider) => {
          const result = checks[provider.name] ?? provider.check;
          return (
            <li key={provider.name} class="device-row" data-testid="provider">
              <div>
                <p class="t-body">
                  <strong>{provider.name}</strong> · <code>{provider.baseUrl}</code>
                </p>
                <p class="t-small muted">{t.providerModels(provider.model, provider.smallModel)}</p>
                <p class="t-small muted">
                  {t.providerKeyFile}: <PathText value={provider.keyFile} />
                </p>
                {provider.note !== undefined && <p class="t-small muted">{provider.note}</p>}
                {result !== undefined && (
                  <ul class="plain-list t-small" data-testid="provider-check">
                    <li data-testid="provider-key-file">{t.providerKeyState(result.keyFile)}</li>
                    <li data-testid="provider-endpoint">{t.providerEndpoint(result.endpoint === 'reachable', result.status)}</li>
                    <li>{t.providerKeyNotChecked}</li>
                    <li class="muted">{formatWhen(result.checkedAt, lang)}</li>
                  </ul>
                )}
              </div>
              <button type="button" class="btn btn-secondary btn-sm" disabled={busy !== undefined} onClick={() => void check(provider.name)} data-testid="provider-check-button">
                {busy === provider.name ? t.providerChecking : t.providerCheck}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
