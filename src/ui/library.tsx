import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from './api.js';
import { Markdown } from './common.js';
import { formatWhen, hasHiddenLines, hideSecrets, stripFrontmatter } from './format.js';
import { useApp, useDocumentTitle, useLoad, useSend } from './hooks.js';
import { ErrorNote, LoadState, MetaLine, Note } from './kit.js';
import { routeHash } from './route.js';
import type { LibraryCommit, NoteSummary, SaveNoteResult } from './types.js';

const SECTIONS = ['index', 'profile', 'projects', 'log', 'skills', 'lessons', 'history'] as const;

function useSectionLabel(): (section: string) => string {
  const { t } = useApp();
  const labels: Record<string, string> = {
    index: t.sectionIndex,
    profile: t.sectionProfile,
    projects: t.sectionProjects,
    log: t.sectionLog,
    skills: t.sectionSkills,
    lessons: t.sectionLessons,
    history: t.sectionHistory,
  };
  return (section) => labels[section] ?? section;
}

/** The library on bs.css: the sections as a tree beside the open section or note. */
export function LibraryView({ section, name }: { section: string | undefined; name: string | undefined }) {
  const { t } = useApp();
  const label = useSectionLabel();
  const current = section ?? 'index';
  useDocumentTitle(name ?? `${label(current)} · ${t.libraryTitle}`);
  // A section's notes go under it in the tree once one of them is open; before that the page lists them.
  const children = name !== undefined && current !== 'lessons' ? current : undefined;
  return (
    <div class="lib">
      <nav class="lib-tree" aria-label={t.libraryTitle}>
        {SECTIONS.map((entry) => (
          <div key={entry} class="tree-group">
            <a
              class="tree-item"
              href={routeHash({ page: 'library', section: entry, name: undefined })}
              aria-current={entry === current && (name === undefined || entry === 'lessons') ? 'true' : undefined}
            >
              {label(entry)}
            </a>
            {entry === children && <TreeNotes section={entry} open={name} />}
          </div>
        ))}
      </nav>
      <div class="lib-main">
        {current === 'index' && <IndexView />}
        {current === 'history' && <HistoryView />}
        {current === 'lessons' && <NoteEditor key="lessons" section="lessons" name={undefined} />}
        {current !== 'index' &&
          current !== 'history' &&
          current !== 'lessons' &&
          (name === undefined ? <NoteList section={current} title={label(current)} /> : <NoteEditor key={`${current}/${name}`} section={current} name={name} />)}
      </div>
    </div>
  );
}

function TreeNotes({ section, open }: { section: string; open: string | undefined }) {
  const loaded = useLoad<{ notes: NoteSummary[] }>(`/api/library/notes?section=${encodeURIComponent(section)}`);
  return (
    <>
      {(loaded.data?.notes ?? []).map((note) => (
        <a
          key={note.file}
          class="tree-item tree-child"
          href={routeHash({ page: 'library', section: note.section, name: note.name })}
          aria-current={note.name === open ? 'true' : undefined}
        >
          {note.name ?? note.file}
        </a>
      ))}
    </>
  );
}

function IndexView() {
  const { t } = useApp();
  const loaded = useLoad<{ text: string | null }>('/api/library/index');
  return (
    <>
      <div class="lib-head">
        <div class="page-head-text">
          <h1 class="t-1">{t.libraryTitle}</h1>
          <p class="sub">{t.indexReadOnly}</p>
        </div>
      </div>
      <LoadState loaded={loaded}>
        {({ text }) =>
          text === null ? (
            <p class="muted">{t.noNotes}</p>
          ) : (
            <article class="md-preview">
              <Markdown text={text} cls="md" />
            </article>
          )
        }
      </LoadState>
    </>
  );
}

function NoteList({ section, title }: { section: string; title: string }) {
  const { t } = useApp();
  const loaded = useLoad<{ notes: NoteSummary[] }>(`/api/library/notes?section=${encodeURIComponent(section)}`);
  return (
    <>
      <div class="lib-head">
        <h1 class="t-1">{title}</h1>
      </div>
      <LoadState loaded={loaded}>
        {({ notes }) =>
          notes.length === 0 ? (
            <p class="muted">{t.noNotes}</p>
          ) : (
            <ul class="card-grid" data-testid="notes">
              {notes.map((note) => (
                <li key={note.file} class="card">
                  <a class="link mono" href={routeHash({ page: 'library', section: note.section, name: note.name })}>
                    {note.name ?? note.file}
                  </a>
                  {note.summary !== '' && <span class="t-small muted">{note.summary}</span>}
                </li>
              ))}
            </ul>
          )
        }
      </LoadState>
    </>
  );
}

type EditorMode = 'edit' | 'split' | 'preview';

function NoteEditor({ section, name }: { section: string; name: string | undefined }) {
  const { t } = useApp();
  const send = useSend();
  const query = `section=${encodeURIComponent(section)}${name === undefined ? '' : `&name=${encodeURIComponent(name)}`}`;
  const loaded = useLoad<{ file: string; text: string }>(`/api/library/note?${query}`);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<EditorMode>('split');
  const original = loaded.data?.text;

  useEffect(() => {
    if (original !== undefined) {
      setText(original);
      setSaved(original);
    }
  }, [original]);

  const dirty = text !== saved;
  const hidden = hasHiddenLines(text);
  // Editable once the box holds the loaded note: typed text never lands in the instant before it arrives and is then replaced.
  const synced = original !== undefined && saved === original;
  // A save refused for a secret marks the editor, until the text changes.
  const secretRefused = error instanceof ApiError && error.code === 'library.secretContent';

  const save = async () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await send<SaveNoteResult>('PUT', '/api/library/note', {
        section,
        ...(name === undefined ? {} : { name }),
        text,
      });
      setSaved(text);
      setNotice(t.saveMode(result.mode));
      loaded.reload();
    } catch (failure) {
      // The text stays in the editor; only a fixed message is shown elsewhere.
      setError(failure instanceof ApiError ? failure : new Error('save'));
    } finally {
      setBusy(false);
    }
  };

  const modes: { value: EditorMode; label: string }[] = [
    { value: 'edit', label: t.modeEdit },
    { value: 'split', label: t.modeSplit },
    { value: 'preview', label: t.previewLabel },
  ];

  return (
    <LoadState loaded={loaded}>
      {({ file }) => (
        <>
          <div class="lib-head">
            <div class="page-head-text">
              <h1 class="t-1 note-title">{name ?? t.sectionLessons}</h1>
              <MetaLine parts={[file, dirty && <span class="unsaved-mark">{t.unsaved}</span>]} />
            </div>
            <div class="btn-row">
              <div class="seg" role="group" aria-label={t.editorMode}>
                {modes.map((option) => (
                  <button key={option.value} type="button" aria-pressed={mode === option.value} onClick={() => setMode(option.value)}>
                    {option.label}
                  </button>
                ))}
              </div>
              <button type="button" class="btn btn-primary" disabled={!dirty || busy || hidden} onClick={() => void save()}>
                {busy ? t.saving : t.save}
              </button>
            </div>
          </div>
          {error !== undefined && <ErrorNote error={error} />}
          {notice !== undefined && (
            <Note tone="ok" role="status">
              {notice}
            </Note>
          )}
          {hidden && (
            <Note tone="danger" role="alert">
              {t.redactedWarning}
            </Note>
          )}
          <div class={`editor editor-${mode}`}>
            {mode !== 'preview' && (
              <div class="field">
                <label class="sr-only" for="note-editor">
                  {t.editorLabel}
                </label>
                <textarea
                  id="note-editor"
                  class="md-editor"
                  data-testid="editor"
                  value={text}
                  readOnly={!synced}
                  spellcheck={false}
                  aria-invalid={secretRefused || hidden ? 'true' : undefined}
                  onInput={(event) => {
                    setText(event.currentTarget.value);
                    setNotice(undefined);
                    if (secretRefused) setError(undefined);
                  }}
                />
              </div>
            )}
            {mode !== 'edit' && (
              <article class="md-preview" aria-label={t.previewLabel} data-testid="preview">
                <Markdown text={hideSecrets(stripFrontmatter(text))} cls="md" />
              </article>
            )}
          </div>
        </>
      )}
    </LoadState>
  );
}

function HistoryView() {
  const { t, lang } = useApp();
  const send = useSend();
  const loaded = useLoad<{ commits: LibraryCommit[] }>('/api/library/history?limit=50');
  const [asking, setAsking] = useState<string | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const revert = async (commit: LibraryCommit) => {
    setAsking(undefined);
    setError(undefined);
    setNotice(undefined);
    try {
      await send('POST', '/api/library/revert', { sha: commit.sha });
      setNotice(t.reverted(commit.shortSha));
      loaded.reload();
    } catch (failure) {
      setError(failure);
    }
  };

  return (
    <>
      <div class="lib-head">
        <h1 class="t-1">{t.historyTitle}</h1>
      </div>
      {error !== undefined && <ErrorNote error={error} />}
      {notice !== undefined && (
        <Note tone="ok" role="status">
          {notice}
        </Note>
      )}
      <LoadState loaded={loaded}>
        {({ commits }) =>
          commits.length === 0 ? (
            <p class="muted">{t.historyEmpty}</p>
          ) : (
            <ol class="commits" data-testid="history">
              {commits.map((commit) => (
                <li key={commit.sha} class="commit-item">
                  {/* The subject first, the commit, date and files beside it; Revert as a quiet row action (audit L8). */}
                  <div class="commit-row">
                    <span class="sha">{commit.shortSha}</span>
                    <span class="commit-subject">
                      {commit.subject}
                      <span class="meta">{t.filesChanged(commit.files.length)}</span>
                    </span>
                    <span class="mono-s faint when">{formatWhen(commit.date, lang)}</span>
                    <RevertButton open={asking === commit.sha} onClick={() => setAsking(commit.sha)} />
                  </div>
                  {asking === commit.sha && (
                    <RevertConfirm commit={commit} onConfirm={() => void revert(commit)} onCancel={() => setAsking(undefined)} />
                  )}
                </li>
              ))}
            </ol>
          )
        }
      </LoadState>
    </>
  );
}

function RevertButton({ open, onClick }: { open: boolean; onClick(): void }) {
  const { t } = useApp();
  return (
    <button type="button" class="btn btn-secondary btn-sm revert-button" aria-expanded={open} onClick={onClick}>
      {t.revert}
    </button>
  );
}

/**
 * The confirmation, in line and in cream (it waits for the user's answer):
 * a non-modal dialog under the commit, focus on the button that backs out,
 * Escape backs out too and focus returns to Revert.
 */
function RevertConfirm({ commit, onConfirm, onCancel }: { commit: LibraryCommit; onConfirm(): void; onCancel(): void }) {
  const { t } = useApp();
  const box = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  // Before the browser paints: the dialog never shows with focus still outside it, where Escape would miss it.
  useLayoutEffect(() => {
    cancelButton.current?.focus();
  }, []);
  const back = () => {
    const revertButton = box.current?.parentElement?.querySelector<HTMLButtonElement>('.revert-button');
    onCancel();
    setTimeout(() => revertButton?.focus(), 0);
  };
  return (
    <div
      ref={box}
      class="dec dec-sm revert-confirm"
      role="dialog"
      aria-labelledby={`revert-${commit.sha}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          back();
        }
      }}
    >
      <h2 class="strong" id={`revert-${commit.sha}`}>
        {t.revertTitle}
      </h2>
      <p class="t-small muted">{t.revertBody(commit.shortSha, commit.subject)}</p>
      <div class="btn-row">
        <button type="button" class="btn btn-primary btn-sm" onClick={onConfirm}>
          {t.revertConfirm}
        </button>
        <button ref={cancelButton} type="button" class="btn btn-secondary btn-sm" onClick={back}>
          {t.cancel}
        </button>
      </div>
    </div>
  );
}
