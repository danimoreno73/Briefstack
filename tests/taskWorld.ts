import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { writeProjectNote, type ProjectStatus } from '../src/library/projectStatus.js';
import { TaskStore, tasksRoot } from '../src/tasks/store.js';
import { tempDir, writeTree } from './helpers.js';

const run = promisify(execFile);

/** Runs git in a folder for a test: plain git, the hermetic config of `useHermeticGit`. */
export const gitIn = async (cwd: string, ...args: string[]): Promise<string> => (await run('git', args, { cwd, windowsHide: true })).stdout;

export async function commitAll(cwd: string, message: string): Promise<string> {
  await gitIn(cwd, 'add', '-A');
  await gitIn(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '--no-verify', '-m', message);
  return (await gitIn(cwd, 'rev-parse', 'HEAD')).trim();
}

export interface TaskWorld {
  dir: string;
  home: string;
  library: string;
  repo: string;
  sessions: string;
  projects: string;
  store: TaskStore;
  cleanup(): Promise<void>;
  /** A claude-code project made by briefstack, registered in the library, a git repository with one commit on `main`. */
  project(slug: string, files?: Record<string, string>, status?: Partial<ProjectStatus>): Promise<string>;
}

/** A temp home, library, sessions and projects folder for task tests. Nothing of the user's is read or written. */
export async function taskWorld(prefix = 'tasks'): Promise<TaskWorld> {
  const { dir, cleanup } = await tempDir(prefix);
  const home = path.join(dir, 'home');
  const library = path.join(dir, 'library');
  const projects = path.join(dir, 'projects');
  const world: TaskWorld = {
    dir,
    home,
    library,
    repo: path.join(dir, 'repo'),
    sessions: path.join(home, 'sessions'),
    projects,
    store: new TaskStore(tasksRoot(home)),
    cleanup,
    async project(slug, files = {}, status = {}) {
      const folder = path.join(projects, slug);
      await writeTree(folder, { 'CLAUDE.md': `# ${slug}\n`, '.briefstack/profile.json': '{}\n', '.gitignore': 'node_modules/\n', ...files });
      await gitIn(folder, 'init', '--quiet', '-b', 'main');
      await gitIn(folder, 'config', 'core.autocrlf', 'false');
      await commitAll(folder, 'Prepare the project with briefstack');
      const note: ProjectStatus = {
        statusFormat: 1,
        slug,
        target: 'claude-code',
        path: folder,
        status: 'created',
        profile: 'balanced',
        updated: '2026-10-29',
        summary: `The ${slug} project.`,
        ...status,
      };
      await writeTree(library, { [`projects/${slug}.md`]: writeProjectNote(note, `# ${slug} project\n\nText.\n`) });
      return folder;
    },
  };
  return world;
}
