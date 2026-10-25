import { useState } from 'preact/hooks';
import { usageHiddenReason } from './claude.js';
import { USAGE_LEVELS, formatWhen, levelIndex } from './format.js';
import { useApp, useClaudeStatus, useDocumentTitle, useLoad, useSend } from './hooks.js';
import { ErrorNote, LoadState, Note } from './kit.js';
import { percent } from './panelData.js';
import type { UsagePreset, UsageView as UsageData } from './types.js';

/** The models a preset uses, from its tiers, in the order they first appear. */
const modelsOf = (preset: UsagePreset | undefined): string => (preset?.tiers === undefined ? (preset?.sessionModel ?? '') : [...new Set(Object.values(preset.tiers))].join(' · '));

/** The last plan usage the server read, with when; the page never reads it itself. Hidden with an API key or a cloud provider. */
function LastPlanUsage({ last }: { last: UsageData['lastPlanUsage'] }) {
  const { t, lang } = useApp();
  const { status } = useClaudeStatus();
  const hidden = usageHiddenReason(t, status);
  return (
    <section class="card" aria-labelledby="plan-usage-title" data-testid="last-plan-usage">
      <h2 class="t-2" id="plan-usage-title">
        {t.usagePlanTitle}
      </h2>
      {hidden !== undefined ? (
        <p class="t-small muted">{hidden}</p>
      ) : last === null ? (
        <p class="t-small muted">{t.usagePlanNone}</p>
      ) : (
        <>
          <dl class="kv">
            <dt>{t.usageFiveHour}</dt>
            <dd class="mono">{percent(last.fiveHour)}</dd>
            <dt>{t.usageSevenDay}</dt>
            <dd class="mono">{percent(last.sevenDay)}</dd>
          </dl>
          <p class="t-small muted" data-testid="last-plan-usage-when">
            {t.usagePlanLast(formatWhen(last.at, lang))}
          </p>
        </>
      )}
    </section>
  );
}

export function UsageView() {
  const { t, lang } = useApp();
  const loaded = useLoad<UsageData>('/api/usage');
  const send = useSend();
  const [error, setError] = useState<unknown>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // The card just chosen, shown as chosen while the server applies it and the page reloads.
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  useDocumentTitle(t.usageTitle);

  const apply = async (profile: string) => {
    setError(undefined);
    setNotice(undefined);
    setBusy(true);
    setChosen(profile);
    try {
      await send('PUT', '/api/usage', { profile });
      setNotice(t.usageSaved(profile));
    } catch (failure) {
      setChosen(undefined);
      setError(failure);
    } finally {
      setBusy(false);
      loaded.reload();
    }
  };

  const levelNames: Record<string, string> = { saver: t.levelSaver, balanced: t.levelBalanced, max: t.levelMax };

  return (
    <>
      <header class="page-head">
        <div class="page-head-text">
          <h1 class="t-1">{t.usageTitle}</h1>
          <p class="lead">{t.usageIntro}</p>
        </div>
      </header>
      <div class="page page-roomy">
        {error !== undefined && <ErrorNote error={error} />}
        {notice !== undefined && (
          <Note tone="ok" role="status">
            {notice}
          </Note>
        )}
        <LoadState loaded={loaded}>
          {(usage) => {
            const activeLevel = levelIndex(usage.profile);
            const userPresets = usage.presets.filter((preset) => preset.source === 'user');
            const card = (name: string, title: string, hint: string, preset: UsagePreset | undefined) => {
              const active = (chosen ?? usage.profile) === name;
              return (
                <label class="tier" key={name}>
                  <input class="opt-input" type="radio" name="profile" checked={active} disabled={busy} onChange={() => void apply(name)} />
                  <span class="tier-name">{title}</span>
                  <span class="muted" data-testid={active ? 'level-hint' : undefined}>
                    {hint}
                  </span>
                  {preset !== undefined && <span class="mono-s faint">{t.usageModels(modelsOf(preset), preset.effort)}</span>}
                  <span class="tier-state">
                    <span class={active ? 'btn btn-primary btn-block' : 'btn btn-secondary btn-block'} aria-hidden="true">
                      {active ? t.usageActiveTag : t.usageChoose}
                    </span>
                  </span>
                </label>
              );
            };
            return (
              <>
                <fieldset class="stack-4">
                  <legend class="sr-only">{t.usageSlider}</legend>
                  <div class="tiers">
                    {USAGE_LEVELS.map((level) =>
                      card(
                        level,
                        levelNames[level] ?? level,
                        t.levelHint(level),
                        usage.presets.find((preset) => preset.name === level),
                      ),
                    )}
                  </div>
                  {userPresets.length > 0 && (
                    <div class="stack-2">
                      <h2 class="section-title">{t.presetsLabel}</h2>
                      <div class="tiers">
                        {userPresets.map((preset) => card(preset.name, preset.label[lang], preset.name, preset))}
                      </div>
                    </div>
                  )}
                </fieldset>

                <p data-testid="active-profile">
                  <span class="strong">{t.usageActive(usage.label)}</span>
                  {activeLevel === undefined && ` · ${t.usageCustomActive}`}
                </p>

                {usage.agents !== undefined && (
                  <section class="card card-flush" aria-labelledby="agents-title">
                    <div class="card-head">
                      <h2 class="t-2" id="agents-title">
                        {t.usageAgentsTitle(usage.label)}
                      </h2>
                    </div>
                    <div class="table-scroll">
                      <table class="table">
                        <thead>
                          <tr>
                            <th scope="col">{t.colAgent}</th>
                            <th scope="col">{t.panelModel}</th>
                            <th scope="col">{t.panelEffort}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(usage.agents).map(([agent, setting]) => (
                            <tr key={agent}>
                              <td class="td-mono">{agent}</td>
                              <td class="td-mono">{setting.model}</td>
                              <td>{setting.effort}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p class="t-small muted card-foot" data-testid="chat-model">
                      {t.usageChatModel(usage.chat.model, usage.chat.effort)}
                    </p>
                  </section>
                )}

                <LastPlanUsage last={usage.lastPlanUsage} />

                <section class="stack-2" aria-labelledby="warnings-title">
                  <h2 class="section-title" id="warnings-title">
                    {t.warningsTitle}
                  </h2>
                  {usage.drift.length === 0 && usage.envWarnings.length === 0 ? (
                    <p class="muted">{t.warningsNone}</p>
                  ) : (
                    <ul class="stack-2" data-testid="warnings">
                      {usage.envWarnings.map((warning) => (
                        <li key={warning.variable}>
                          <Note tone="warn">{t.warnEnv(warning.variable)}</Note>
                        </li>
                      ))}
                      {usage.drift.map((item) => (
                        <li key={`${item.file}-${item.field}`}>
                          <Note tone="warn">{t.warnDrift(item.file, item.field)}</Note>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <p class="t-small muted">{t.openUsageHint}</p>
              </>
            );
          }}
        </LoadState>
      </div>
    </>
  );
}
