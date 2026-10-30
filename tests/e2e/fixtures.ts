import { test as base, expect, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeRunner, parseRecording } from '../../src/creation/fakeRunner.js';
import { FakeChatRunner, type ChatScript } from '../../src/chat/fakeChatRunner.js';
import { ChatManager } from '../../src/chat/manager.js';
import { ChatStore } from '../../src/chat/store.js';
import { activeChatProfile } from '../../src/chat/wiring.js';
import type { ClaudeStatus } from '../../src/creation/claudeAccount.js';
import { CreationManager } from '../../src/creation/manager.js';
import type { PermissionPolicy } from '../../src/creation/types.js';
import { maxActiveCreationsOf, readConfig, updateConfig } from '../../src/config/index.js';
import type { PathEnv } from '../../src/config/index.js';
import { appendEvent, flowEvent, sessionEndEvent, sessionLifecycleEvent } from '../../src/events/index.js';
import { addNote, initLibrary, saveNote } from '../../src/library/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { startWebServer, type WebServer } from '../../src/server/index.js';
import { TaskFakeRunner, type TaskFakeScript } from '../../src/tasks/fakeRunner.js';
import type { TaskManager } from '../../src/tasks/manager.js';
import { createWebTasks } from '../../src/tasks/wiring.js';
import { FakeImprovementRunner, type FakeImproveScript } from '../../src/improve/fakeRunner.js';
import type { ImprovementManager } from '../../src/improve/manager.js';
import { FakeRealCheckRunner } from '../../src/improve/realCheck.js';
import { FakeSafetyReviewer } from '../../src/improve/safetyReview.js';
import { FakeVerifier } from '../../src/improve/verify.js';
import { createWebImprovements } from '../../src/improve/wiring.js';
import { makeImproveRepo, testGit } from '../improveWorld.js';
import { FakeSkillReviewer, hasScript } from '../../src/skills/modelReview.js';
import { SkillService } from '../../src/skills/service.js';
import { UsageCheck } from '../../src/usage/warning.js';
import { EXFILTRATOR, HARMLESS, INJECTOR } from '../skillFixtures.js';
import { sampleRepo, startFakeGitHub, type FakeGitHub } from '../skillsWorld.js';
import { isolateEnvironment } from '../sandboxEnv.js';

/**
 * Where Playwright keeps its browsers by default: under the user's home on
 * Linux and macOS. Kept before the sandbox moves the home, or the browser
 * is looked for in the temp home (the first CI run of the suite, phase 6).
 */
function defaultBrowsersPath(): string {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'ms-playwright');
}
process.env.PLAYWRIGHT_BROWSERS_PATH ??= defaultBrowsersPath();

// The server gets explicit paths, but anything read from the environment must not reach real data either.
const removeSandbox = isolateEnvironment();
process.once('exit', removeSandbox);

// Built at run time so no file in the repo holds a secret-looking string.
export const FAKE_KEY = ['sk', 'ant', 'a'.repeat(30)].join('-');

export const SESSION_DONE = 'sess-done';
export const SESSION_CANCELLED = 'sess-cancelled';
export const SESSION_INTERRUPTED = 'sess-interrupted';

const RECORDINGS = path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'recordings');

/** A temp library, projects folder and server, all thrown away after the test. */
export interface App {
  /** The address to open, with the launch token in the fragment. */
  url: string;
  server: WebServer;
  /** The creation manager the server uses, over the fake runner. */
  manager: CreationManager;
  /** The chat the server uses, over the fake chat runner. */
  chat: ChatManager;
  /** Improvements over the fake improvement runner, verifier and real check. */
  improvements: ImprovementManager;
  improveRunner: FakeImprovementRunner;
  realChecks: FakeRealCheckRunner;
  chatRunner: FakeChatRunner;
  /** Tasks in existing projects over the fake task runner (phase 7). */
  tasks: TaskManager;
  taskRunner: TaskFakeRunner;
  pathEnv: PathEnv;
  dir: string;
  home: string;
  libraryDir: string;
  projectsDir: string;
  sessionsDir: string;
  repoDir: string;
  /** Where the seeded `claude-app` project lives (the name has a space on purpose). */
  gardenDir: string;
  /** A local stand-in for GitHub with `acme/skills` (phase 6). */
  gh: FakeGitHub;
  /** The skill library over it, with a fake model review that flags skills with scripts. */
  skills: SkillService;
  usageCheck?: UsageCheck;
  /** What `GET /api/claude` answers: a compatible Claude Code signed in with a plan unless a test sets `claude`. */
  claudeStatus: (refresh: boolean) => Promise<ClaudeStatus>;
}

/** A compatible Claude Code signed in with a Claude plan: the default every test runs with. */
export const SIGNED_IN: ClaudeStatus = { install: { status: 'compatible', installed: '2.1.310', expected: '2.1.286' }, mode: { kind: 'signIn', plan: 'Claude Pro' } };

export interface AppOptions {
  /** Recording the fake runner replays; `full.jsonl` by default. */
  recording?: string;
  /** The recording itself, when a test must build it (for example with a secret in it). Wins over `recording`. */
  recordingText?: string;
  /** The permission policy for unexpected requests; `ask` by default. */
  policy?: PermissionPolicy;
  /** Language saved in the config; English by default. */
  lang?: 'en' | 'es';
  /** Plan usage readings to record (5-hour and 7-day percent), one per reading; none by default. */
  planUsage?: { fiveHour: number | null; sevenDay: number | null }[];
  /** The fake chat's script; no turns by default. */
  chatScript?: ChatScript;
  /** The fake improvement runner's rounds; none by default. */
  improveScript?: FakeImproveScript;
  /** The plan reading behind the start warning (phase 6); none (no warning) by default. */
  usageReading?: { fiveHour: number | null; sevenDay: number | null };
  /** The user's Claude Code as the server reports it; `SIGNED_IN` by default. */
  claude?: ClaudeStatus;
  /** The fake task runner's script; it writes `CHANGES.md` and ends by default. */
  taskScript?: TaskFakeScript;
}

async function emptyGitConfig(dir: string): Promise<void> {
  // No identity, signing or hooks from the developer's machine.
  const empty = path.join(dir, 'gitconfig');
  await writeFile(empty, '', 'utf8');
  process.env.GIT_CONFIG_GLOBAL = empty;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
}

export async function startApp(options: AppOptions = {}): Promise<{ app: App; stop: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'briefstack-e2e-'));
  await emptyGitConfig(dir);
  const homedir = path.join(dir, 'user');
  const home = path.join(homedir, '.briefstack');
  const libraryDir = path.join(home, 'library');
  const sessionsDir = path.join(home, 'sessions');
  const projectsDir = path.join(dir, 'projects');
  const repoDir = path.join(dir, 'repo');
  const gardenDir = path.join(projectsDir, 'garden planner');
  const pathEnv: PathEnv = {
    env: { BRIEFSTACK_HOME: home },
    homedir,
    pathApi: path,
    caseInsensitive: process.platform === 'win32' || process.platform === 'darwin',
  };

  // A git repository with the flow's files, as improvements need (agents, skill, library rules and templates).
  await makeImproveRepo(repoDir);
  await initLibrary({ libraryDir, projectsDir, sessionsDir, repoDir });
  // The UI follows the saved language, so the machine's own locale does not matter.
  await updateConfig(path.join(home, 'config.json'), { lang: options.lang ?? 'en', projectsDir });

  // A user preset, cloned from a base one.
  const base = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'library', 'usage-profiles.json'), 'utf8')) as {
    profiles: Record<string, Record<string, unknown>>;
  };
  const deep = { ...base.profiles.balanced, label: { en: 'Deep dive: my own preset', es: 'Inmersión: mi preset' } };
  await writeFile(path.join(home, 'usage-profiles.json'), JSON.stringify({ profiles: { 'deep-dive': deep } }), 'utf8');

  await mkdir(gardenDir, { recursive: true });
  await writeFile(path.join(gardenDir, 'NEXT_STEPS.md'), '# Next steps\n\n1. Open the Claude app.\n', 'utf8');
  await writeFile(path.join(gardenDir, 'INSTRUCTIONS.md'), '# Instructions\n\nBe brief.\n', 'utf8');
  await mkdir(path.join(gardenDir, '.briefstack'), { recursive: true });
  await writeFile(
    path.join(gardenDir, '.briefstack', 'spec.json'),
    JSON.stringify({ target: 'claude-app', targetChosenBy: 'user', targetReason: 'Mostly conversation about the garden.' }),
    'utf8',
  );
  await mkdir(path.join(dir, 'in'), { recursive: true });
  const noteFile = path.join(dir, 'in', 'garden.md');
  await writeFile(
    noteFile,
    `---\ntarget: claude-app\npath: ${gardenDir.replaceAll('\\', '/')}\nstatus: created\nprofile: balanced\nsummary: A garden planner.\n---\n# Garden planner\n\nText.\n`,
    'utf8',
  );
  await addNote({ libraryDir, section: 'projects', name: 'garden', fromFile: noteFile, session: SESSION_DONE, now: new Date('2026-10-12T10:00:00Z') });
  await saveNote({ libraryDir, section: 'profile', name: 'style', text: '# Style\n\nShort answers.\n' });
  // saveNote refuses a secret, so this note is written straight to disk, as an old library could hold.
  await writeFile(path.join(libraryDir, 'profile', 'legacy.md'), `# Legacy\n\nkey ${FAKE_KEY}\nKeep this line.\n`, 'utf8');

  const at = (time: string) => new Date(`2026-10-12T${time}:00Z`);
  await appendEvent(sessionsDir, sessionLifecycleEvent(SESSION_DONE, 'started', undefined, at('09:00')));
  await appendEvent(sessionsDir, flowEvent(SESSION_DONE, 'interview', 'started', undefined, at('09:01')));
  await appendEvent(sessionsDir, flowEvent(SESSION_DONE, 'interview', 'finished', 'ok', at('09:02')));
  await appendEvent(sessionsDir, sessionLifecycleEvent(SESSION_DONE, 'finished', 'completed', at('09:30')));
  await appendEvent(sessionsDir, sessionLifecycleEvent(SESSION_CANCELLED, 'started', undefined, at('08:00')));
  await appendEvent(sessionsDir, flowEvent(SESSION_CANCELLED, 'interview', 'started', undefined, at('08:01')));
  await appendEvent(sessionsDir, sessionLifecycleEvent(SESSION_CANCELLED, 'finished', 'cancelled', at('08:05')));
  await appendEvent(sessionsDir, sessionLifecycleEvent(SESSION_INTERRUPTED, 'started', undefined, at('07:00')));
  await appendEvent(sessionsDir, flowEvent(SESSION_INTERRUPTED, 'research', 'started', undefined, at('07:03')));
  await appendEvent(sessionsDir, sessionEndEvent(SESSION_INTERRUPTED, 'server_stop', at('07:04')));
  // The cancelled one has the idea the flow writes first; the interrupted one stopped before it.
  await writeFile(path.join(sessionsDir, SESSION_CANCELLED, 'idea.md'), `A reading log for my book club.\napi key ${FAKE_KEY}\n`, 'utf8');

  // Phase 6: a fake GitHub with three skills, the skill library and the plan-usage warning.
  const prefixed = (prefix: string, files: Record<string, unknown>) => Object.fromEntries(Object.entries(files).map(([p, v]) => [`${prefix}/${p}`, v as string]));
  const gh = await startFakeGitHub({
    'acme/skills': sampleRepo({
      ...prefixed('skills/tidy', HARMLESS),
      ...prefixed('skills/sync', EXFILTRATOR),
      ...prefixed('skills/odd', INJECTOR),
      // Longer than the model review takes from one file: the review is partial.
      ...prefixed('skills/long', { 'SKILL.md': `---\nname: long-notes\ndescription: Very long notes.\n---\n\n${'Write short notes. '.repeat(1500)}\n` }),
    }).repo,
  });
  const skills = new SkillService({
    libraryDir: async () => libraryDir,
    fetch: { apiBase: gh.apiBase, rawBase: gh.rawBase },
    reviewer: new FakeSkillReviewer((input) =>
      hasScript(input) ? { harmful: true, reason: 'scripts/sync.sh posts ~/.ssh/id_rsa to another server.' } : { harmful: false, reason: 'Plain instructions, nothing that runs.' },
    ),
  });
  const usageReading = options.usageReading;
  const usageCheck = usageReading === undefined ? undefined : new UsageCheck({ read: async () => usageReading, thresholds: async () => ({ fiveHour: 80, week: 85 }), ttlMs: 0 });

  const holderTasks: { value?: TaskManager } = {};
  const manager = new CreationManager({
    skills,
    runner:
      options.recordingText === undefined
        ? await FakeRunner.fromFile(path.join(RECORDINGS, options.recording ?? 'full.jsonl'), { libraryDir, projectsDir })
        : new FakeRunner({ steps: parseRecording(options.recordingText), libraryDir, projectsDir }),
    sessionsDir,
    policy: () => options.policy ?? 'ask',
    // As in `briefstack web`: the limit is read from the config at each start.
    maxActive: async () => maxActiveCreationsOf(await readConfig(path.join(home, 'config.json'))),
    profile: () => ({ name: 'balanced', sessionModel: 'opus', effort: 'medium' }),
    // Running tasks share the limit, as in `briefstack web`.
    otherActive: () => holderTasks.value?.activeIds() ?? [],
    pollMs: 20,
    tailMs: 20,
    ...(options.planUsage === undefined
      ? {}
      : {
          planUsage: (() => {
            const readings = [...options.planUsage];
            let last = readings[0];
            return async () => (last = readings.shift() ?? last);
          })(),
          usageEveryMs: 300,
        }),
  });
  const chatRunner = new FakeChatRunner(options.chatScript ?? { turns: [] });
  const holder: { app?: App } = {};
  // As in `briefstack web`, the chat reads the task manager when a tool runs: it starts after the chat.
  const chat = await openChat(pathEnv, repoDir, manager, chatRunner, () => holder.app?.improvements, skills, usageCheck, () => holderTasks.value);
  const improveRunner = new FakeImprovementRunner(options.improveScript ?? { rounds: [] });
  // Flags a change that lets an agent ask in plain text, like the real review should.
  const safetyReviewer = new FakeSafetyReviewer((diff) =>
    /^\+.*ask in plain text/im.test(diff) ? { weakens: true, reason: 'It lets an agent ask in plain text, against the rule that answers come only from the forms.' } : { weakens: false, reason: 'Nothing about safety changed.' },
  );
  const realChecks = new FakeRealCheckRunner({ ok: true, output: 'PASS  the interviewer picks the target the rule gives' });
  // The real wiring (suggestion tracker, creation gate) over fake runners.
  const improvements = await createWebImprovements({
    pathEnv,
    repoDir,
    creations: manager,
    runner: improveRunner,
    verifier: new FakeVerifier(),
    realChecks,
    safetyReviewer,
    announce: (suggestions) => holder.app?.chat.announceSuggestions(suggestions),
    gatePollMs: 100,
  });
  const claude = options.claude ?? SIGNED_IN;
  const claudeStatus = async () => claude;
  // Tasks (phase 7) over the fake task runner, with the real wiring (checks, validations, the shared limit).
  const taskRunner = new TaskFakeRunner({ ...(options.taskScript === undefined ? {} : { script: options.taskScript }), stepMs: 30 });
  const tasks = await createWebTasks({ pathEnv, repoDir, lang: 'en', runner: taskRunner, creations: manager });
  holderTasks.value = tasks;
  const server = await startWebServer({ port: 0, pathEnv, repoDir, creations: manager, chat, improvements, skills, tasks, claudeStatus, ...(usageCheck === undefined ? {} : { usageCheck }) });

  const app: App = {
    url: server.url,
    server,
    manager,
    chat,
    chatRunner,
    improvements,
    improveRunner,
    realChecks,
    tasks,
    taskRunner,
    pathEnv,
    dir,
    home,
    libraryDir,
    projectsDir,
    sessionsDir,
    repoDir,
    gardenDir,
    gh,
    skills,
    claudeStatus,
    ...(usageCheck === undefined ? {} : { usageCheck }),
  };
  holder.app = app;
  const stop = async () => {
    await app.improvements.shutdown();
    await app.chat.shutdown();
    await app.tasks.shutdown();
    await manager.shutdown();
    await app.server.close();
    await gh.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { app, stop };
}

async function openChat(
  pathEnv: PathEnv,
  repoDir: string,
  creations: CreationManager,
  runner: FakeChatRunner,
  improvements: () => ImprovementManager | undefined,
  skills?: SkillService,
  usageCheck?: UsageCheck,
  tasks?: () => TaskManager | undefined,
): Promise<ChatManager> {
  return ChatManager.open({
    store: new ChatStore(path.join(pathEnv.env.BRIEFSTACK_HOME ?? '', 'chat')),
    runner,
    tools: { pathEnv, repoDir, lang: 'en', creations, planUsage: async () => ({ fiveHour: 21, sevenDay: 34 }), improvements, skills, usageCheck, tasks },
    profile: () => activeChatProfile(pathEnv),
  });
}

/**
 * A server restart for the chat: the chat and the server stop, and new ones
 * start on the same home with a new chat script. `app` points to the new server.
 */
export async function restartChatServer(app: App, script: ChatScript): Promise<void> {
  await app.chat.shutdown();
  await app.server.close();
  app.chatRunner = new FakeChatRunner(script);
  app.chat = await openChat(app.pathEnv, app.repoDir, app.manager, app.chatRunner, () => app.improvements, app.skills, app.usageCheck, () => app.tasks);
  app.server = await startWebServer({ port: 0, pathEnv: app.pathEnv, repoDir: app.repoDir, creations: app.manager, chat: app.chat, improvements: app.improvements, skills: app.skills, tasks: app.tasks, claudeStatus: app.claudeStatus });
  app.url = app.server.url;
}

/** `app` starts a fresh server and temp folders for every test. */
export const test = base.extend<{ app: App; appOptions: AppOptions }>({
  appOptions: [{}, { option: true }],
  app: async ({ appOptions }, use) => {
    const { app, stop } = await startApp(appOptions);
    try {
      await use(app);
    } finally {
      await stop();
    }
  },
});

export { expect } from '@playwright/test';

/**
 * Follows a link of the main menu. At phone width the menu is behind the top
 * bar's Menu button, as a user meets it.
 */
export async function clickNav(page: Page, name: string | RegExp): Promise<void> {
  const nav = page.locator('nav#rail');
  // The shell first: until the server answers, the page shows the opening screen and neither exists.
  await nav.waitFor({ state: 'attached' });
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  const phone = await menu.isVisible();
  if (phone) await menu.click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: typeof name === 'string' }).click();
  // The move closes the menu again.
  if (phone) await expect(menu).toHaveAttribute('aria-expanded', 'false');
}

/**
 * What the skill's learn step does at the end of a creation: the project note
 * in the library, linked to the creation's session. The fake runner writes no
 * library, so a test calls this before the creation ends.
 */
export async function recordProject(
  app: App,
  slug: string,
  name: string,
  session: string,
  options: { target?: 'claude-code' | 'claude-app'; nextSteps?: string } = {},
): Promise<string> {
  const projectDir = path.join(app.projectsDir, slug);
  await mkdir(projectDir, { recursive: true });
  if (options.nextSteps !== undefined) await writeFile(path.join(projectDir, 'NEXT_STEPS.md'), options.nextSteps, 'utf8');
  const file = path.join(app.dir, `${slug}.note.md`);
  const text = [
    '---',
    `target: ${options.target ?? 'claude-code'}`,
    `path: ${projectDir.replaceAll(String.fromCharCode(92), '/')}`,
    'status: created',
    'profile: balanced',
    `summary: ${name} summary.`,
    '---',
    `# ${name}`,
    '',
    'Text.',
    '',
  ].join(String.fromCharCode(10));
  await writeFile(file, text, 'utf8');
  await addNote({ libraryDir: app.libraryDir, section: 'projects', name: slug, fromFile: file, session, now: new Date('2026-10-15T10:00:00Z') });
  return projectDir;
}

/**
 * A `claude-code` project as briefstack makes one, for tasks (phase 7): the
 * library note, `.briefstack/profile.json`, and a git repository on `main`
 * with one commit of its files.
 */
export async function codeProject(app: App, slug: string, name: string, files: Record<string, string> = {}): Promise<string> {
  const projectDir = await recordProject(app, slug, name, SESSION_DONE);
  const all: Record<string, string> = { 'CLAUDE.md': `# ${name}\n`, '.briefstack/profile.json': '{}\n', '.gitignore': 'node_modules/\n', ...files };
  for (const [file, text] of Object.entries(all)) {
    await mkdir(path.dirname(path.join(projectDir, file)), { recursive: true });
    await writeFile(path.join(projectDir, file), text, 'utf8');
  }
  await testGit(projectDir, ['init', '--quiet', '-b', 'main']);
  await testGit(projectDir, ['config', 'core.autocrlf', 'false']);
  await testGit(projectDir, ['add', '-A']);
  await testGit(projectDir, ['commit', '--quiet', '--no-verify', '-m', 'Prepare the project with briefstack']);
  return projectDir;
}
