import { useState } from 'preact/hooks';
import { usageHiddenReason } from './claude.js';
import { USAGE_LEVELS, formatWhen, levelIndex } from './format.js';
import { useApp, useClaudeStatus, useDocumentTitle, useLoad, useSend } from './hooks.js';
import { ErrorNote, LoadState, Note } from './kit.js';
import { percent } from './panelData.js';
import type { UsagePreset, UsageView as UsageData } from './types.js';

/** The models a preset uses, from its tiers, in the order they first appear. */
const modelsOf = (preset: UsagePreset | undefined): string => (preset?.tiers === undefined ? (preset?.sessionModel ?? '') : [...new Set(Object.values(preset.tiers))].join(' · '));

/** The weekday of an ISO time in the page's language and the browser's time zone, or `undefined` for a time that does not read. */
export function weekdayOf(iso: string, lang: 'en' | 'es'): string | undefined {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return undefined;
  return new Intl.DateTimeFormat(lang === 'es' ? 'es-ES' : 'en-GB', { weekday: 'long' }).format(new Date(time));
}

/** The last plan usage the server read, with when; the page never reads it itself. Hidden with an API key or a cloud provider. */
function LastPlanUsage({ last, activity }: { last: UsageData['lastPlanUsage']; activity: UsageData['activity'] }) {
  const { t, lang } = useApp();
  const { status } = useClaudeStatus();
  const hidden = usageHiddenReason(t, status);
  // The week's window (IDEAS §3; step 33): from the last reading the server saved, never a new one.
  const resetDay = last?.sevenDayResetsAt === undefined ? undefined : weekdayOf(last.sevenDayResetsAt, lang);
  const running = activity === undefined || activity === null ? undefined : activity;
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
          {last.sevenDay !== null && (
            <Note tone="plain" testId="usage-week-note">
              {t.usageWeekNote(Math.round(last.sevenDay), resetDay, running?.creations ?? 0, running?.builds ?? 0)}
            </Note>
          )}
        </>
      )}
    </section>
  );
}

const FLOW_AGENT_NAMES = ['interviewer', 'researcher', 'architect', 'generator', 'reviewer'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * "New preset based on…" (IDEAS §3; step 33): a user preset from another
 * one, with a name, its labels and each flow agent's model and effort. The
 * server checks it with the CLI's schema and writes only the user's
 * presets file; choosing it later is what rewrites the agent files.
 */
function NewPreset({ presets, onCreated }: { presets: UsagePreset[]; onCreated(name: string): void }) {
  const { t, lang } = useApp();
  const send = useSend();
  const [open, setOpen] = useState(false);
  const [base, setBase] = useState(presets.find((preset) => preset.name === 'balanced')?.name ?? presets[0]?.name ?? '');
  const [name, setName] = useState('');
  const [labelEn, setLabelEn] = useState('');
  const [labelEs, setLabelEs] = useState('');
  const [agents, setAgents] = useState<Record<string, { model: string; effort: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const from = presets.find((preset) => preset.name === base);
  const valueOf = (agent: string) => agents[agent] ?? from?.agents?.[agent] ?? { model: '', effort: from?.effort ?? 'medium' };
  const change = (agent: string, part: Partial<{ model: string; effort: string }>) => setAgents((current) => ({ ...current, [agent]: { ...valueOf(agent), ...part } }));

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      // Only the agents the user changed are sent; the others keep the base's entry.
      const changed = Object.fromEntries(Object.entries(agents).filter(([agent, value]) => JSON.stringify(value) !== JSON.stringify(from?.agents?.[agent] ?? null)));
      await send('POST', '/api/usage/presets', { name, base, label: { en: labelEn, es: labelEs }, ...(Object.keys(changed).length === 0 ? {} : { agents: changed }) });
      setOpen(false);
      setName('');
      setAgents({});
      onCreated(name);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div class="btn-row">
        <button type="button" class="btn btn-secondary" data-testid="new-preset-open" onClick={() => setOpen(true)}>
          {t.newPresetOpen}
        </button>
      </div>
    );
  }
  return (
    <form class="card stack-2" aria-labelledby="new-preset-title" data-testid="new-preset" onSubmit={(event) => void submit(event)}>
      <h3 class="t-3" id="new-preset-title">
        {t.newPresetTitle}
      </h3>
      <p class="t-small muted">{t.newPresetHint}</p>
      <label class="label">
        {t.newPresetBase}
        <select class="input" value={base} onChange={(event) => (setBase((event.target as HTMLSelectElement).value), setAgents({}))} data-testid="new-preset-base">
          {presets.map((preset) => (
            <option key={preset.name} value={preset.name}>
              {preset.label[lang]} ({preset.name})
            </option>
          ))}
        </select>
      </label>
      <label class="label">
        {t.newPresetName}
        <input class="input mono" value={name} required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={60} onInput={(event) => setName((event.target as HTMLInputElement).value)} data-testid="new-preset-name" />
      </label>
      <div class="btn-row">
        <label class="label">
          {t.newPresetLabelEn}
          <input class="input" value={labelEn} required maxLength={80} onInput={(event) => setLabelEn((event.target as HTMLInputElement).value)} data-testid="new-preset-label-en" />
        </label>
        <label class="label">
          {t.newPresetLabelEs}
          <input class="input" value={labelEs} required maxLength={80} onInput={(event) => setLabelEs((event.target as HTMLInputElement).value)} data-testid="new-preset-label-es" />
        </label>
      </div>
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">{t.newPresetAgent}</th>
              <th scope="col">{t.newPresetModel}</th>
              <th scope="col">{t.newPresetEffort}</th>
            </tr>
          </thead>
          <tbody>
            {FLOW_AGENT_NAMES.map((agent) => (
              <tr key={agent}>
                <td class="td-mono">{agent}</td>
                <td>
                  <input class="input mono" value={valueOf(agent).model} required maxLength={80} onInput={(event) => change(agent, { model: (event.target as HTMLInputElement).value })} data-testid={`new-preset-model-${agent}`} />
                </td>
                <td>
                  <select class="input" value={valueOf(agent).effort} onChange={(event) => change(agent, { effort: (event.target as HTMLSelectElement).value })} data-testid={`new-preset-effort-${agent}`}>
                    {EFFORTS.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error !== undefined && <ErrorNote error={error} />}
      <div class="btn-row">
        <button type="submit" class="btn btn-primary" disabled={busy} data-testid="new-preset-create">
          {t.newPresetCreate}
        </button>
        <button type="button" class="btn btn-ghost" onClick={() => setOpen(false)}>
          {t.cancel}
        </button>
      </div>
    </form>
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
                    <p class="t-small muted card-foot" data-testid="work-model">
                      {t.usageWorkModel(usage.work.model, usage.work.effort)}
                    </p>
                  </section>
                )}

                <NewPreset
                  presets={usage.presets}
                  onCreated={(name) => {
                    setNotice(t.newPresetCreated(name));
                    loaded.reload();
                  }}
                />

                <LastPlanUsage last={usage.lastPlanUsage} activity={usage.activity} />

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
