import { useApp, useClaudeStatus } from './hooks.js';
import { Note } from './kit.js';
import { routeHash } from './route.js';
import type { AuthModeView, ClaudeStatusView } from './types.js';

/** Where an API key comes from, in the names the user set it with (as `src/creation/claudeAccount.ts`). */
const KEY_SOURCES = { environment: 'ANTHROPIC_API_KEY', helper: 'apiKeyHelper', login: 'Console /login', bearer: 'ANTHROPIC_AUTH_TOKEN', other: 'key' } as const;

/** Whether something keeps a creation from working (as `claudeNeedsAction` on the server). */
export const claudeNeedsAction = (status: ClaudeStatusView): boolean =>
  status.install.status === 'notFound' || status.install.status === 'older' || status.mode.kind === 'none';

function modeText(t: ReturnType<typeof useApp>['t'], mode: AuthModeView): string {
  switch (mode.kind) {
    case 'signIn':
      return t.claudeModeSignIn(mode.plan);
    case 'apiKey':
      return t.claudeModeApiKey(KEY_SOURCES[mode.source]);
    case 'cloud':
      return t.claudeModeCloud(mode.provider);
    case 'none':
      return t.claudeModeNone;
    case 'unknown':
      return t.claudeModeUnknown;
  }
}

/** The Settings card: is Claude Code there, which version, how it signs in, and what to do when something is missing. */
export function ClaudeCard() {
  const { t } = useApp();
  const { status, checking, refresh } = useClaudeStatus();
  const install = status?.install;
  const problem =
    install === undefined
      ? undefined
      : install.status === 'notFound'
        ? t.claudeNotFound
        : install.status === 'older'
          ? t.claudeOlder(install.installed, install.expected)
          : install.status === 'untested'
            ? t.claudeUntested(install.installed, install.expected)
            : install.status === 'unknownVersion'
              ? t.claudeUnknownVersion
              : undefined;
  const modeBad = status !== undefined && install?.status !== 'notFound' && (status.mode.kind === 'none' || status.mode.kind === 'unknown');
  return (
    <section class="card card-roomy settings" aria-labelledby="claude-title" data-testid="claude-card">
      <h2 class="t-2" id="claude-title">
        {t.claudeTitle}
      </h2>
      <p class="help">{t.claudeIntro}</p>
      {status === undefined ? (
        <p class="t-small muted" role="status">
          {t.claudeChecking}
        </p>
      ) : (
        <>
          {install?.status !== 'notFound' && (
            <dl class="kv" data-testid="claude-facts">
              {install !== undefined && 'installed' in install && (
                <>
                  <dt>{t.claudeVersionLabel}</dt>
                  <dd class="mono">{t.claudeVersion(install.installed, install.expected)}</dd>
                </>
              )}
              <dt>{t.claudeModeLabel}</dt>
              <dd data-testid="claude-mode" data-mode={status.mode.kind}>
                {modeText(t, status.mode)}
              </dd>
            </dl>
          )}
          {problem !== undefined && (
            <Note tone={install?.status === 'untested' || install?.status === 'unknownVersion' ? 'warn' : 'danger'} role="status" testId="claude-problem">
              {problem}
            </Note>
          )}
          {modeBad && (
            <Note tone={status.mode.kind === 'none' ? 'danger' : 'warn'} role="status" testId="claude-mode-problem">
              {modeText(t, status.mode)}
            </Note>
          )}
        </>
      )}
      <div class="btn-row">
        <button type="button" class="btn btn-secondary btn-sm" disabled={checking} onClick={refresh}>
          {checking ? t.claudeChecking : t.claudeCheckAgain}
        </button>
      </div>
    </section>
  );
}

/** Above every page but Settings: one line when Claude Code keeps creations from working, with a link to what to do. */
export function ClaudeBanner({ onSettings }: { onSettings: boolean }) {
  const { t } = useApp();
  const { status } = useClaudeStatus();
  if (onSettings || status === undefined || !claudeNeedsAction(status)) return null;
  return (
    <div class="claude-banner" data-testid="claude-banner">
      <Note tone="danger" role="status">
        {t.claudeBanner}{' '}
        <a class="link" href={routeHash({ page: 'settings' })}>
          {t.claudeBannerLink}
        </a>
      </Note>
    </div>
  );
}

/** Whether plan-usage meters mean anything: not with an API key or a cloud provider. Unknown counts as a plan. */
export function usageHiddenReason(t: ReturnType<typeof useApp>['t'], status: ClaudeStatusView | undefined): string | undefined {
  if (status?.mode.kind === 'apiKey') return t.panelUsageApiKey;
  if (status?.mode.kind === 'cloud') return t.panelUsageCloud;
  return undefined;
}
