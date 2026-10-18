import path from 'node:path';
import { resolveHome, type PathEnv } from '../config/index.js';
import type { CreationManager } from '../creation/manager.js';
import { listSessions } from '../events/sessions.js';
import { PACKAGE_ROOT } from '../packageRoot.js';
import { loadUsageContext, resolveActiveProfile } from '../usage/index.js';
import { ImprovementManager } from './manager.js';
import { ScriptRealCheckRunner, type RealCheckRunner } from './realCheck.js';
import { SdkImprovementRunner } from './sdkRunner.js';
import { ImproveStore } from './store.js';
import type { ImprovementRunner } from './types.js';
import { NpmVerifier, type Verifier } from './verify.js';

export interface WebImproveOptions {
  pathEnv: PathEnv;
  repoDir?: string | undefined;
  creations?: CreationManager | undefined;
  /** The real runners unless tests pass fakes. */
  runner?: ImprovementRunner | undefined;
  verifier?: Verifier | undefined;
  realChecks?: RealCheckRunner | undefined;
  /** Turns a creation ended in text, by session id. */
  textTurns?: ((sessionId: string) => number | undefined) | undefined;
  suggestion?: ((id: string) => Promise<{ id: string; text: string; signals?: unknown } | undefined>) | undefined;
  gatePollMs?: number;
}

/**
 * What blocks applying: this server's active creations, and creation
 * sessions on disk that look in progress (started from the terminal, or by
 * another server), which the server would not see otherwise.
 */
export async function creationBlockers(creations: CreationManager | undefined, sessionsDir: string): Promise<string[]> {
  const mine = (creations?.list() ?? []).filter((creation) => creation.status !== 'finished');
  const known = new Set(mine.flatMap((creation) => (creation.sessionId === undefined ? [] : [creation.sessionId])));
  const onDisk = (await listSessions(sessionsDir)).filter((session) => session.status === 'in-progress' && !known.has(session.id));
  return [...mine.map((creation) => creation.idea.slice(0, 80)), ...onDisk.map((session) => `session ${session.id}`)];
}

/** The improvement manager `briefstack web` gives the server. */
export async function createWebImprovements(options: WebImproveOptions): Promise<ImprovementManager> {
  const { pathEnv } = options;
  const repoDir = options.repoDir ?? PACKAGE_ROOT;
  const home = resolveHome(pathEnv);
  const locations = async () => {
    const { paths } = await loadUsageContext(pathEnv);
    return { home, libraryDir: paths.libraryDir, projectsDir: paths.projectsDir, sessionsDir: paths.sessionsDir };
  };
  return ImprovementManager.open({
    store: new ImproveStore(path.join(home, 'improve')),
    repoDir,
    runner: options.runner ?? new SdkImprovementRunner({ pathEnv }),
    verifier: options.verifier ?? new NpmVerifier(repoDir),
    realChecks: options.realChecks ?? new ScriptRealCheckRunner(repoDir),
    pathEnv,
    locations,
    // The active profile's session model and effort, like a creation's main session.
    profile: async () => {
      const { config, profiles } = await loadUsageContext(pathEnv);
      const { preset } = resolveActiveProfile(config, profiles);
      return { model: preset.sessionModel, effort: preset.effort };
    },
    blockers: async () => creationBlockers(options.creations, (await locations()).sessionsDir),
    ...(options.textTurns === undefined ? {} : { textTurns: options.textTurns }),
    ...(options.suggestion === undefined ? {} : { suggestion: options.suggestion }),
    ...(options.gatePollMs === undefined ? {} : { gatePollMs: options.gatePollMs }),
  });
}
