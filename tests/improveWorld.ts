import { execFile } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PathEnv } from '../src/config/index.js';
import { FakeImprovementRunner, type FakeImproveScript } from '../src/improve/fakeRunner.js';
import { ImprovementManager } from '../src/improve/manager.js';
import { FakeRealCheckRunner } from '../src/improve/realCheck.js';
import { ImproveStore } from '../src/improve/store.js';
import type { SuggestionStore } from '../src/improve/suggestions.js';
import type { Submission } from '../src/improve/types.js';
import { FakeVerifier } from '../src/improve/verify.js';
import { PACKAGE_ROOT } from '../src/packageRoot.js';

const execFileAsync = promisify(execFile);

/** Runs git in `cwd` with a fixed identity, never the developer's. */
export async function testGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, windowsHide: true });
  return stdout;
}

/**
 * A briefstack repo for improvement tests: a git repository on `master` with
 * the real agent files, skill and library rules and templates, and a
 * `src/cli.ts` an improvement may not touch. Outside `home`.
 */
export async function makeImproveRepo(repoDir: string): Promise<void> {
  for (const folder of ['.claude/agents', '.claude/skills', 'library/rules', 'library/templates']) {
    await cp(path.join(PACKAGE_ROOT, ...folder.split('/')), path.join(repoDir, ...folder.split('/')), { recursive: true });
  }
  await mkdir(path.join(repoDir, 'src'), { recursive: true });
  await writeFile(path.join(repoDir, 'src', 'cli.ts'), 'export {};\n', 'utf8');
  await writeFile(path.join(repoDir, '.gitignore'), 'node_modules/\n', 'utf8');
  await testGit(repoDir, ['init', '--quiet', '-b', 'master']);
  await testGit(repoDir, ['config', 'core.autocrlf', 'false']);
  await testGit(repoDir, ['add', '-A']);
  await testGit(repoDir, ['commit', '--quiet', '-m', 'start']);
}

export const RESEARCHER = '.claude/agents/researcher.md';

/** A round that adds one line to the researcher agent and explains it. */
export function researcherRound(title = 'Shorter research reports'): { edits: { file: string; find: string; replace: string }[]; submission: Submission } {
  return {
    edits: [{ file: RESEARCHER, find: 'Never fill a gap with a guess.', replace: 'Never fill a gap with a guess. Keep the report under one page.' }],
    submission: {
      title,
      expectedEffect: 'Research reports half as long.',
      changes: [{ file: RESEARCHER, rationale: 'The reviewer asked twice for a shorter report.', evidence: ['request.md'] }],
    },
  };
}

export interface ImproveWorld {
  manager: ImprovementManager;
  runner: FakeImprovementRunner;
  verifier: FakeVerifier;
  realChecks: FakeRealCheckRunner;
  /** Set to make approvals wait, as a running creation does. */
  blockers: string[];
}

export async function openImproveWorld(params: {
  repoDir: string;
  home: string;
  pathEnv: PathEnv;
  sessionsDir: string;
  libraryDir: string;
  projectsDir: string;
  script: FakeImproveScript;
  blockers?: () => Promise<string[]>;
  suggestions?: SuggestionStore;
}): Promise<ImproveWorld> {
  const runner = new FakeImprovementRunner(params.script);
  const verifier = new FakeVerifier();
  const realChecks = new FakeRealCheckRunner();
  const world: ImproveWorld = { runner, verifier, realChecks, blockers: [], manager: undefined as unknown as ImprovementManager };
  world.manager = await ImprovementManager.open({
    store: new ImproveStore(path.join(params.home, 'improve')),
    repoDir: params.repoDir,
    runner,
    verifier,
    realChecks,
    pathEnv: params.pathEnv,
    locations: async () => ({ home: params.home, libraryDir: params.libraryDir, projectsDir: params.projectsDir, sessionsDir: params.sessionsDir }),
    profile: async () => ({ model: 'haiku', effort: 'low' }),
    blockers: params.blockers ?? (async () => world.blockers),
    ...(params.suggestions === undefined ? {} : { suggestions: params.suggestions }),
    gatePollMs: 50,
  });
  return world;
}
