import { rename, writeFile } from 'node:fs/promises';
import { rewritePathPrefix, type PathEnv } from '../config/paths.js';
import { parseFrontmatter, setFrontmatterFields } from '../frontmatter/index.js';
import { gitCommit, type GitWarning } from './git.js';
import { noteRelativePath, toNative } from './layout.js';
import { withLibraryLock } from './lock.js';
import { assertLibrary, readTextIfExists } from './notes.js';
import { projectSlugs } from './projects.js';

export interface NotePathChange {
  /** The note, relative to the library, with `/`. */
  file: string;
  before: string;
  after: string;
}

export interface NotePathsResult {
  changes: NotePathChange[];
  committed: boolean;
  warnings: GitWarning[];
}

/**
 * Points the `path` of every project note that lies in `from` to the same
 * place in `to`, after the user moved that folder: the path is where tasks
 * and skill installs go, and nothing else may change it (`assertProjectPathKept`).
 * Without `apply` it only reports. With it, the notes are written and
 * committed together, one commit, under the library's lock. Nothing else in
 * a note changes; a note whose frontmatter does not read is left alone.
 */
export async function rewriteProjectNotePaths(options: {
  libraryDir: string;
  from: string;
  to: string;
  pathEnv: Pick<PathEnv, 'homedir' | 'pathApi' | 'caseInsensitive'>;
  apply: boolean;
}): Promise<NotePathsResult> {
  const { libraryDir, from, to, pathEnv } = options;
  await assertLibrary(libraryDir);
  return withLibraryLock(libraryDir, async () => {
    const changes: (NotePathChange & { text: string })[] = [];
    for (const slug of await projectSlugs(libraryDir)) {
      const file = noteRelativePath('projects', slug);
      const text = await readTextIfExists(toNative(libraryDir, file));
      if (text === undefined) continue;
      let value: unknown;
      try {
        value = parseFrontmatter(text, file).data.path;
      } catch {
        continue;
      }
      if (typeof value !== 'string') continue;
      const after = rewritePathPrefix(value.trim(), from, to, pathEnv);
      if (after === undefined) continue;
      changes.push({ file, before: value, after, text: setFrontmatterFields(text, { path: after }, file) });
    }
    const report = changes.map(({ file, before, after }) => ({ file, before, after }));
    if (!options.apply || changes.length === 0) return { changes: report, committed: false, warnings: [] };
    for (const change of changes) {
      const target = toNative(libraryDir, change.file);
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, change.text, 'utf8');
      await rename(temp, target);
    }
    const files = changes.map((change) => change.file);
    const commit = await gitCommit(libraryDir, files, `library: project paths moved to their new folder (${files.length})`);
    return { changes: report, committed: commit.committed, warnings: commit.warning === undefined ? [] : [commit.warning] };
  });
}
