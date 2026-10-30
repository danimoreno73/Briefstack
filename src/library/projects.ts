import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { isBriefstackError } from '../errors.js';
import { isSessionId } from '../events/index.js';
import { parseFrontmatter } from '../frontmatter/index.js';
import { gitFirstAddedDate } from './git.js';
import { noteRelativePath, toNative } from './layout.js';
import { readTextIfExists } from './notes.js';
import { readProjectStatus, type ProjectStatus } from './projectStatus.js';

/** One project note in `projects/`, as the project list shows it. */
export interface ProjectListing {
  slug: string;
  /** Relative path with `/`. */
  file: string;
  /** The note's first `# ` heading, else the slug. */
  name: string;
  /** YYYY-MM-DD: the status block's `created`, else the date of the note's first library commit. */
  created?: string;
  /** The creation session, which links the project to its timeline. */
  session?: string;
  /** The parsed status block; absent when it is invalid. */
  status?: ProjectStatus;
  /** What is wrong with the status block; absent when it is valid. */
  issues?: string[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function firstHeading(body: string): string | undefined {
  const match = /^# +(.+?)\s*#*\s*$/m.exec(body);
  const heading = match?.[1]?.trim();
  return heading === undefined || heading === '' ? undefined : heading;
}

function dateText(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === 'string' && ISO_DATE_RE.test(value) ? value : undefined;
}

/** The names of the notes in `projects/`, sorted; none without the folder. */
export async function projectSlugs(libraryDir: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(libraryDir, 'projects'), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.slice(0, -'.md'.length))
      .sort();
  } catch {
    return [];
  }
}

async function readListing(libraryDir: string, slug: string): Promise<ProjectListing | undefined> {
  const file = noteRelativePath('projects', slug);
  const text = await readTextIfExists(toNative(libraryDir, file));
  if (text === undefined) return undefined;

  let data: Record<string, unknown> = {};
  let body = text;
  const listing: ProjectListing = { slug, file, name: slug };
  try {
    ({ data, body } = parseFrontmatter(text, file));
    const read = readProjectStatus(text, file);
    if (read.ok) listing.status = read.status;
    else listing.issues = read.issues;
  } catch (error) {
    if (!isBriefstackError(error)) throw error;
    listing.issues = [`frontmatter: ${error.code}`];
  }

  listing.name = firstHeading(body) ?? slug;
  const session = listing.status?.session ?? data.session;
  if (typeof session === 'string' && isSessionId(session)) listing.session = session;
  const created = listing.status?.created ?? dateText(data.created) ?? (await gitFirstAddedDate(libraryDir, file));
  if (created !== undefined) listing.created = created;
  return listing;
}

/**
 * Every project note with its name, creation date, session and status.
 * A note with an invalid status block is listed with its issues instead of
 * failing the whole list. Newest first, then by slug; notes without a date
 * go last. A missing library or `projects/` folder lists nothing.
 */
export async function listProjects(libraryDir: string): Promise<ProjectListing[]> {
  const listings: ProjectListing[] = [];
  for (const slug of await projectSlugs(libraryDir)) {
    const listing = await readListing(libraryDir, slug);
    if (listing !== undefined) listings.push(listing);
  }
  return listings.sort((a, b) => {
    if (a.created !== b.created) {
      if (a.created === undefined) return 1;
      if (b.created === undefined) return -1;
      return a.created < b.created ? 1 : -1;
    }
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
}
