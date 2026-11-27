import { buildsSettingsOf, maxActiveCreationsOf, reserveProvidersOf, type PathEnv } from '../config/index.js';
import type { Lang } from '../i18n/index.js';
import { PACKAGE_ROOT } from '../packageRoot.js';
import type { TaskManager } from '../tasks/manager.js';
import { activeWorkProfile } from '../tasks/wiring.js';
import { loadUsageContext } from '../usage/index.js';
import { configThresholds } from '../usage/warning.js';
import { BuildManager } from './manager.js';
import { SdkBuildPlanner, type BuildPlanner } from './planner.js';
import { BuildStore, buildsRoot } from './store.js';
import { buildUsageReader, type UsageReading } from './usage.js';

export interface WebBuildOptions {
  pathEnv: PathEnv;
  repoDir?: string | undefined;
  lang: Lang;
  tasks: TaskManager;
  /** The real planner by default; tests pass the fake one. */
  planner?: BuildPlanner | undefined;
  /** The plan reading before each task; the real one by default, none when `usage` is `null`. */
  usage?: (() => Promise<UsageReading>) | null | undefined;
  /** The creations side of the shared limit and of the folder rule. */
  creations?: { activeIds(): readonly string[]; folderHolder(dir: string): string | undefined | Promise<string | undefined> } | undefined;
}

/** The build manager `briefstack web` gives the server: builds under `<home>/builds`, the task manager it drives, the profile and the limit read at each start. */
export async function createWebBuilds(options: WebBuildOptions): Promise<BuildManager> {
  const { pathEnv } = options;
  const repoDir = options.repoDir ?? PACKAGE_ROOT;
  const read = () => loadUsageContext(pathEnv);
  const { paths } = await read();
  const usage = options.usage === null ? undefined : (options.usage ?? buildUsageReader({ pathEnv, repoDir }));
  return new BuildManager({
    store: new BuildStore(buildsRoot(paths.home)),
    tasks: options.tasks,
    planner: options.planner ?? new SdkBuildPlanner({ pathEnv }),
    locations: async () => ({ libraryDir: (await read()).paths.libraryDir, repoDir }),
    lang: async () => (await read()).config.lang ?? options.lang,
    profile: () => activeWorkProfile(pathEnv),
    thresholds: configThresholds(pathEnv),
    maxActive: async () => maxActiveCreationsOf((await read()).config),
    // Reserve providers (phase 12): read from config.json at each use, so a change there shows at the next threshold.
    providers: async () => reserveProvidersOf((await read()).config),
    // The machine's cap on slots (phase 12), read at each pass.
    slotsCap: async () => buildsSettingsOf((await read()).config).slotsCap,
    pathEnv,
    ...(usage === undefined ? {} : { usage }),
    ...(options.creations === undefined
      ? {}
      : { activeOthers: () => options.creations?.activeIds() ?? [], creationOn: (dir: string) => options.creations?.folderHolder(dir) }),
  });
}
