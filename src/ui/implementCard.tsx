import { Markdown } from './common.js';
import { callTokens, callTokensWithCache, formatCount, messageHead } from './codexData.js';
import { useApp } from './hooks.js';
import { Note } from './kit.js';
import { formatDuration } from './panelData.js';
import type { CreationState } from './types.js';

/**
 * The implement step of a creation (phase 10, M5): while it runs, on the
 * creation page; when it ended, on the result screen. The two commits, the
 * limits, the commands the implementer ran and those refused (nobody was
 * asked), each pass of the checks with its output, Codex's calls and
 * tokens, and the brief's "Current status" (what is left), shown as data.
 */

const short = (commit: string | undefined): string | undefined => commit?.slice(0, 10);

export function ImplementCard({ state }: { state: CreationState }) {
  const { t, lang } = useApp();
  const step = state.implement;
  if (state.code === undefined) return null;
  // Code chosen but the step never started, or was refused: say so (review of M2, m6).
  if (step === undefined || step.state === 'notStarted') {
    if (state.status !== 'finished' && step === undefined) return null;
    // A creation cancelled or failed before the step: nothing to say about the code (review of M5, m7).
    if (step === undefined && state.outcome !== 'completed') return null;
    return (
      <section class="card" data-testid="implement" data-state="notStarted" aria-labelledby="implement-title">
        <h2 class="t-2" id="implement-title">
          {t.implementTitle}
        </h2>
        <Note tone="warn" testId="implement-not-started">
          {t.implementNotStarted(step?.reason)}
        </Note>
      </section>
    );
  }
  const count = (value: number) => formatCount(value, lang);
  const lastChecks = step.checks.at(-1);
  const checksPassed = lastChecks !== undefined && lastChecks.results.every((result) => result.exitCode === 0 && !result.timedOut);
  const codexTokens = step.codex.reduce((sum, call) => sum + (call.usage === undefined ? 0 : callTokens(call.usage)), 0);
  const codexTokensWithCache = step.codex.reduce((sum, call) => sum + (call.usage === undefined ? 0 : callTokensWithCache(call.usage)), 0);
  return (
    <section class="card stack-4" data-testid="implement" data-state={step.state} aria-labelledby="implement-title">
      <h2 class="t-2" id="implement-title">
        {t.implementTitle}
      </h2>
      <p class="t-strong" data-testid="implement-state">
        {t.implementState(step.state)}
      </p>
      {step.warning === 'checksFailed' && (
        <Note tone="danger" testId="implement-warning">
          {t.implementChecksFailed}
        </Note>
      )}
      {step.limit !== undefined && (
        <Note tone="warn" testId="implement-limit">
          {t.implementLimit(step.limit)}
        </Note>
      )}
      {step.codexUnavailable === true && <Note tone="warn">{t.implementCodexUnavailable}</Note>}
      {step.revertFailed === true && (
        <Note tone="danger" testId="implement-revert-failed">
          {t.implementRevertFailed}
        </Note>
      )}
      {(step.protectedReverted ?? []).length > 0 && (
        <Note tone="danger" testId="implement-protected">
          {t.implementProtectedReverted((step.protectedReverted ?? []).join(', '))}
        </Note>
      )}
      {(step.hooksReverted ?? []).length > 0 && (
        <Note tone="danger" testId="implement-hooks">
          {t.implementHooksReverted((step.hooksReverted ?? []).join(', '))}
        </Note>
      )}
      {step.commitWarning !== undefined && <Note tone="warn">{t.implementCommitWarning(step.commitWarning)}</Note>}

      <dl class="kv" data-testid="implement-facts">
        {step.workspaceCommit !== undefined && (
          <>
            <dt>{t.implementWorkspaceCommit}</dt>
            <dd class="mono" data-testid="implement-workspace-commit">
              {short(step.workspaceCommit)}
            </dd>
          </>
        )}
        {step.codeCommit !== undefined && (
          <>
            <dt>{t.implementCodeCommit}</dt>
            <dd class="mono" data-testid="implement-code-commit">
              {short(step.codeCommit)}
            </dd>
          </>
        )}
        {step.bounds !== undefined && (
          <>
            <dt>{t.implementBounds}</dt>
            <dd data-testid="implement-bounds">{t.implementBoundsValue(step.toolCalls, step.bounds.maxToolCalls, step.bounds.maxMinutes)}</dd>
          </>
        )}
        {state.code.fixPasses > 0 && (
          <>
            <dt>{t.implementFixPasses}</dt>
            <dd>{t.implementFixPassesValue(step.fixPassesUsed, state.code.fixPasses)}</dd>
          </>
        )}
        {lastChecks !== undefined && (
          <>
            <dt>{t.implementChecks}</dt>
            <dd data-testid="implement-checks-summary" data-ok={String(checksPassed)}>
              {checksPassed ? t.implementChecksPassed : t.implementChecksFailing}
            </dd>
          </>
        )}
      </dl>

      {step.runs.length > 0 && (
        <div class="stack-2" data-testid="implement-runs">
          <h3 class="t-3">{t.implementRunsTitle}</h3>
          <ul class="stack-2">
            {step.runs.map((run, i) => (
              <li key={`${run.at}-${i}`} data-testid="implement-run" data-ok={String(run.exitCode === 0 && !run.timedOut)}>
                <details>
                  <summary>
                    <span class="mono">{run.command}</span> · {run.timedOut ? t.implementTimedOut : t.implementExit(run.exitCode)} · {formatDuration(run.durationMs, lang)}
                  </summary>
                  <pre class="request request-clip">{run.output === '' ? t.implementNoOutput : run.output}</pre>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}

      {step.refused.length > 0 && (
        <div class="stack-2" data-testid="implement-refused">
          <h3 class="t-3">{t.implementRefusedTitle}</h3>
          <p class="t-small muted">{t.implementRefusedNote}</p>
          <ul class="stack-2">
            {step.refused.map((refused, i) => (
              <li key={`${refused.at}-${i}`} class="mono" data-testid="implement-refused-command">
                {refused.command}
              </li>
            ))}
          </ul>
        </div>
      )}

      {step.checks.map((pass) => (
        <div key={pass.pass} class="stack-2" data-testid="implement-checks-pass">
          <h3 class="t-3">{t.implementChecksPass(pass.pass)}</h3>
          <ul class="stack-2">
            {pass.results.map((result, i) => (
              <li key={`${pass.pass}-${i}`} data-testid="implement-check" data-ok={String(result.exitCode === 0 && !result.timedOut)}>
                <details>
                  <summary>
                    <span class="mono">{result.command}</span> · {result.timedOut ? t.implementTimedOut : t.implementExit(result.exitCode)}
                  </summary>
                  <pre class="request request-clip">{result.output === '' ? t.implementNoOutput : result.output}</pre>
                </details>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {step.codex.length > 0 && (
        <div class="stack-2" data-testid="implement-codex">
          <h3 class="t-3">{t.implementCodexTitle(step.codex.length)}</h3>
          <p data-testid="implement-codex-tokens">{t.taskCodexCallTokens(count(codexTokens), count(codexTokensWithCache))}</p>
          <p class="t-small muted">{t.taskCodexCost}</p>
          <ul class="stack-2">
            {step.codex.map((call) => (
              <li key={call.n} data-testid="implement-codex-call" data-outcome={call.outcome}>
                <details>
                  <summary>
                    {call.n} · {t.taskCodexOutcome(call.outcome)} · {formatDuration(call.durationMs, lang)} · {messageHead(call.message)}
                  </summary>
                  <p class="t-small muted">{t.taskCodexMessageNote}</p>
                  <pre class="request request-clip">{call.message}</pre>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}

      {step.status !== undefined && (
        <div class="stack-2" data-testid="implement-status">
          <h3 class="t-3">{t.implementStatusTitle}</h3>
          <p class="t-small muted">{t.implementStatusNote}</p>
          <Markdown text={step.status} />
        </div>
      )}
    </section>
  );
}
