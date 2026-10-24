import { rename, writeFile } from 'node:fs/promises';
import { BriefstackError } from '../errors.js';
import { removeFrontmatterField, setFrontmatterFields } from '../frontmatter/index.js';
import { gitCommit, type GitWarning } from './git.js';
import { noteRelativePath, toNative } from './layout.js';
import { withLibraryLock } from './lock.js';
import { assertLibrary, noteRef, readTextIfExists } from './notes.js';
import { readProjectStatus } from './projectStatus.js';

/**
 * Archives or unarchives a project (BRIEF-phase-6 §3.6): `archived: <date>`
 * in its note's status block, or the line removed. Nothing else changes
 * and nothing is deleted; one commit of the note.
 */
export async function setProjectArchived(options: {
  libraryDir: string;
  slug: string;
  archived: boolean;
  now?: Date;
}): Promise<{ archived: string | null; committed: boolean; warnings: GitWarning[] }> {
  const { libraryDir, slug } = options;
  const ref = noteRef('projects', slug);
  await assertLibrary(libraryDir);
  const relative = noteRelativePath(ref.section, ref.name);
  return withLibraryLock(libraryDir, async () => {
    const file = toNative(libraryDir, relative);
    const text = await readTextIfExists(file);
    if (text === undefined) throw new BriefstackError('library.noteNotFound', { section: 'projects', name: slug });
    const read = readProjectStatus(text, relative);
    if (!read.ok) throw new BriefstackError('library.invalidProjectStatus', { file: relative, issues: read.issues });
    const current = read.status.archived ?? null;
    if (options.archived === (current !== null)) return { archived: current, committed: false, warnings: [] };
    const date = (options.now ?? new Date()).toISOString().slice(0, 10);
    const next = options.archived ? setFrontmatterFields(text, { archived: date }, relative) : removeFrontmatterField(text, 'archived', relative);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, next, 'utf8');
    await rename(temp, file);
    const commit = await gitCommit(libraryDir, [relative], `library: ${options.archived ? 'archive' : 'unarchive'} projects/${slug}`);
    return { archived: options.archived ? date : null, committed: commit.committed, warnings: commit.warning === undefined ? [] : [commit.warning] };
  });
}
