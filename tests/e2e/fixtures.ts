import { test as base } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeRunner, parseRecording } from '../../src/creation/fakeRunner.js';
import { FakeChatRunner, type ChatScript } from '../../src/chat/fakeChatRunner.js';
import { ChatManager } from '../../src/chat/manager.js';
import { ChatStore } from '../../src/chat/store.js';
import { activeChatProfile } from '../../src/chat/wiring.js';
import { CreationManager } from '../../src/creation/manager.js';
import type { PermissionPolicy } from '../../src/creation/types.js';
import { maxActiveCreationsOf, readConfig, updateConfig } from '../../src/config/index.js';
import type { PathEnv } from '../../src/config/index.js';
import { appendEvent, flowEvent, sessionEndEvent, sessionLifecycleEvent } from '../../src/events/index.js';
import { addNote, initLibrary, saveNote } from '../../src/library/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import { startWebServer, type WebServer } from '../../src/server/index.js';
import { isolateEnvironment } from '../sandboxEnv.js';

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
  chatRunner: FakeChatRunner;
  pathEnv: PathEnv;
  dir: string;
  home: string;
  libraryDir: string;
  projectsDir: string;
  sessionsDir: string;
  repoDir: string;
  /** Where the seeded `claude-app` project lives (the name has a space on purpose). */
  gardenDir: string;
}

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

  await cp(path.join(PACKAGE_ROOT, '.claude', 'agents'), path.join(repoDir, '.claude', 'agents'), { recursive: true });
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

  const manager = new CreationManager({
    runner:
      options.recordingText === undefined
        ? await FakeRunner.fromFile(path.join(RECORDINGS, options.recording ?? 'full.jsonl'), { libraryDir, projectsDir })
        : new FakeRunner({ steps: parseRecording(options.recordingText), libraryDir, projectsDir }),
    sessionsDir,
    policy: () => options.policy ?? 'ask',
    // As in `briefstack web`: the limit is read from the config at each start.
    maxActive: async () => maxActiveCreationsOf(await readConfig(path.join(home, 'config.json'))),
    profile: () => ({ name: 'balanced', sessionModel: 'opus', effort: 'medium' }),
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
  const chat = await openChat(pathEnv, repoDir, manager, chatRunner);
  const server = await startWebServer({ port: 0, pathEnv, repoDir, creations: manager, chat });

  const app: App = { url: server.url, server, manager, chat, chatRunner, pathEnv, dir, home, libraryDir, projectsDir, sessionsDir, repoDir, gardenDir };
  const stop = async () => {
    await app.chat.shutdown();
    await manager.shutdown();
    await app.server.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { app, stop };
}

async function openChat(pathEnv: PathEnv, repoDir: string, creations: CreationManager, runner: FakeChatRunner): Promise<ChatManager> {
  return ChatManager.open({
    store: new ChatStore(path.join(pathEnv.env.BRIEFSTACK_HOME ?? '', 'chat')),
    runner,
    tools: { pathEnv, repoDir, lang: 'en', creations, planUsage: async () => ({ fiveHour: 21, sevenDay: 34 }) },
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
  app.chat = await openChat(app.pathEnv, app.repoDir, app.manager, app.chatRunner);
  app.server = await startWebServer({ port: 0, pathEnv: app.pathEnv, repoDir: app.repoDir, creations: app.manager, chat: app.chat });
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
 * What the skill's learn step does at the end of a creation: the project note
 * in the library, linked to the creation's session. The fake runner writes no
 * library, so a test calls this before the creation ends.
 */
export async function recordProject(app: App, slug: string, name: string, session: string): Promise<string> {
  const projectDir = path.join(app.projectsDir, slug);
  await mkdir(projectDir, { recursive: true });
  const file = path.join(app.dir, `${slug}.note.md`);
  const text = [
    '---',
    'target: claude-code',
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
