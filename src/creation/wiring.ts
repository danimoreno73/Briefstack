import { buildUsageReader, decideUsage, type UsageReading } from '../builds/usage.js';
import { implementBoundsOf, maxActiveCreationsOf, permissionPolicyOf, usageWarningOf, type PathEnv } from '../config/index.js';
import type { CodexSession } from '../codex/tool.js';
import type { UsageGate } from './implement.js';
import type { Lang } from '../i18n/index.js';
import { PACKAGE_ROOT } from '../packageRoot.js';
import { loadUsageContext, resolveActiveProfile } from '../usage/index.js';
import { CreationManager, type SkillCatalogue } from './manager.js';
import { realImplementSystem, type ImplementSystem } from './implementSystem.js';
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
  /** The skill library, for the spec approval screen. */
  skills?: SkillCatalogue | undefined;
  /** Other sessions counted in the same limit (running tasks). */
  otherActive?: (() => readonly string[]) | undefined;
  /** Whether the spec page offers the Codex checkbox now (phase 10). */
  codexForCreations?: (() => Promise<boolean>) | undefined;
  /** The implement step's system (phase 10); the real one by default. */
  implement?: ImplementSystem | undefined;
  /** Codex without its shell for the implement step (phase 10, M4). */
  implementCodex?: (() => Promise<Omit<CodexSession, 'outDir'> | undefined>) | undefined;
}

/**
 * The implement step's usage gate (phase 10): builds' reading and decision
 * (`decideUsage`), against the user's thresholds. A login without plan
 * limits starts; a failed reading does not (a creation has no pause).
 */
export function implementUsageGate(deps: { read: () => Promise<UsageReading>; thresholds: () => Promise<{ fiveHour: number; week: number }>; now?: () => Date }): () => Promise<UsageGate> {
  return async () => {
    const reading = await deps.read();
    const decision = decideUsage(reading, await deps.thresholds(), (deps.now ?? (() => new Date()))());
    if (decision.go) return { go: true };
    return { go: false, reason: decision.reason, ...(decision.fiveHour === undefined ? {} : { fiveHour: decision.fiveHour }), ...(decision.sevenDay === undefined ? {} : { sevenDay: decision.sevenDay }) };
  };
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
    maxActive: async () => maxActiveCreationsOf((await read()).config),
    profile: () => activeRunnerProfile(pathEnv),
    ...(options.skills === undefined ? {} : { skills: options.skills }),
    ...(options.otherActive === undefined ? {} : { otherActive: options.otherActive }),
    ...(options.codexForCreations === undefined ? {} : { codexForCreations: options.codexForCreations }),
    // Phase 10: the implement step's system; with it the spec page offers code for a software spec.
    implement: options.implement ?? realImplementSystem(),
    implementBounds: async () => implementBoundsOf((await read()).config),
    ...(options.implementCodex === undefined ? {} : { implementCodex: options.implementCodex }),
    // The plan reading before the step, against the user's warning thresholds (decisions.md, "Decisiones sin Dani (fase 10)").
    // Only with the real runner, as the creation's own readings: the fake one has no plan to read.
    ...(options.runner === undefined ? { implementUsage: implementUsageGate({ read: buildUsageReader({ pathEnv, repoDir }), thresholds: async () => usageWarningOf((await read()).config) }) } : {}),
    // Only with the real runner: the fake one has no plan to read.
    ...(options.runner === undefined ? { planUsage: planUsageReader({ pathEnv, repoDir }) } : {}),
  });
}
