import { Fragment } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import MarkdownIt from 'markdown-it';
import { pathPieces } from './format.js';
import { useApp } from './hooks.js';

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

/** Rendered Markdown, styled by app.css's `.md`. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => markdown.render(text), [text]);
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A path in the monospace that wraps only between folders (audit L6). */
export function PathText({ value }: { value: string }) {
  return (
    <span class="path-text">
      {pathPieces(value).map((piece, index) => (
        <Fragment key={index}>
          {index > 0 && <wbr />}
          {piece}
        </Fragment>
      ))}
    </span>
  );
}

/** A button that copies `text`, says so for two seconds, and says when the browser refused. */
export function CopyButton({ text, label, testId, cls }: { text: string; label?: string; testId?: string; cls?: string }) {
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
    <button type="button" class={cls} onClick={copy} data-testid={testId}>
      {state === 'copied' ? t.copied : state === 'failed' ? t.copyFailed : (label ?? t.copy)}
    </button>
  );
}
