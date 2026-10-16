import { permissionPolicyOf, type PathEnv } from '../config/index.js';
import type { Lang } from '../i18n/index.js';
import { PACKAGE_ROOT } from '../packageRoot.js';
import { loadUsageContext, resolveActiveProfile } from '../usage/index.js';
import { CreationManager } from './manager.js';
import { planUsageReader } from './planUsage.js';
import { SdkRunner } from './sdkRunner.js';
import type { CreationRunner, RunnerProfile } from './types.js';

export interface WebCreationOptions {
  pathEnv: PathEnv;
  /** The briefstack repo: the working folder of every creation. */
  repoDir?: string | undefined;
  lang?: Lang | undefined;
  /** The real runner by default; tests pass the fake one. */
  runner?: CreationRunner | undefined;
}

/** The session model and effort of the active usage profile, read when a creation starts. */
export async function activeRunnerProfile(pathEnv: PathEnv): Promise<RunnerProfile> {
  const { config, profiles } = await loadUsageContext(pathEnv);
  const { name, preset } = resolveActiveProfile(config, profiles);
  return { name, sessionModel: preset.sessionModel, effort: preset.effort };
}

/**
 * The creation manager `briefstack web` gives the server: the real SDK runner
 * unless one is passed, the profile and the permission policy read from the
 * user's config when each creation starts, and sessions in the user's home.
 */
export async function createWebCreations(options: WebCreationOptions): Promise<CreationManager> {
  const { pathEnv } = options;
  const repoDir = options.repoDir ?? PACKAGE_ROOT;
  const read = async () => {
    const { config, paths } = await loadUsageContext(pathEnv);
    return { config, paths };
  };
  const { paths } = await read();
  const runner =
    options.runner ??
    new SdkRunner({
      repoDir,
      pathEnv,
      ...(options.lang === undefined ? {} : { lang: options.lang }),
      locations: async () => {
        const current = (await read()).paths;
        return { projectsDir: current.projectsDir, libraryDir: current.libraryDir };
      },
    });
  return new CreationManager({
    runner,
    sessionsDir: paths.sessionsDir,
    policy: async () => permissionPolicyOf((await read()).config),
    profile: () => activeRunnerProfile(pathEnv),
    // Only with the real runner: the fake one has no plan to read.
    ...(options.runner === undefined ? { planUsage: planUsageReader({ pathEnv, repoDir }) } : {}),
  });
}
