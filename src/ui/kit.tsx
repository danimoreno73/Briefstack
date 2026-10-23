import { Fragment, type ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { ApiError } from './apiError.js';
import { describeError } from './errors.js';
import { useApp, type Loaded } from './hooks.js';
import { IconAlert, IconCheck, IconInfo } from './icons.js';

/**
 * Shared parts built on bs.css (U5). The screens not yet moved to it keep
 * the parts in common.tsx, styled by the `.legacy` sheet.
 */

/** A notice: `warn` informs, `danger` is an error or a risk, `ok` confirms. */
export function Note({
  tone = 'plain',
  title,
  role,
  children,
  testId,
}: {
  tone?: 'plain' | 'warn' | 'danger' | 'ok';
  title?: string;
  role?: 'alert' | 'status';
  children?: ComponentChildren;
  testId?: string;
}) {
  return (
    <div class={tone === 'plain' ? 'note' : `note note-${tone}`} role={role} data-testid={testId}>
      {tone === 'danger' ? <IconAlert /> : tone === 'ok' ? <IconCheck /> : <IconInfo />}
      <div class="note-body">
        {title !== undefined && <p class="note-title">{title}</p>}
        {children !== undefined && <div class="note-text">{children}</div>}
      </div>
    </div>
  );
}

/** A line of small facts in the monospace, a dot between each; parts that are `false` or `undefined` are left out. */
export function MetaLine({ parts }: { parts: (ComponentChildren | false | undefined)[] }) {
  const shown = parts.filter((part) => part !== false && part !== undefined);
  return (
    <span class="meta">
      {shown.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <span aria-hidden="true">·</span>}
          <span>{part}</span>
        </Fragment>
      ))}
    </span>
  );
}

/** Nothing to list yet: what is missing, and the way to make the first one. */
export function Empty({ title, body, action }: { title: string; body?: string; action?: { href: string; label: string } }) {
  return (
    <div class="empty">
      <p class="t-3">{title}</p>
      {body !== undefined && <p class="t-small muted">{body}</p>}
      {action !== undefined && (
        <a class="btn btn-primary" href={action.href}>
          {action.label}
        </a>
      )}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const { t } = useApp();
  return (
    <Note tone="danger" role="alert">
      {describeError(error, t)}
    </Note>
  );
}

/** The loading bar or the error, and the children once there is data. */
export function LoadState<T>({ loaded, children }: { loaded: Loaded<T>; children: (data: T) => ComponentChildren }) {
  const { t } = useApp();
  if (loaded.error !== undefined) {
    // A refused token never works again: no retry, the message says to open the new link.
    const restarted = loaded.error instanceof ApiError && loaded.error.code === 'web.rejected.token';
    return (
      <div class="stack-2">
        <ErrorNote error={loaded.error} />
        {!restarted && (
          <div class="btn-row">
            <button type="button" class="btn btn-secondary btn-sm" onClick={loaded.reload}>
              {t.retry}
            </button>
          </div>
        )}
      </div>
    );
  }
  if (loaded.data === undefined) return <Loading />;
  return <>{children(loaded.data)}</>;
}

export function Loading() {
  const { t } = useApp();
  return (
    <div class="loading" role="status">
      <span class="meta">{t.loading}</span>
      <span class="loader" aria-hidden="true">
        <span />
      </span>
    </div>
  );
}

export interface ModalProps {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * A modal confirmation for what stops or destroys something. Focus starts on
 * the button that backs out; Escape backs out too.
 */
export function ConfirmModal({ title, body, confirmLabel, cancelLabel, onConfirm, onCancel }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  // Before the browser paints, so the dialog never shows with focus still behind it.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
    keep.current?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      class="dialog"
      aria-labelledby="confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 class="t-2" id="confirm-title">
        {title}
      </h2>
      <p class="t-small muted">{body}</p>
      <div class="btn-row">
        <button ref={keep} type="button" class="btn btn-secondary" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" class="btn btn-danger" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
