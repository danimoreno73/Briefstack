import { useState } from 'preact/hooks';
import { useApp } from './hooks.js';

/** The longest reply the server takes (`MAX_REPLY_CHARS` in `src/server/creations.ts`). */
export const MAX_REPLY_CHARS = 10_000;

export interface ReplyBoxProps {
  /** Unique on the page: the textarea's id. */
  id: string;
  label?: string;
  hint?: string;
  sendLabel?: string;
  /** Resolves `true` when the text was taken; the box is then emptied. */
  onSend(text: string): Promise<boolean>;
  disabled?: boolean;
  rows?: number;
  /** `form` (the default): label, box, hint and button stacked, as the creation's reply; `composer`: the chat's box and button side by side. */
  look?: 'form' | 'composer';
}

/**
 * A free-text box with a send button (BRIEF-phase-4 §3.3). The creation page
 * uses it when a session waits for a reply, and the chat for every message.
 * Ctrl+Enter (or Cmd+Enter) sends.
 */
export function ReplyBox({ id, label, hint, sendLabel, onSend, disabled = false, rows = 3, look = 'form' }: ReplyBoxProps) {
  const { t } = useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const empty = text.trim() === '';

  const send = async () => {
    if (empty || busy || disabled) return;
    setBusy(true);
    try {
      if (await onSend(text.trim())) setText('');
    } finally {
      setBusy(false);
    }
  };

  const composer = look === 'composer';
  return (
    <form
      class={composer ? 'composer' : 'reply-form'}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label class={composer ? 'sr-only' : 'label'} for={id}>
        {label ?? t.replyLabel}
      </label>
      <textarea
        class={composer ? 'textarea composer-input' : 'textarea'}
        id={id}
        rows={rows}
        maxLength={MAX_REPLY_CHARS}
        value={text}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        onInput={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      {composer ? (
        <>
          <button type="submit" class="btn btn-primary composer-send" disabled={empty || busy || disabled}>
            {busy ? t.sending : (sendLabel ?? t.replySend)}
          </button>
          <span class="help composer-hint" id={`${id}-hint`}>
            {hint ?? t.replyHint} {t.sendShortcut}
          </span>
        </>
      ) : (
        <>
          <span class="help" id={`${id}-hint`}>
            {hint ?? t.replyHint}
          </span>
          <div class="btn-row">
            <button type="submit" class="btn btn-primary" disabled={empty || busy || disabled}>
              {busy ? t.sending : (sendLabel ?? t.replySend)}
            </button>
            <span class="help">{t.sendShortcut}</span>
          </div>
        </>
      )}
    </form>
  );
}
