import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BriefstackError } from '../errors.js';
import { parseFrontmatter } from '../frontmatter/index.js';
import { SLUG_RE } from '../spec/schema.js';
import { findSecrets } from '../validate/text.js';
import { gitCommit, type GitWarning } from './git.js';
import { cleanSummary, parseIndexEntries, prependIndexEntry, upsertIndexEntry } from './indexFile.js';
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

export interface AddNoteOptions {
  libraryDir: string;
  section: string;
  name?: string | undefined;
  /** Markdown file with the content. Its frontmatter is read, not copied. */
  fromFile: string;
  now?: Date;
}

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
  const result = projectStatusSchema.safeParse(merged);
  if (!result.success) {
    throw new BriefstackError('library.invalidProjectStatus', { file, issues: statusIssues(result.error) });
  }
  return result.data;
}

/**
 * Adds content from a markdown file to a note. Everything is checked before
 * anything is written: a secret, an invalid name or an invalid project
 * status leaves the library untouched.
 *
 * - The `--from` file's frontmatter is not copied. `summary` (any section)
 *   sets the note's line in the index; for `projects`, `target`, `path`,
 *   `status`, `profile` and `summary` set the status block.
 * - An existing note gets the body appended after a blank line; a new note
 *   is created with it.
 */
export async function addNote(options: AddNoteOptions): Promise<AddNoteResult> {
  const { libraryDir } = options;
  const ref = noteRef(options.section, options.name);
  await assertLibrary(libraryDir);
  const now = options.now ?? new Date();

  const source = await readTextIfExists(options.fromFile);
  if (source === undefined) throw new BriefstackError('library.fileNotFound', { file: options.fromFile });
  const leaked = secretLines(source);
  if (leaked.length > 0) throw new BriefstackError('library.secretContent', { file: options.fromFile, lines: leaked });
  const { data, body: rawBody } = parseFrontmatter(source, options.fromFile);
  const body = rawBody.replace(/^\s*\n/, '');
  if (body.trim() === '' && ref.section !== 'projects') {
    throw new BriefstackError('library.emptyContent', { file: options.fromFile });
  }

  const relative = noteRelativePath(ref.section, ref.name);
  const file = toNative(libraryDir, relative);
  const existing = await readTextIfExists(file);
  const givenSummary = stringField(data, 'summary');

  let next: string;
  let status: ProjectStatus | undefined;
  if (ref.section === 'projects') {
    let previous: ProjectStatus | undefined;
    if (existing !== undefined) {
      const read = readProjectStatus(existing, relative);
      if (read.ok) previous = read.status;
    }
    status = projectStatusFor(data, previous, ref.name ?? '', body, now, options.fromFile);
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

  const changed: string[] = [];
  let indexUpdated = false;
  if (next !== existing) {
    await writeAtomic(file, next);
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
  } else if (ref.section !== 'lessons' || givenSummary !== undefined) {
    const indexFile = toNative(libraryDir, INDEX_FILE);
    const current = (await readTextIfExists(indexFile)) ?? '';
    const update = upsertIndexEntry(current, INDEX_HEADINGS[ref.section], noteLink(ref.section, ref.name), summary);
    if (update.changed) {
      await writeAtomic(indexFile, update.text);
      changed.push(INDEX_FILE);
      indexUpdated = true;
    }
  }

  const action = existing === undefined ? 'created' : 'appended';
  const commit = await gitCommit(libraryDir, changed, `library: ${action === 'created' ? 'add' : 'update'} ${noteLink(ref.section, ref.name)}`);
  return {
    section: ref.section,
    name: ref.name,
    file: relative,
    action,
    indexUpdated,
    committed: commit.committed,
    ...(status !== undefined ? { status } : {}),
    warnings: commit.warning !== undefined ? [commit.warning] : [],
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
