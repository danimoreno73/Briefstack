import { mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveLastPlanUsage } from '../../src/creation/planUsage.js';
import { appendEvent, flowEvent, sessionLifecycleEvent } from '../../src/events/index.js';
import { addNote, initLibrary, saveNote } from '../../src/library/index.js';
import { startWebServer, TOKEN_HEADER, type WebServer } from '../../src/server/index.js';
import { redactSecrets } from '../../src/server/read.js';
import { tempDir, useHermeticGit, writeTree } from '../helpers.js';

useHermeticGit();

const SESSION = 'sess-1';
// Built at run time so the test file holds no secret-looking string.
const FAKE_KEY = ['sk', 'ant', 'a'.repeat(30)].join('-');

interface Reply {
  status: number;
  body: string;
}

function get(server: WebServer, urlPath: string, token: string | null = server.token): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: urlPath,
        headers: { host: `127.0.0.1:${server.port}`, ...(token === null ? {} : { [TOKEN_HEADER]: token }) },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('read API', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let server: WebServer;
  let home: string;
  let libraryDir: string;
  let appDir: string;
  const now = new Date('2026-10-12T10:00:00Z');

  const json = async <T>(urlPath: string): Promise<T> => {
    const reply = await get(server, urlPath);
    expect(reply.status, reply.body).toBe(200);
    return JSON.parse(reply.body) as T;
  };

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('web-read'));
    home = path.join(dir, 'home', '.briefstack');
    libraryDir = path.join(home, 'library');
    appDir = path.join(dir, 'projects', 'garden');
    await writeTree(path.join(dir, 'ui'), { 'index.html': '<html><head><!-- importmap --></head></html>' });
    await writeTree(appDir, {
      'NEXT_STEPS.md': '# Next steps\n\n1. Open Claude.\n',
      'INSTRUCTIONS.md': `# Instructions\n\nKey: ${FAKE_KEY}\nBe brief.\n`,
    });
    await initLibrary({
      libraryDir,
      projectsDir: path.join(dir, 'projects'),
      sessionsDir: path.join(home, 'sessions'),
      repoDir: path.join(dir, 'repo'),
    });
    await writeTree(dir, {
      'in/garden.md': `---\ntarget: claude-app\npath: ${appDir.replaceAll('\\', '/')}\nstatus: created\nprofile: balanced\nsummary: A garden planner.\n---\n# Garden planner\n\nText.\n`,
    });
    await addNote({ libraryDir, section: 'projects', name: 'garden', fromFile: path.join(dir, 'in', 'garden.md'), session: SESSION, now });
    await saveNote({ libraryDir, section: 'profile', name: 'style', text: '# Style\n\nShort answers.\n', now });

    const sessions = path.join(home, 'sessions');
    await appendEvent(sessions, sessionLifecycleEvent(SESSION, 'started', undefined, new Date('2026-10-12T09:00:00Z')));
    await appendEvent(sessions, flowEvent(SESSION, 'interview', 'started', undefined, new Date('2026-10-12T09:01:00Z')));
    await appendEvent(sessions, flowEvent(SESSION, 'interview', 'finished', 'ok', new Date('2026-10-12T09:02:00Z')));
    await appendEvent(sessions, sessionLifecycleEvent(SESSION, 'finished', 'completed', new Date('2026-10-12T09:30:00Z')));
    await appendEvent(sessions, sessionLifecycleEvent('sess-2', 'started', undefined, new Date('2026-10-12T08:00:00Z')));
    await appendEvent(sessions, sessionLifecycleEvent('sess-2', 'finished', 'cancelled', new Date('2026-10-12T08:05:00Z')));
    await writeFile(path.join(sessions, 'sess-2', 'idea.md'), `A book log.\nkey ${FAKE_KEY}\n`, 'utf8');

    server = await startWebServer({
      port: 0,
      uiDir: path.join(dir, 'ui'),
      token: 't'.repeat(43),
      lang: 'en',
      pathEnv: {
        env: { BRIEFSTACK_HOME: home },
        homedir: path.join(dir, 'home'),
        pathApi: path,
        caseInsensitive: process.platform === 'win32' || process.platform === 'darwin',
      },
      repoDir: path.join(dir, 'repo'),
    });
  });
  afterEach(async () => {
    await server.close();
    await cleanup();
  });

  it('requires the token on every read route', async () => {
    for (const route of ['projects', 'projects/garden', 'sessions', 'sessions/sess-1', `sessions/${SESSION}/events`, 'library/index', 'library/notes', 'library/note?section=lessons', 'library/history', 'usage', 'paths', 'settings']) {
      expect((await get(server, `/api/${route}`, null)).status, route).toBe(401);
    }
  });

  it('lists projects', async () => {
    const { projects } = await json<{ projects: { slug: string; name: string; session?: string; created?: string; status?: { target: string } }[] }>('/api/projects');
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ slug: 'garden', name: 'Garden planner', session: SESSION, created: '2026-10-12', status: { target: 'claude-app' } });
  });

  it('gives the project detail with timeline and the claude-app files, secrets redacted', async () => {
    const detail = await json<{
      project: { slug: string };
      note: { file: string; text: string };
      timeline: { summary: { status: string; outcome: string }; steps: { step: string; outcome: string }[] } | null;
      nextSteps: string | null;
      instructions: string | null;
      openCommand: { cwd: string; command: string } | null;
    }>('/api/projects/garden');
    expect(detail.project.slug).toBe('garden');
    expect(detail.note.file).toBe('projects/garden.md');
    expect(detail.timeline?.summary).toMatchObject({ status: 'finished', outcome: 'completed' });
    expect(detail.timeline?.steps).toMatchObject([{ step: 'interview', outcome: 'ok' }]);
    expect(detail.nextSteps).toContain('Open Claude.');
    expect(detail.instructions).toContain('Be brief.');
    expect(detail.instructions).not.toContain(FAKE_KEY);
    expect(detail.openCommand).toEqual({ cwd: appDir.replaceAll('\\', '/'), command: 'claude' });
  });

  it('says who chose the target and why, from the project spec, redacted', async () => {
    const choice = async () => (await json<{ targetChoice: unknown }>('/api/projects/garden')).targetChoice;
    // No spec: a project created before the field, or not by briefstack.
    expect(await choice()).toBeNull();
    await writeTree(appDir, { '.briefstack/spec.json': '{ "target": "claude-app" }' });
    expect(await choice()).toBeNull();
    await writeTree(appDir, { '.briefstack/spec.json': 'not json' });
    expect(await choice()).toBeNull();
    await writeTree(appDir, {
      '.briefstack/spec.json': JSON.stringify({ targetChosenBy: 'user', targetReason: 'Chosen by the user.' }),
    });
    expect(await choice()).toEqual({ chosenBy: 'user', reason: 'Chosen by the user.' });
    await writeTree(appDir, {
      '.briefstack/spec.json': JSON.stringify({ targetChosenBy: 'someone', targetReason: `Key ${FAKE_KEY}` }),
    });
    const redacted = (await choice()) as { chosenBy?: string; reason?: string };
    expect(redacted.chosenBy).toBeUndefined();
    expect(redacted.reason).not.toContain(FAKE_KEY);
  });

  it('answers 404 for an unknown project and 400 for a bad slug', async () => {
    const missing = await get(server, '/api/projects/nope');
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body)).toMatchObject({ code: 'library.noteNotFound' });
    expect((await get(server, '/api/projects/..%2Fsecrets')).status).toBe(400);
  });

  it('has no timeline when the project has no session file', async () => {
    await saveNote({
      libraryDir,
      section: 'projects',
      name: 'orphan',
      text: `---\nstatusFormat: 1\nslug: orphan\ntarget: claude-code\npath: ~/p/orphan\nstatus: created\nprofile: balanced\nupdated: 2026-10-12\nsession: gone-1\nsummary: Orphan.\n---\n# Orphan\n`,
      now,
    });
    const detail = await json<{ timeline: unknown; nextSteps: unknown }>('/api/projects/orphan');
    expect(detail.timeline).toBeNull();
    expect(detail.nextSteps).toBeNull();
  });

  it('gives the lines of a session for the panel, projected, with the panel state', async () => {
    const sessions = path.join(home, 'sessions');
    await appendEvent(sessions, {
      v: 1,
      ts: '2026-10-12T09:31:00Z',
      session: SESSION,
      source: 'hook',
      type: 'tool.pre',
      tool: 'Write',
      target: { root: 'projects', path: `garden/${FAKE_KEY}.md` },
    });
    await appendEvent(sessions, {
      v: 1,
      ts: '2026-10-12T09:31:01Z',
      session: SESSION,
      source: 'runner',
      type: 'tool.denied',
      tool: 'Write',
      by: 'guard',
      reason: 'Not inside C:/Users/someone/elsewhere.',
    });
    const reply = await json<{ events: { id: number; type: string }[]; badLines: number; state: { session: { status: string }; nodes: { id: string; denials: unknown[] }[] } }>(
      `/api/sessions/${SESSION}/events`,
    );
    expect(reply.events.map((event) => [event.id, event.type])).toEqual([
      [1, 'session.started'],
      [2, 'step.started'],
      [3, 'step.finished'],
      [4, 'session.finished'],
      [5, 'tool.pre'],
      [6, 'tool.denied'],
    ]);
    expect(reply.badLines).toBe(0);
    expect(reply.state.session.status).toBe('finished');
    expect(reply.state.nodes[0]?.denials).toHaveLength(1);
    const text = JSON.stringify(reply);
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain('someone');
    expect((await get(server, '/api/sessions/nope/events')).status).toBe(404);
    expect((await get(server, '/api/sessions/..%2Fx/events')).status).toBe(400);
  });

  it('lists sessions newest first and gives one timeline', async () => {
    const { sessions } = await json<{ sessions: { id: string; status: string; outcome?: string; idea?: string }[] }>('/api/sessions');
    expect(sessions.map((s) => [s.id, s.status, s.outcome, s.idea])).toEqual([
      [SESSION, 'finished', 'completed', undefined],
      ['sess-2', 'finished', 'cancelled', 'A book log. [redacted]'],
    ]);
    const timeline = await json<{ summary: { outcome: string } }>('/api/sessions/sess-2');
    expect(timeline.summary.outcome).toBe('cancelled');
    expect((await get(server, '/api/sessions/nope')).status).toBe(404);
    expect((await get(server, '/api/sessions/a%20b')).status).toBe(400);
  });

  it('serves the library index, notes and history', async () => {
    const index = await json<{ file: string; text: string }>('/api/library/index');
    expect(index.text).toContain('profile/style');

    const { notes } = await json<{ notes: { section: string; name?: string }[] }>('/api/library/notes?section=profile');
    expect(notes).toMatchObject([{ section: 'profile', name: 'style' }]);
    const all = await json<{ notes: { section: string }[] }>('/api/library/notes');
    expect(new Set(all.notes.map((n) => n.section))).toEqual(new Set(['profile', 'projects', 'lessons']));

    const note = await json<{ file: string; text: string }>('/api/library/note?section=profile&name=style');
    expect(note).toEqual({ file: 'profile/style.md', text: '# Style\n\nShort answers.\n' });
    expect((await json<{ file: string }>('/api/library/note?section=lessons')).file).toBe('lessons.md');

    expect((await get(server, '/api/library/note?section=profile&name=missing')).status).toBe(404);
    expect((await get(server, '/api/library/note?section=nope&name=x')).status).toBe(400);
    expect((await get(server, '/api/library/note')).status).toBe(400);
    expect((await get(server, '/api/library/notes?section=nope')).status).toBe(400);

    const { commits } = await json<{ commits: { subject: string; sha: string }[] }>('/api/library/history?limit=2');
    expect(commits).toHaveLength(2);
    expect(commits[0]?.subject).toBe('library: add profile/style');
    expect((await get(server, '/api/library/history?limit=0')).status).toBe(400);
    expect((await get(server, '/api/library/history?limit=abc')).status).toBe(400);
    expect((await get(server, '/api/library/history?limit=9999')).status).toBe(400);
  });

  it('checks a folder the way paths check does', async () => {
    const check = (dirValue: string) => get(server, `/api/paths/check?dir=${encodeURIComponent(dirValue)}`);
    const body = async (dirValue: string) => JSON.parse((await check(dirValue)).body) as { status: string; overlaps?: string };
    const fresh = path.join(dir, 'new-projects');
    expect(await body(fresh)).toMatchObject({ status: 'missing' });
    await mkdir(fresh, { recursive: true });
    expect(await body(fresh)).toMatchObject({ status: 'empty' });
    expect(await body(path.join(dir, 'projects'))).toMatchObject({ status: 'nonEmpty' });
    expect(await body(path.join(dir, 'projects', 'garden', 'NEXT_STEPS.md'))).toMatchObject({ status: 'notADirectory' });
    expect(await body(libraryDir)).toMatchObject({ status: 'forbidden', overlaps: 'library' });
    expect(await body(path.join(dir, 'repo'))).toMatchObject({ status: 'forbidden', overlaps: 'repo' });
    expect(await body(path.join(home, 'sessions', 'x'))).toMatchObject({ status: 'forbidden', overlaps: 'home' });
    expect(await body(path.join(dir, 'home', '.claude', 'x'))).toMatchObject({ status: 'forbidden', overlaps: 'claudeConfig' });
    expect((await check('relative/folder')).status).toBe(400);
    expect(JSON.parse((await check('relative/folder')).body)).toMatchObject({ code: 'config.relativePath' });
    expect((await get(server, '/api/paths/check')).status).toBe(400);
    expect((await get(server, '/api/paths/check?dir=x', null)).status).toBe(401);
  });

  it('reports the usage profile, the presets and the warnings', async () => {
    const usage = await json<{ profile: string; presets: { name: string; label: { en: string; es: string }; source: string }[]; drift: unknown[]; envWarnings: unknown[] }>('/api/usage');
    expect(usage.profile).toBe('balanced');
    expect(usage.presets.map((p) => p.name)).toEqual(expect.arrayContaining(['saver', 'balanced', 'max']));
    expect(usage.presets[0]?.label.es).toBeTruthy();
    expect(Array.isArray(usage.drift)).toBe(true);
    expect(Array.isArray(usage.envWarnings)).toBe(true);
  });

  it('adds the last plan usage saved in the home, or null before the first reading', async () => {
    type Last = { lastPlanUsage: { fiveHour: number | null; sevenDay: number | null; at: string } | null };
    expect((await json<Last>('/api/usage')).lastPlanUsage).toBeNull();
    await saveLastPlanUsage(home, { fiveHour: 42, sevenDay: null }, new Date('2026-10-25T09:30:00Z'));
    expect((await json<Last>('/api/usage')).lastPlanUsage).toEqual({ fiveHour: 42, sevenDay: null, at: '2026-10-25T09:30:00.000Z' });
    // A file that does not read back is no figure at all.
    await writeTree(home, { 'plan-usage.json': '{"fiveHour":"lots"}' });
    expect((await json<Last>('/api/usage')).lastPlanUsage).toBeNull();
  });

  it('reports paths and settings from the config', async () => {
    await writeTree(home, { 'config.json': '{"lang":"es","permissionPolicy":"unattended","projectsDir":"' + path.join(dir, 'elsewhere').replaceAll('\\', '/') + '"}' });
    const paths = await json<{ home: string; libraryDir: string; libraryExists: boolean; projectsDir: string; sessionsDir: string; repoDir: string; allowedDirs: string[] }>('/api/paths');
    expect(paths).toMatchObject({ home, libraryDir, libraryExists: true, sessionsDir: path.join(home, 'sessions'), repoDir: path.join(dir, 'repo') });
    // `init` allowed the projects and sessions folders in the repo's settings.
    expect(paths.allowedDirs.map((entry) => path.normalize(entry))).toEqual([path.join(dir, 'projects'), path.join(home, 'sessions')]);
    expect(path.normalize(paths.projectsDir)).toBe(path.join(dir, 'elsewhere'));
    const settings = await json<{ lang: string; configLang: string | null; permissionPolicy: string; projectsDir: string }>('/api/settings');
    expect(settings).toMatchObject({ configLang: 'es', permissionPolicy: 'unattended' });
  });

  it('defaults settings without a config and survives a missing library', async () => {
    const settings = await json<{ permissionPolicy: string; configLang: string | null }>('/api/settings');
    expect(settings).toMatchObject({ permissionPolicy: 'ask', configLang: null });
  });

  it('does not log or return secrets from notes', () => {
    expect(redactSecrets(`a\nkey ${FAKE_KEY}\nb`)).toBe('a\n[redacted]\nb');
  });
});

describe('read API without a library', () => {
  it('answers empty lists', async () => {
    const { dir, cleanup } = await tempDir('web-read-empty');
    await writeTree(path.join(dir, 'ui'), { 'index.html': '<html><head><!-- importmap --></head></html>' });
    const server = await startWebServer({
      port: 0,
      uiDir: path.join(dir, 'ui'),
      token: 't'.repeat(43),
      lang: 'en',
      pathEnv: { env: { BRIEFSTACK_HOME: path.join(dir, 'h') }, homedir: dir, pathApi: path, caseInsensitive: false },
      repoDir: path.join(dir, 'repo'),
    });
    try {
      for (const [route, key] of [['projects', 'projects'], ['sessions', 'sessions'], ['library/notes', 'notes'], ['library/history', 'commits']] as const) {
        const reply = await get(server, `/api/${route}`);
        expect(reply.status, route).toBe(200);
        expect((JSON.parse(reply.body) as Record<string, unknown[]>)[key]).toEqual([]);
      }
      expect(JSON.parse((await get(server, '/api/library/index')).body)).toEqual({ file: 'INDEX.md', text: null });
      expect(JSON.parse((await get(server, '/api/paths')).body)).toMatchObject({ libraryExists: false });
    } finally {
      await server.close();
      await cleanup();
    }
  });
});
