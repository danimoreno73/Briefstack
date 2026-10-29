import { maxActiveCreationsOf, type PathEnv } from '../config/index.js';
import type { Lang } from '../i18n/index.js';
import { PACKAGE_ROOT } from '../packageRoot.js';
import { loadUsageContext, resolveActiveProfile } from '../usage/index.js';
import { afterRoundWith } from './afterRound.js';
import { TaskManager, type AfterRoundResult, type TaskManagerOptions } from './manager.js';
import type { TaskRunner } from './runner.js';
import { TaskSdkRunner } from './sdkRunner.js';
import { TaskStore, tasksRoot } from './store.js';
import type { TaskRecord } from './types.js';

export interface WebTaskOptions {
  pathEnv: PathEnv;
  repoDir?: string | undefined;
  lang: Lang;
  /** The real runner by default; tests pass the fake one. */
  runner?: TaskRunner | undefined;
  /** The creations side of the shared limit and of the folder rule. */
  creations?: TaskManagerOptions['creations'];
  /** What runs after each round (M5: the declared checks and the validations). */
  afterRound?: (task: TaskRecord, worktree: string) => Promise<AfterRoundResult>;
}

/** The active usage profile's name and `work` entry, read when a task starts. */
export async function activeWorkProfile(pathEnv: PathEnv): Promise<{ name: string; model: string; effort: TaskRecord['effort'] }> {
  const { config, profiles } = await loadUsageContext(pathEnv);
  const { name, preset } = resolveActiveProfile(config, profiles);
  return { name, model: preset.work.model, effort: preset.work.effort };
}

/**
 * The task manager `briefstack web` gives the server: the real SDK runner
 * unless one is passed, tasks under `<home>/tasks`, sessions in the user's
 * sessions folder, the profile, the language and the limit read from the
 * config when each task starts.
 */
export async function createWebTasks(options: WebTaskOptions): Promise<TaskManager> {
  const { pathEnv } = options;
  const repoDir = options.repoDir ?? PACKAGE_ROOT;
  const read = () => loadUsageContext(pathEnv);
  const { paths } = await read();
  const runner = options.runner ?? new TaskSdkRunner({ pathEnv, lang: options.lang });
  const afterRound = options.afterRound ?? afterRoundWith({ libraryDir: async () => (await read()).paths.libraryDir, home: paths.home });
  return new TaskManager({
    runner,
    store: new TaskStore(tasksRoot(paths.home)),
    sessionsDir: paths.sessionsDir,
    locations: async () => ({ libraryDir: (await read()).paths.libraryDir, repoDir }),
    lang: async () => (await read()).config.lang ?? options.lang,
    profile: () => activeWorkProfile(pathEnv),
    maxActive: async () => maxActiveCreationsOf((await read()).config),
    pathEnv,
    ...(options.creations === undefined ? {} : { creations: options.creations }),
    afterRound,
  });
}
