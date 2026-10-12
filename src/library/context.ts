import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { BriefstackError } from '../errors.js';
import { readTextIfExists } from './notes.js';
import { INDEX_FILE, LESSONS_FILE, toNative } from './layout.js';

/**
 * Gap-analysis input for the interviewer (PLAN "Learning"): the index, every
 * profile note, the lessons, and the project notes most similar to the idea
 * with the session logs they link to ([[log/...]]), which hold the questions
 * asked and the answers given. Deterministic: same library and idea, same output.
 *
 * Similarity: both texts are lower-cased and split into keywords (runs of
 * Unicode letters and digits, at least 3 characters, minus a short English
 * and Spanish stop-word list). A project note's score is the number of
 * distinct keywords it shares with the idea. Notes scoring 0 are left out;
 * the rest are sorted by score, highest first, ties broken by file name in
 * code-point order, and the first `limit` are kept.
 */

export const DEFAULT_SIMILAR_LIMIT = 3;

const STOP_WORDS = new Set(
  (
    'the and for with that this from into your you are was were will can not but all any its our out ' +
    'about have has had what when where which who how why want would should could also just like make ' +
    'using use some more most very them they their there then than been being each other over under ' +
    'los las del con por para una uno unos unas que como pero más este esta estos estas ese esa eso ' +
    'hay muy sin sobre entre cuando donde quiero quiere hacer tener tiene son ser fue era sus mis tus ' +
    'nos les todo toda todos todas cada otro otra'
  ).split(' '),
);

/** Distinct keywords of a text, in first-seen order. */
export function keywords(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0];
    if (word.length >= 3 && !STOP_WORDS.has(word)) seen.add(word);
  }
  return [...seen];
}

export interface ContextNote {
  /** Relative path with `/`. */
  file: string;
  text: string;
}

export interface SimilarProject extends ContextNote {
  score: number;
  /** Shared keywords, sorted. */
  shared: string[];
  /** Session logs the note links to, in link order; missing ones are skipped. */
  logs: ContextNote[];
}

export interface LibraryContext {
  libraryDir: string;
  /** `false` when the library folder or its `INDEX.md` does not exist. */
  exists: boolean;
  index: string | undefined;
  profile: ContextNote[];
  lessons: string | undefined;
  similarProjects: SimilarProject[];
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `.md` files under `dir`, relative with `/`, sorted in code-point order. */
async function markdownFiles(root: string, relative: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(toNative(root, relative), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory() && !entry.name.startsWith('.')) files.push(...(await markdownFiles(root, child)));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(child);
  }
  return files.sort(byCodePoint);
}

/** Ranks project notes against the idea; pure. */
export function rankProjects(idea: string, notes: readonly ContextNote[], limit: number): SimilarProject[] {
  const wanted = new Set(keywords(idea));
  return notes
    .map((note) => {
      const shared = keywords(note.text).filter((word) => wanted.has(word)).sort(byCodePoint);
      return { ...note, score: shared.length, shared, logs: [] as ContextNote[] };
    })
    .filter((note) => note.score > 0)
    .sort((a, b) => b.score - a.score || byCodePoint(a.file, b.file))
    .slice(0, Math.max(0, limit));
}

export interface ContextOptions {
  libraryDir: string;
  /** Markdown or text file with the idea. */
  ideaFile: string;
  limit?: number;
}

export async function buildLibraryContext(options: ContextOptions): Promise<LibraryContext> {
  const { libraryDir } = options;
  const idea = await readTextIfExists(options.ideaFile);
  if (idea === undefined) throw new BriefstackError('library.fileNotFound', { file: options.ideaFile });

  const index = await readTextIfExists(path.join(libraryDir, INDEX_FILE));
  if (index === undefined) {
    return { libraryDir, exists: false, index: undefined, profile: [], lessons: undefined, similarProjects: [] };
  }
  const read = async (file: string): Promise<ContextNote> => ({
    file,
    text: (await readTextIfExists(toNative(libraryDir, file))) ?? '',
  });
  const profile = await Promise.all((await markdownFiles(libraryDir, 'profile')).map(read));
  const projects = await Promise.all((await markdownFiles(libraryDir, 'projects')).map(read));
  return {
    libraryDir,
    exists: true,
    index,
    profile,
    lessons: await readTextIfExists(path.join(libraryDir, LESSONS_FILE)),
    similarProjects: await Promise.all(
      rankProjects(idea, projects, options.limit ?? DEFAULT_SIMILAR_LIMIT).map(async (project) => ({
        ...project,
        logs: await linkedLogs(libraryDir, project.text),
      })),
    ),
  };
}

/** `[[log/<name>]]` targets in a note, distinct, in order; not `log/INDEX`. */
export function logLinks(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\[\[log\/([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    const name = (match[1] ?? '').trim();
    if (name !== '' && name !== 'INDEX' && !name.includes('/') && !name.includes('\\') && !name.startsWith('.')) {
      names.add(name);
    }
  }
  return [...names];
}

async function linkedLogs(libraryDir: string, text: string): Promise<ContextNote[]> {
  const logs: ContextNote[] = [];
  for (const name of logLinks(text)) {
    const file = `log/${name}.md`;
    const content = await readTextIfExists(toNative(libraryDir, file));
    if (content !== undefined) logs.push({ file, text: content });
  }
  return logs;
}
