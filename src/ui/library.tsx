import { useEffect, useState } from 'preact/hooks';
import { ApiError } from './api.js';
import { ConfirmDialog, ErrorBanner, Loader, Markdown, Notice } from './common.js';
import { formatWhen, hasHiddenLines, hideSecrets, stripFrontmatter } from './format.js';
import { useApp, useLoad, useSend } from './hooks.js';
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

export function LibraryView({ section, name }: { section: string | undefined; name: string | undefined }) {
  const { t } = useApp();
  const label = useSectionLabel();
  const current = section ?? 'index';
  return (
    <section>
      <h1>{t.libraryTitle}</h1>
      <nav class="tabs" aria-label={t.libraryTitle}>
        {SECTIONS.map((entry) => (
          <a
            key={entry}
            href={routeHash({ page: 'library', section: entry, name: undefined })}
            aria-current={entry === current ? 'page' : undefined}
          >
            {label(entry)}
          </a>
        ))}
      </nav>
      {current === 'index' && <IndexView />}
      {current === 'history' && <HistoryView />}
      {current === 'lessons' && <NoteEditor key="lessons" section="lessons" name={undefined} />}
      {current !== 'index' && current !== 'history' && current !== 'lessons' &&
        (name === undefined ? <NoteList section={current} /> : <NoteEditor key={`${current}/${name}`} section={current} name={name} />)}
    </section>
  );
}

function IndexView() {
  const { t } = useApp();
  const loaded = useLoad<{ text: string | null }>('/api/library/index');
  return (
    <Loader loaded={loaded}>
      {({ text }) => (
        <>
          <p class="muted">{t.indexReadOnly}</p>
          {text === null ? <p>{t.noNotes}</p> : <Markdown text={text} />}
        </>
      )}
    </Loader>
  );
}

function NoteList({ section }: { section: string }) {
  const { t } = useApp();
  const loaded = useLoad<{ notes: NoteSummary[] }>(`/api/library/notes?section=${encodeURIComponent(section)}`);
  return (
    <Loader loaded={loaded}>
      {({ notes }) =>
        notes.length === 0 ? (
          <p>{t.noNotes}</p>
        ) : (
          <ul data-testid="notes">
            {notes.map((note) => (
              <li key={note.file}>
                <a href={routeHash({ page: 'library', section: note.section, name: note.name })}>{note.name ?? note.file}</a>
                {note.summary !== '' && <span class="muted"> — {note.summary}</span>}
              </li>
            ))}
          </ul>
        )
      }
    </Loader>
  );
}

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
  const original = loaded.data?.text;

  useEffect(() => {
    if (original !== undefined) {
      setText(original);
      setSaved(original);
    }
  }, [original]);

  const dirty = text !== saved;
  const hidden = hasHiddenLines(text);

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

  return (
    <Loader loaded={loaded}>
      {({ file }) => (
        <div>
          <h2>
            <code>{file}</code>
          </h2>
          {error !== undefined && <ErrorBanner error={error} />}
          {notice !== undefined && <Notice>{notice}</Notice>}
          {hidden && <p class="banner banner-error" role="alert">{t.redactedWarning}</p>}
          <div class="editor">
            <label>
              {t.editorLabel}
              <textarea
                data-testid="editor"
                value={text}
                spellcheck={false}
                onInput={(event) => {
                  setText(event.currentTarget.value);
                  setNotice(undefined);
                }}
              />
            </label>
            <div>
              <h3>{t.previewLabel}</h3>
              <div data-testid="preview">
                <Markdown text={hideSecrets(stripFrontmatter(text))} />
              </div>
            </div>
          </div>
          <div class="actions">
            <button type="button" disabled={!dirty || busy || hidden} onClick={() => void save()}>
              {busy ? t.saving : t.save}
            </button>
            {dirty && <span class="muted">{t.unsaved}</span>}
          </div>
        </div>
      )}
    </Loader>
  );
}

function HistoryView() {
  const { t, lang } = useApp();
  const send = useSend();
  const loaded = useLoad<{ commits: LibraryCommit[] }>('/api/library/history?limit=50');
  const [asking, setAsking] = useState<LibraryCommit | undefined>(undefined);
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
    <div>
      <h2>{t.historyTitle}</h2>
      {error !== undefined && <ErrorBanner error={error} />}
      {notice !== undefined && <Notice>{notice}</Notice>}
      <Loader loaded={loaded}>
        {({ commits }) =>
          commits.length === 0 ? (
            <p class="empty">{t.historyEmpty}</p>
          ) : (
            <ul class="history" data-testid="history">
              {commits.map((commit) => (
                <li key={commit.sha}>
                  <code>{commit.shortSha}</code> <span>{commit.subject}</span>{' '}
                  <span class="muted">
                    {formatWhen(commit.date, lang)} · {t.filesChanged(commit.files.length)}
                  </span>{' '}
                  <button type="button" onClick={() => setAsking(commit)}>
                    {t.revert}
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </Loader>
      {asking !== undefined && (
        <ConfirmDialog
          title={t.revertTitle}
          body={t.revertBody(asking.shortSha, asking.subject)}
          confirmLabel={t.revertConfirm}
          onConfirm={() => void revert(asking)}
          onCancel={() => setAsking(undefined)}
        />
      )}
    </div>
  );
}
