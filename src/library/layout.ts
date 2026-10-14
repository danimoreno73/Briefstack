import path from 'node:path';

/**
 * Layout of the personal library (BRIEF-phase-1 §3.4). Plain markdown, usable as an
 * Obsidian vault. Notes are linked with path wikilinks such as
 * `[[profile/style]]`, so two notes with the same name in different folders
 * never clash.
 */

export const INDEX_FILE = 'INDEX.md';
export const LESSONS_FILE = 'lessons.md';
export const LOG_INDEX_FILE = 'log/INDEX.md';

export const LIBRARY_FOLDERS = ['profile', 'templates', 'skills', 'projects', 'log'] as const;

/** Sections `library add/list/show` work with. */
export const LIBRARY_SECTIONS = ['profile', 'projects', 'log', 'skills', 'lessons'] as const;
export type LibrarySection = (typeof LIBRARY_SECTIONS)[number];

export function isLibrarySection(value: string): value is LibrarySection {
  return (LIBRARY_SECTIONS as readonly string[]).includes(value);
}

/** Headings of `INDEX.md`, in order. Fixed English text: the file is parsed. */
export const INDEX_HEADINGS: Record<LibrarySection, string> = {
  profile: 'Profile',
  projects: 'Projects',
  skills: 'Skills',
  log: 'Log',
  lessons: 'Lessons',
};

export const INDEX_HEADING_ORDER: readonly LibrarySection[] = ['profile', 'projects', 'skills', 'log', 'lessons'];

/** Wikilink target of a note, e.g. `profile/style`, `log/INDEX`, `lessons`. */
export function noteLink(section: LibrarySection, name: string | undefined): string {
  if (section === 'lessons') return 'lessons';
  return `${section}/${name ?? ''}`;
}

/** Relative path with `/` of a note in the library. */
export function noteRelativePath(section: LibrarySection, name: string | undefined): string {
  if (section === 'lessons') return LESSONS_FILE;
  return `${section}/${name ?? ''}.md`;
}

export function toNative(libraryDir: string, relative: string): string {
  return path.join(libraryDir, ...relative.split('/'));
}

export const INDEX_TEMPLATE = `# Library index

Read this file first and open a note only when you need its detail.
One line per note: a link and a one-line summary.

## Profile

## Projects

## Skills

## Log

- [[log/INDEX]] — Creation sessions, newest first.

## Lessons

- [[lessons]] — What was over-asked and what the user corrected.
`;

export const LOG_INDEX_TEMPLATE = `# Creation log

One note per creation session, newest first.

`;

export const LESSONS_TEMPLATE = `# Lessons

What was over-asked during interviews and what the user corrected.
New lessons are appended at the end.
`;
