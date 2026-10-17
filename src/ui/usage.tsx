import { useState } from 'preact/hooks';
import { ErrorBanner, Loader, Notice } from './common.js';
import { USAGE_LEVELS, levelIndex } from './format.js';
import { useApp, useLoad, useSend } from './hooks.js';
import type { UsageView as UsageData } from './types.js';

export function UsageView() {
  const { t } = useApp();
  const loaded = useLoad<UsageData>('/api/usage');
  const send = useSend();
  const [error, setError] = useState<unknown>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<number | undefined>(undefined);

  const apply = async (profile: string) => {
    setError(undefined);
    setNotice(undefined);
    try {
      await send('PUT', '/api/usage', { profile });
      setNotice(t.usageSaved(profile));
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(undefined);
      loaded.reload();
    }
  };

  const levelNames = [t.levelSaver, t.levelBalanced, t.levelMax];

  return (
    <section>
      <h1>{t.usageTitle}</h1>
      <p>{t.usageIntro}</p>
      {error !== undefined && <ErrorBanner error={error} />}
      {notice !== undefined && <Notice>{notice}</Notice>}
      <Loader loaded={loaded}>
        {(usage) => {
          const activeLevel = levelIndex(usage.profile);
          const position = pending ?? activeLevel ?? 1;
          const userPresets = usage.presets.filter((preset) => preset.source === 'user');
          return (
            <>
              <div class="slider">
                <label for="usage-level">{t.usageSlider}</label>
                <input
                  id="usage-level"
                  type="range"
                  min="0"
                  max="2"
                  step="1"
                  value={position}
                  aria-valuetext={levelNames[position]}
                  onInput={(event) => setPending(Number(event.currentTarget.value))}
                  onChange={(event) => {
                    const level = USAGE_LEVELS[Number(event.currentTarget.value)];
                    if (level !== undefined) void apply(level);
                  }}
                />
                <ol class="ticks" aria-hidden="true">
                  {levelNames.map((name, index) => (
                    <li key={name} class={index === position ? 'on' : undefined}>
                      {name}
                    </li>
                  ))}
                </ol>
              </div>
              <p data-testid="level-hint">{t.levelHint(USAGE_LEVELS[position] ?? 'balanced')}</p>
              <p data-testid="active-profile">
                {t.usageActive(usage.label)}
                {activeLevel === undefined && ` · ${t.usageCustomActive}`}
              </p>
              <p data-testid="chat-model">{t.usageChatModel(usage.chat.model, usage.chat.effort)}</p>

              {userPresets.length > 0 && (
                <p>
                  <label for="usage-preset">{t.presetsLabel}</label>{' '}
                  <select
                    id="usage-preset"
                    value={activeLevel === undefined ? usage.profile : ''}
                    onChange={(event) => {
                      if (event.currentTarget.value !== '') void apply(event.currentTarget.value);
                    }}
                  >
                    <option value="">{t.presetsChoose}</option>
                    {userPresets.map((preset) => (
                      <option key={preset.name} value={preset.name}>
                        {preset.label.en === preset.label.es ? preset.label.en : preset.name}
                      </option>
                    ))}
                  </select>
                </p>
              )}

              <h2>{t.warningsTitle}</h2>
              {usage.drift.length === 0 && usage.envWarnings.length === 0 ? (
                <p>{t.warningsNone}</p>
              ) : (
                <ul data-testid="warnings">
                  {usage.envWarnings.map((warning) => (
                    <li key={warning.variable}>{t.warnEnv(warning.variable)}</li>
                  ))}
                  {usage.drift.map((item) => (
                    <li key={`${item.file}-${item.field}`}>{t.warnDrift(item.file, item.field)}</li>
                  ))}
                </ul>
              )}
              <p class="muted">{t.openUsageHint}</p>
            </>
          );
        }}
      </Loader>
    </section>
  );
}
