import { useApp } from './hooks.js';
import { Note } from './kit.js';
import type { SpecView } from './types.js';

/**
 * The code part of the spec checkpoint (BRIEF-phase-10 §3; PLAN-phase-10
 * §1, 1 and 2): "workspace only" (the default) or "workspace and a first
 * version of the code", with the exact commands, the checks, the fix
 * passes and, when Codex is available for creations, its checkbox (off by
 * default). The warning of the brief's §4 stays next to the choice.
 */

export interface SpecCodeDraft {
  chosen: boolean;
  commands: string;
  checks: string;
  /** `undefined` until the user picks one: the server's default applies (review of M1, m7). */
  fixPasses: number | undefined;
  codex: boolean;
}

export const emptyCodeDraft = (): SpecCodeDraft => ({ chosen: false, commands: '', checks: '', fixPasses: undefined, codex: false });

const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

/** What `approve` carries: nothing for "workspace only", the lists and options for code. */
export function codeAnswer(draft: SpecCodeDraft, code: { codex: boolean; defaultFixPasses: number }): { commands: string[]; checks: string[]; fixPasses: number; codex: boolean } | undefined {
  if (!draft.chosen) return undefined;
  return { commands: lines(draft.commands), checks: lines(draft.checks), fixPasses: draft.fixPasses ?? code.defaultFixPasses, codex: code.codex && draft.codex };
}

export function SpecCodeCard({ code, draft, onChange }: { code: NonNullable<SpecView['code']>; draft: SpecCodeDraft; onChange: (draft: SpecCodeDraft) => void }) {
  const { t } = useApp();
  const set = (patch: Partial<SpecCodeDraft>) => onChange({ ...draft, ...patch });
  return (
    <div class="dec-card stack-4" data-testid="spec-code">
      <h3 class="t-3">{t.specCodeTitle}</h3>
      <fieldset class="stack-2">
        <legend class="t-small muted">{t.specCodeIntro}</legend>
        <label class="check-line">
          <input type="radio" name="spec-code" checked={!draft.chosen} onChange={() => set({ chosen: false })} data-testid="spec-code-workspace" /> {t.specCodeWorkspace}
        </label>
        <label class="check-line">
          <input type="radio" name="spec-code" checked={draft.chosen} onChange={() => set({ chosen: true })} data-testid="spec-code-with-code" /> {t.specCodeWithCode}
        </label>
      </fieldset>
      {draft.chosen && (
        <div class="stack-4">
          <Note tone="danger" testId="spec-code-warning">
            {t.specCodeWarning}
          </Note>
          <label class="label">
            {t.specCodeCommands(code.maxCommands)}
            <textarea class="textarea mono" rows={4} value={draft.commands} onInput={(event) => set({ commands: (event.target as HTMLTextAreaElement).value })} data-testid="spec-code-commands" />
          </label>
          <p class="t-small muted">{t.specCodeCommandsHint}</p>
          <label class="label">
            {t.specCodeChecks(code.maxChecks)}
            <textarea class="textarea mono" rows={3} value={draft.checks} onInput={(event) => set({ checks: (event.target as HTMLTextAreaElement).value })} data-testid="spec-code-checks" />
          </label>
          <label class="label">
            {t.specCodeFixPasses}
            <select class="select" value={String(draft.fixPasses ?? code.defaultFixPasses)} onChange={(event) => set({ fixPasses: Number((event.target as HTMLSelectElement).value) })} data-testid="spec-code-fix-passes">
              {Array.from({ length: code.maxFixPasses + 1 }, (_, n) => (
                <option key={n} value={String(n)}>
                  {String(n)}
                </option>
              ))}
            </select>
          </label>
          {code.codex && (
            <label class="check-line">
              <input type="checkbox" checked={draft.codex} onChange={(event) => set({ codex: (event.target as HTMLInputElement).checked })} data-testid="spec-code-codex" /> {t.specCodeCodex}
            </label>
          )}
          {code.codex && draft.codex && <p class="t-small muted">{t.specCodeCodexHint}</p>}
        </div>
      )}
    </div>
  );
}
