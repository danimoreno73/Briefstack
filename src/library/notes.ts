import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BriefstackError } from '../errors.js';
import { isSessionId } from '../events/index.js';
import { parseFrontmatter } from '../frontmatter/index.js';
import { SLUG_RE } from '../spec/schema.js';
import { findSecrets } from '../validate/text.js';
import { gitCommit, type GitWarning } from './git.js';
import { cleanSummary, parseIndexEntries, prependIndexEntry, upsertIndexEntry } from './indexFile.js';
import { withLibraryLock } from './lock.js';
import {
  INDEX_FILE,
  INDEX_HEADINGS,
  LESSONS_FILE,
  LESSONS_TEMPLATE,
  LIBRARY_SECTIONS,
  LOG_INDEX_FILE,
  LOG_INDEX_TEMPLATE,
  isLibrarySection,
  noteLink,
  noteRelativePath,
  toNative,
  type LibrarySection,
} from './layout.js';
import {
  PROJECT_STATUS_INPUT_FIELDS,
  STATUS_FORMAT,
  projectStatusSchema,
  readProjectStatus,
  statusIssues,
  updateProjectNote,
  writeProjectNote,
  type ProjectStatus,
} from './projectStatus.js';

/**
 * Library notes (BRIEF-phase-1 §3.4): append to an existing note before creating a
 * new one, keep `INDEX.md` up to date, never store secrets, commit each change.
 */

export interface NoteRef {
  section: LibrarySection;
  /** Slug; `undefined` for `lessons`. */
  name: string | undefined;
}

export async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return undefined;
    throw error;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/** Validates section and name; throws coded errors. */
export function noteRef(section: string, name: string | undefined): NoteRef {
  if (!isLibrarySection(section)) {
    throw new BriefstackError('library.unknownSection', { section, available: [...LIBRARY_SECTIONS] });
  }
  if (section === 'lessons') {
    if (name !== undefined && name !== 'lessons') throw new BriefstackError('library.nameNotAllowed', { section });
    return { section, name: undefined };
  }
  if (name === undefined) throw new BriefstackError('library.nameRequired', { section });
  // `INDEX` is reserved for `log/INDEX.md`; slugs are lower case anyway.
  if (!SLUG_RE.test(name) || name.length > 64) throw new BriefstackError('library.invalidName', { name });
  return { section, name };
}

/** Whether `libraryDir` holds an initialised library (its `INDEX.md` exists). */
export async function libraryExists(libraryDir: string): Promise<boolean> {
  return isFile(path.join(libraryDir, INDEX_FILE));
}

export async function assertLibrary(libraryDir: string): Promise<void> {
  if (!(await libraryExists(libraryDir))) {
    throw new BriefstackError('library.notInitialised', { dir: libraryDir });
  }
}

/** 1-based numbers of lines with secret-looking strings. */
export function secretLines(text: string): number[] {
  const lines: number[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (findSecrets(line).length > 0) lines.push(index + 1);
  });
  return lines;
}

/** First meaningful line of a body, without heading or list markers. */
export function summaryFromBody(body: string): string {
  for (const raw of body.split(/\r?\n/)) {
    // A heading that starts with a date ("### 2026-10-12") says when, not what.
    if (DATE_HEADING_RE.test(raw)) continue;
    const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/, '').trim();
    if (line !== '') return cleanSummary(line);
  }
  return '';
}

/** A markdown heading whose text starts with an ISO date, e.g. `### 2026-10-12 (notes)`. */
const DATE_HEADING_RE = /^\s*#{1,6}\s+\d{4}-\d{2}-\d{2}\b/;

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, file);
}

function withTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** `existing` plus one blank line plus `addition`. */
export function appendText(existing: string, addition: string): string {
  const base = existing.replace(/\s+$/, '');
  return base === '' ? withTrailingNewline(addition) : `${base}\n\n${withTrailingNewline(addition.replace(/^\s+/, ''))}`;
}

/**
 * Heading that dates each addition to an existing note: the ISO date (UTC)
 * alone, so old entries can be found and consolidated later.
 */
export const DATED_ENTRY_RE = /^### (\d{4}-\d{2}-\d{2})$/gm;

export function datedEntryHeading(now: Date): string {
  return `### ${today(now)}`;
}

/**
 * `appendText` with a date heading before the addition. A date heading the
 * addition already starts with is dropped, so the entry is not dated twice.
 */
export function appendDated(existing: string, addition: string, now: Date): string {
  let body = addition.replace(/^\s+/, '');
  if (DATE_HEADING_RE.test(body.split(/\r?\n/, 1)[0] ?? '')) body = body.replace(/^[^\n]*\n?/, '').replace(/^\s+/, '');
  return appendText(existing, `${datedEntryHeading(now)}\n\n${body}`);
}

/** The dates of the dated entries in a note, in file order. */
export function datedEntries(text: string): string[] {
  return [...text.matchAll(DATED_ENTRY_RE)].map((match) => match[1] ?? '');
}

interface AddNoteBase {
  libraryDir: string;
  section: string;
  name?: string | undefined;
  /** `projects` only: the creation session id, recorded in the status block. */
  session?: string | undefined;
  now?: Date;
}

/** The content comes from exactly one of `fromFile` and `text`. */
export type AddNoteOptions = AddNoteBase &
  (
    | {
        /** Markdown file with the content. Its frontmatter is read, not copied. */
        fromFile: string;
        text?: never;
      }
    | {
        /** The content itself, read like a `fromFile` file. */
        text: string;
        fromFile?: never;
      }
  );

export interface AddNoteResult {
  section: LibrarySection;
  name: string | undefined;
  /** Relative path with `/`. */
  file: string;
  action: 'created' | 'appended';
  indexUpdated: boolean;
  committed: boolean;
  status?: ProjectStatus;
  warnings: GitWarning[];
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

function projectStatusFor(
  data: Record<string, unknown>,
  previous: ProjectStatus | undefined,
  slug: string,
  body: string,
  now: Date,
  file: string,
  link: { isNew: boolean; session?: string | undefined },
): ProjectStatus {
  const merged: Record<string, unknown> = { ...previous };
  for (const key of PROJECT_STATUS_INPUT_FIELDS) {
    const value = stringField(data, key);
    if (value !== undefined) merged[key] = value;
  }
  const given = stringField(data, 'slug');
  if (given !== undefined && given !== slug) {
    throw new BriefstackError('library.invalidProjectStatus', { file, issues: [`slug: "${given}" differs from the note name "${slug}"`] });
  }
  merged.summary ??= summaryFromBody(body) || undefined;
  merged.statusFormat = STATUS_FORMAT;
  merged.slug = slug;
  merged.updated = today(now);
  if (link.isNew) merged.created = today(now);
  // A note keeps the session that created it: a later `--session` (a second
  // session updating the project) only fills the field when the note has
  // none, e.g. a note written before sessions were recorded.
  if (link.session !== undefined && merged.session === undefined) merged.session = link.session;
  const result = projectStatusSchema.safeParse(merged);
  if (!result.success) {
    throw new BriefstackError('library.invalidProjectStatus', { file, issues: statusIssues(result.error) });
  }
  return result.data;
}

function previousStatus(existing: string | undefined, relative: string): ProjectStatus | undefined {
  if (existing === undefined) return undefined;
  const read = readProjectStatus(existing, relative);
  return read.ok ? read.status : undefined;
}

/** A note's new text, before anything is written. */
interface NoteChange {
  ref: NoteRef;
  /** Relative path with `/`. */
  relative: string;
  existing: string | undefined;
  next: string;
  status?: ProjectStatus | undefined;
  /** The index line, or `undefined` to keep the current one. */
  summary: string | undefined;
  /** Whether the content gave a `summary` (lessons only get an index update then). */
  summaryGiven: boolean;
}

/**
 * The `library add` change: `body` appended to the note with a date heading,
 * or a new note made of it. `data` is the content's frontmatter.
 */
function appendChange(
  ref: NoteRef,
  relative: string,
  existing: string | undefined,
  data: Record<string, unknown>,
  body: string,
  now: Date,
  label: string,
  session: string | undefined,
): NoteChange {
  const givenSummary = stringField(data, 'summary');
  let next: string;
  let status: ProjectStatus | undefined;
  if (ref.section === 'projects') {
    status = projectStatusFor(data, previousStatus(existing, relative), ref.name ?? '', body, now, label, {
      isNew: existing === undefined,
      session,
    });
    if (existing === undefined) next = writeProjectNote(status, withTrailingNewline(body));
    else {
      const updated = updateProjectNote(existing, status, relative);
      next = body.trim() === '' ? updated : appendDated(updated, body, now);
    }
  } else if (existing === undefined) {
    // Lessons are always dated, even when lessons.md has to be recreated.
    if (ref.section === 'lessons') next = appendDated(LESSONS_TEMPLATE, body, now);
    else next = withTrailingNewline(body);
  } else {
    next = appendDated(existing, body, now);
  }

  // The index line: given summary, else the note's first line for a new note.
  const summary =
    status?.summary ??
    (givenSummary !== undefined ? cleanSummary(givenSummary) : existing === undefined ? summaryFromBody(body) : undefined);
  return { ref, relative, existing, next, status, summary, summaryGiven: givenSummary !== undefined };
}

/** Writes the note and its index line, then commits both in one commit. */
async function applyChange(
  libraryDir: string,
  change: NoteChange,
): Promise<{ indexUpdated: boolean; committed: boolean; warnings: GitWarning[] }> {
  const { ref, relative, existing, next, summary } = change;
  const changed: string[] = [];
  let indexUpdated = false;
  if (next !== existing) {
    await writeAtomic(toNative(libraryDir, relative), next);
    changed.push(relative);
  }
  if (ref.section === 'log') {
    const logIndex = toNative(libraryDir, LOG_INDEX_FILE);
    const current = (await readTextIfExists(logIndex)) ?? LOG_INDEX_TEMPLATE;
    const update = prependIndexEntry(current, noteLink('log', ref.name), summary);
    if (update.changed) {
      await writeAtomic(logIndex, update.text);
      changed.push(LOG_INDEX_FILE);
      indexUpdated = true;
    }
  } else if (ref.section !== 'lessons' || change.summaryGiven) {
    const indexFile = toNative(libraryDir, INDEX_FILE);
    const current = (await readTextIfExists(indexFile)) ?? '';
    const update = upsertIndexEntry(current, INDEX_HEADINGS[ref.section], noteLink(ref.section, ref.name), summary);
    if (update.changed) {
      await writeAtomic(indexFile, update.text);
      changed.push(INDEX_FILE);
      indexUpdated = true;
    }
  }

  const verb = existing === undefined ? 'add' : 'update';
  const commit = await gitCommit(libraryDir, changed, `library: ${verb} ${noteLink(ref.section, ref.name)}`);
  return { indexUpdated, committed: commit.committed, warnings: commit.warning !== undefined ? [commit.warning] : [] };
}

function assertSessionId(session: string | undefined): void {
  if (session !== undefined && !isSessionId(session)) {
    throw new BriefstackError('events.invalidSession', { session });
  }
}

/**
 * Adds content, from a markdown file or given as text, to a note.
 * Everything is checked before anything is written: a secret, an invalid
 * name or an invalid project status leaves the library untouched.
 *
 * - The content's frontmatter is not copied. `summary` (any section)
 *   sets the note's line in the index; for `projects`, `target`, `path`,
 *   `status`, `profile` and `summary` set the status block.
 * - An existing note gets the body appended after a blank line; a new note
 *   is created with it.
 */
export async function addNote(options: AddNoteOptions): Promise<AddNoteResult> {
  const { libraryDir } = options;
  if ((options.fromFile === undefined) === (options.text === undefined)) {
    throw new TypeError('addNote needs exactly one of fromFile and text');
  }
  const ref = noteRef(options.section, options.name);
  await assertLibrary(libraryDir);
  const now = options.now ?? new Date();
  assertSessionId(options.session);

  const relative = noteRelativePath(ref.section, ref.name);
  // Errors about the content name the --from file, or the note for text.
  const label = options.fromFile ?? relative;
  let source: string | undefined = options.text;
  if (options.fromFile !== undefined) {
    source = await readTextIfExists(options.fromFile);
    if (source === undefined) throw new BriefstackError('library.fileNotFound', { file: options.fromFile });
  }
  const content = source ?? '';
  const leaked = secretLines(content);
  if (leaked.length > 0) throw new BriefstackError('library.secretContent', { file: label, lines: leaked });
  const { data, body: rawBody } = parseFrontmatter(content, label);
  const body = rawBody.replace(/^\s*\n/, '');
  if (body.trim() === '' && ref.section !== 'projects') {
    throw new BriefstackError('library.emptyContent', { file: label });
  }

  // From the read of the note to its commit, one change at a time per library (lock.ts).
  return withLibraryLock(libraryDir, async () => {
    const existing = await readTextIfExists(toNative(libraryDir, relative));
    const change = appendChange(ref, relative, existing, data, body, now, label, options.session);
    const applied = await applyChange(libraryDir, change);
    return {
      section: ref.section,
      name: ref.name,
      file: relative,
      action: existing === undefined ? 'created' : 'appended',
      indexUpdated: applied.indexUpdated,
      committed: applied.committed,
      ...(change.status !== undefined ? { status: change.status } : {}),
      warnings: applied.warnings,
    };
  });
}

export interface SaveNoteOptions {
  libraryDir: string;
  section: string;
  name?: string | undefined;
  /** The whole note, frontmatter included. */
  text: string;
  now?: Date;
}

export type SaveMode = 'append' | 'rewrite' | 'create' | 'unchanged';

export interface SaveNoteResult extends Omit<AddNoteResult, 'action'> {
  mode: SaveMode;
}

/**
 * The text added at the end of `existing`, or `undefined` when `text` is
 * not `existing` plus whole new lines (trailing whitespace ignored). Text
 * added on the old last line is an edit of that line, not an addition.
 */
function addedAtEnd(existing: string, text: string): string | undefined {
  const before = existing.replace(/\s+$/, '');
  const after = text.replace(/\s+$/, '');
  if (before === '' || after.length <= before.length || !after.startsWith(before)) return undefined;
  const added = after.slice(before.length);
  return /^\r?\n/.test(added) ? added.replace(/^\s*\n/, '') : undefined;
}

/** What `saveNote` does with `text` for a note that now holds `existing` (`undefined`: no note yet). */
export function saveModeOf(existing: string | undefined, text: string): SaveMode {
  if (existing === undefined) return 'create';
  if (existing.replace(/\s+$/, '') === text.replace(/\s+$/, '')) return 'unchanged';
  return addedAtEnd(existing, text) === undefined ? 'rewrite' : 'append';
}

/** A whole new text for a note (doubt 4: any edit that is not an addition at the end). */
function rewriteChange(
  ref: NoteRef,
  relative: string,
  existing: string | undefined,
  text: string,
  now: Date,
): NoteChange {
  const { hasFrontmatter, data, body } = parseFrontmatter(text, relative);
  const givenSummary = stringField(data, 'summary');
  if (ref.section !== 'projects') {
    if (text.trim() === '') throw new BriefstackError('library.emptyContent', { file: relative });
    const summary =
      givenSummary !== undefined ? cleanSummary(givenSummary) : existing === undefined ? summaryFromBody(body) : undefined;
    return { ref, relative, existing, next: withTrailingNewline(text), summary, summaryGiven: givenSummary !== undefined };
  }

  // The status block is part of the text; briefstack's own fields
  // (`statusFormat`, `slug`, `updated`, and `created`/`session` once set)
  // are kept or rewritten, and the result is checked as a whole.
  const previous = previousStatus(existing, relative);
  const status = projectStatusFor(data, previous, ref.name ?? '', body, now, relative, {
    isNew: existing === undefined,
    session: stringField(data, 'session'),
  });
  let next: string;
  if (!hasFrontmatter) next = writeProjectNote(status, withTrailingNewline(body));
  else {
    next = withTrailingNewline(updateProjectNote(text, status, relative));
    if (data.statusFormat === undefined) next = next.replace(/^(\uFEFF?---\r?\n)/, `$1statusFormat: ${STATUS_FORMAT}\n`);
  }
  const read = readProjectStatus(next, relative);
  if (!read.ok) throw new BriefstackError('library.invalidProjectStatus', { file: relative, issues: read.issues });
  return { ref, relative, existing, next, status: read.status, summary: read.status.summary, summaryGiven: true };
}

/**
 * Saves a whole note, as edited in the web app (doubt 4). When the new text
 * only adds lines at the end, the addition goes through the same dated
 * append as `library add`; any other edit is a full rewrite. Both check for
 * secrets and, in `projects/`, the status block, update the index and make
 * one commit. Identical text (trailing whitespace aside) changes nothing.
 */
export async function saveNote(options: SaveNoteOptions): Promise<SaveNoteResult> {
  const ref = noteRef(options.section, options.name);
  await assertLibrary(options.libraryDir);
  // From the read of the note to its commit, one change at a time per library (lock.ts).
  return withLibraryLock(options.libraryDir, () => saveNoteLocked(options, ref));
}

async function saveNoteLocked(options: SaveNoteOptions, ref: NoteRef): Promise<SaveNoteResult> {
  const { libraryDir, text } = options;
  const now = options.now ?? new Date();
  const relative = noteRelativePath(ref.section, ref.name);
  const existing = await readTextIfExists(toNative(libraryDir, relative));
  const base = { section: ref.section, name: ref.name, file: relative };

  if (existing !== undefined && existing.replace(/\s+$/, '') === text.replace(/\s+$/, '')) {
    const status = ref.section === 'projects' ? previousStatus(existing, relative) : undefined;
    return { ...base, mode: 'unchanged', indexUpdated: false, committed: false, ...(status !== undefined ? { status } : {}), warnings: [] };
  }
  const leaked = secretLines(text);
  if (leaked.length > 0) throw new BriefstackError('library.secretContent', { file: relative, lines: leaked });

  const added = existing === undefined ? undefined : addedAtEnd(existing, text);
  let change: NoteChange;
  let mode: SaveMode;
  if (added !== undefined) {
    change = appendChange(ref, relative, existing, {}, added, now, relative, undefined);
    mode = 'append';
  } else {
    change = rewriteChange(ref, relative, existing, text, now);
    mode = existing === undefined ? 'create' : 'rewrite';
  }
  const applied = await applyChange(libraryDir, change);
  return {
    ...base,
    mode,
    indexUpdated: applied.indexUpdated,
    committed: applied.committed,
    ...(change.status !== undefined ? { status: change.status } : {}),
    warnings: applied.warnings,
  };
}

export interface NoteSummary {
  section: LibrarySection;
  name: string | undefined;
  /** Relative path with `/`. */
  file: string;
  /** From the index, or empty. */
  summary: string;
}

async function markdownNames(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name.slice(0, -'.md'.length))
    .sort();
}

/** Notes in one section, or in all of them, sorted by name (code-point order). */
export async function listNotes(libraryDir: string, section?: string): Promise<NoteSummary[]> {
  const sections: LibrarySection[] =
    section === undefined ? [...LIBRARY_SECTIONS] : [noteRef(section, section === 'lessons' ? undefined : 'x').section];
  const indexText = (await readTextIfExists(toNative(libraryDir, INDEX_FILE))) ?? '';
  const logText = (await readTextIfExists(toNative(libraryDir, LOG_INDEX_FILE))) ?? '';
  const summaries = new Map<string, string>();
  for (const entry of [...parseIndexEntries(indexText), ...parseIndexEntries(logText)]) {
    summaries.set(entry.link.toLowerCase(), entry.summary);
  }

  const notes: NoteSummary[] = [];
  for (const current of sections) {
    if (current === 'lessons') {
      if (await isFile(toNative(libraryDir, LESSONS_FILE))) {
        notes.push({ section: current, name: undefined, file: LESSONS_FILE, summary: summaries.get('lessons') ?? '' });
      }
      continue;
    }
    for (const name of await markdownNames(path.join(libraryDir, current))) {
      if (current === 'log' && name === 'INDEX') continue;
      const link = noteLink(current, name);
      notes.push({ section: current, name, file: noteRelativePath(current, name), summary: summaries.get(link.toLowerCase()) ?? '' });
    }
  }
  return notes;
}

/** The text of one note. */
export async function readNote(libraryDir: string, section: string, name?: string): Promise<{ file: string; text: string }> {
  const ref = noteRef(section, name);
  const file = noteRelativePath(ref.section, ref.name);
  const text = await readTextIfExists(toNative(libraryDir, file));
  if (text === undefined) {
    throw new BriefstackError('library.noteNotFound', { section: ref.section, name: ref.name ?? LESSONS_FILE });
  }
  return { file, text };
}
