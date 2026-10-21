import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import MarkdownIt from 'markdown-it';
import { ApiError } from './apiError.js';
import { describeError } from './errors.js';
import { useApp, type Loaded } from './hooks.js';

/** Raw HTML in notes is escaped, never rendered. */
const markdown = new MarkdownIt({ html: false, linkify: false });

/**
 * Headings inside rendered notes sit two levels under the page's: a note's
 * `#` becomes an `h3`, under the page's `h1` and the section's `h2`.
 */
markdown.core.ruler.push('demote_headings', (state) => {
  for (const token of state.tokens) {
    if (token.type === 'heading_open' || token.type === 'heading_close') token.tag = `h${Math.min(6, Number(token.tag.slice(1)) + 2)}`;
  }
});

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => markdown.render(text), [text]);
  return <div class="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function ErrorBanner({ error }: { error: unknown }) {
  const { t } = useApp();
  return (
    <p class="banner banner-error" role="alert">
      {describeError(error, t)}
    </p>
  );
}

export function Notice({ children }: { children: ComponentChildren }) {
  return (
    <p class="banner banner-ok" role="status">
      {children}
    </p>
  );
}

/** Shows the loading text or the error, and the children once there is data. */
export function Loader<T>({ loaded, children }: { loaded: Loaded<T>; children: (data: T) => ComponentChildren }) {
  const { t } = useApp();
  if (loaded.error !== undefined) {
    // A refused token never works again: no retry, the message says to open the new link.
    const restarted = loaded.error instanceof ApiError && loaded.error.code === 'web.rejected.token';
    return (
      <div>
        <ErrorBanner error={loaded.error} />
        {!restarted && (
          <button type="button" onClick={loaded.reload}>
            {t.retry}
          </button>
        )}
      </div>
    );
  }
  if (loaded.data === undefined) return <p role="status">{t.loading}</p>;
  return <>{children(loaded.data)}</>;
}

export function CopyButton({ text, label, testId }: { text: string; label?: string; testId?: string }) {
  const { t } = useApp();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => setState('copied'),
      () => setState('failed'),
    );
  };
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button type="button" onClick={copy} data-testid={testId}>
      {state === 'copied' ? t.copied : state === 'failed' ? t.copyFailed : (label ?? t.copy)}
    </button>
  );
}

export interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  /** The text of the button that backs out; "Cancel" by default. */
  cancelLabel?: string;
  /** `danger` (the default) for what destroys or stops something; `normal` for what keeps it, like archiving. */
  tone?: 'danger' | 'normal';
  onConfirm(): void;
  onCancel(): void;
}

/** A modal confirmation. Escape and the Cancel button both call `onCancel`. */
export function ConfirmDialog({ title, body, confirmLabel, cancelLabel, tone = 'danger', onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useApp();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="confirm-title">{title}</h2>
      <p>{body}</p>
      <div class="actions">
        <button type="button" onClick={onCancel}>
          {cancelLabel ?? t.cancel}
        </button>
        <button type="button" class={tone === 'danger' ? 'danger primary' : 'primary'} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
