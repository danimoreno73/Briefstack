import path from 'node:path';
import { resolveHome, type PathEnv } from '../config/index.js';
import type { CreationManager, CreationState } from '../creation/manager.js';
import { listSessions } from '../events/sessions.js';
import { PACKAGE_ROOT } from '../packageRoot.js';
import { loadUsageContext, resolveActiveProfile } from '../usage/index.js';
import { ImprovementManager } from './manager.js';
import { ScriptRealCheckRunner, type RealCheckRunner } from './realCheck.js';
import { SdkSafetyReviewer, type SafetyReviewer } from './safetyReview.js';
import { SuggestionStore, SuggestionTracker, type Suggestion } from './suggestions.js';
import { SdkImprovementRunner } from './sdkRunner.js';
import { ImproveStore } from './store.js';
import { TextTurnStore } from './textTurns.js';
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
  /** The safety review of each round; by default the real one, only with the real runner. */
  safetyReviewer?: SafetyReviewer | undefined;
  /** Where the suggestions after a creation are shown besides the result screen: the chat. */
  announce?: ((suggestions: Suggestion[]) => void) | undefined;
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
  const store = new ImproveStore(path.join(home, 'improve'));
  const suggestions = new SuggestionStore(store.suggestionsFile);
  const textTurnStore = new TextTurnStore(store.textTurnsFile);
  if (options.creations !== undefined) {
    const tracker = new SuggestionTracker({
      store: suggestions,
      locations,
      homedir: pathEnv.homedir,
      ...(options.announce === undefined ? {} : { announce: options.announce }),
    });
    // Kept on disk too, so they outlive a restart of the server; again at the end, in case the session id came late.
    const keepTextTurns = (state: CreationState) => {
      if (state.sessionId !== undefined && state.textTurns !== undefined) void textTurnStore.record(state.sessionId, state.textTurns).catch(() => undefined);
    };
    options.creations.observe({
      started: (state) => tracker.started(state),
      textTurn: keepTextTurns,
      finished: (state) => {
        keepTextTurns(state);
        void tracker.finished(state).catch(() => undefined);
      },
    });
  }
  // The creation manager's count while it knows the creation; the file's after a restart.
  const textTurns = async (sessionId: string) =>
    options.creations?.list().find((creation) => creation.sessionId === sessionId)?.textTurns ?? (await textTurnStore.count(sessionId));
  return ImprovementManager.open({
    store,
    suggestions,
    textTurns,
    repoDir,
    runner: options.runner ?? new SdkImprovementRunner({ pathEnv }),
    verifier: options.verifier ?? new NpmVerifier(repoDir),
    realChecks: options.realChecks ?? new ScriptRealCheckRunner(repoDir),
    // Only with the real runner, like the plan usage of creations: tests with fakes never start a model session.
    ...(options.safetyReviewer !== undefined
      ? { safetyReviewer: options.safetyReviewer }
      : options.runner === undefined
        ? { safetyReviewer: new SdkSafetyReviewer({ pathEnv }) }
        : {}),
    pathEnv,
    locations,
    // The active profile's session model and effort, like a creation's main session.
    profile: async () => {
      const { config, profiles } = await loadUsageContext(pathEnv);
      const { preset } = resolveActiveProfile(config, profiles);
      return { model: preset.sessionModel, effort: preset.effort };
    },
    blockers: async () => creationBlockers(options.creations, (await locations()).sessionsDir),
    ...(options.creations === undefined ? {} : { holdStarts: (task) => (options.creations as CreationManager).holdStarts(task) }),
    ...(options.gatePollMs === undefined ? {} : { gatePollMs: options.gatePollMs }),
  });
}
