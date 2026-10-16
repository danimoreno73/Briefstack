import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../../src/config/config.js';
import { toAbsolute } from '../../src/config/paths.js';
import { EVENTS_FILE, MAX_TARGET_LENGTH, readEvents } from '../../src/events/index.js';
import { PACKAGE_ROOT } from '../../src/packageRoot.js';
import {
  MAX_TARGET_LENGTH as HOOK_MAX_TARGET_LENGTH,
  agentModel,
  cliTarget,
  pathTarget,
  projectsDirOf,
  targetOf,
  toAbsolute as hookToAbsolute,
  toEvent,
} from '../../scripts/hook-event.mjs';
import { tempDir } from '../helpers.js';

const HOOK_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'hook-event.mjs');
const SESSION = '3f2b9c1e-0000-4a5b-9c8d-123456789abc';

const styles = [
  {
    name: 'win32',
    pathApi: path.win32,
    home: 'C:\\Users\\someone',
    roots: {
      session: 'C:\\Users\\someone\\.briefstack\\sessions\\s1',
      projects: 'D:\\work\\projects',
      repo: 'C:\\code\\briefstack',
    },
    file: (...parts: string[]) => ['D:\\work\\projects', ...parts].join('\\'),
  },
  {
    name: 'posix',
    pathApi: path.posix,
    home: '/home/someone',
    roots: { session: '/home/someone/.briefstack/sessions/s1', projects: '/work/projects', repo: '/code/briefstack' },
    file: (...parts: string[]) => ['/work/projects', ...parts].join('/'),
  },
] as const;

describe('hook targets (pure)', () => {
  it('keeps the same length limit as the reader', () => {
    expect(HOOK_MAX_TARGET_LENGTH).toBe(MAX_TARGET_LENGTH);
  });

  it.each(styles)('resolves paths and projectsDir like the CLI ($name)', ({ pathApi, home }) => {
    for (const value of ['~', '~/p', 'relative', '/c/x', 'C:\\data\\p', 'D:/data/p', '/srv/p', '  /srv/p  ']) {
      expect(hookToAbsolute(value, home, pathApi), value).toBe(toAbsolute(value, { homedir: home, pathApi }));
    }
    const pathEnv = { env: {}, homedir: home, pathApi, caseInsensitive: false };
    for (const config of [{}, { projectsDir: '~/my-projects' }, { projectsDir: pathApi === path.win32 ? 'E:\\p' : '/srv/p' }]) {
      expect(projectsDirOf(config, home, pathApi), JSON.stringify(config)).toBe(resolvePaths(config, pathEnv).projectsDir);
    }
    // The CLI refuses a relative projectsDir; the hook then has no projects folder.
    expect(projectsDirOf({ projectsDir: 'relative' }, home, pathApi)).toBeUndefined();
    expect(projectsDirOf(null, home, pathApi)).toBe(pathApi.join(home, 'briefstack-projects'));
  });

  it.each(styles)('makes a path relative to the closest known folder, else outside ($name)', ({ pathApi, roots, file }) => {
    expect(pathTarget(file('garden', 'docs', 'BRIEF.md'), roots, pathApi, false)).toEqual({ root: 'projects', path: 'garden/docs/BRIEF.md' });
    expect(pathTarget(pathApi.join(roots.session, 'spec.json'), roots, pathApi, false)).toEqual({ root: 'session', path: 'spec.json' });
    expect(pathTarget(pathApi.join(roots.repo, 'library', 'rules', 'target.md'), roots, pathApi, false)).toEqual({
      root: 'repo',
      path: 'library/rules/target.md',
    });
    expect(pathTarget(roots.projects, roots, pathApi, false)).toEqual({ root: 'projects' });
    const elsewhere = pathApi === path.win32 ? 'C:\\Users\\someone\\secret-notes\\diary.md' : '/home/someone/secret-notes/diary.md';
    expect(pathTarget(elsewhere, roots, pathApi, false)).toEqual({ root: 'outside' });
    // Relative or Git Bash forms are not recorded at all.
    expect(pathTarget('docs/BRIEF.md', roots, pathApi, false)).toBeUndefined();
    if (pathApi === path.win32) expect(pathTarget('/c/Users/someone/x.md', roots, pathApi, false)).toBeUndefined();
    expect(pathTarget(42, roots, pathApi, false)).toBeUndefined();
  });

  it('picks the closest folder when one holds another', () => {
    const roots = { session: '/data/home/sessions/s1', projects: '/data', repo: '/code' };
    expect(pathTarget('/data/home/sessions/s1/idea.md', roots, path.posix, false)).toEqual({ root: 'session', path: 'idea.md' });
  });

  it('compares without case where the file system does', () => {
    const roots = { projects: 'D:\\Work\\Projects' };
    expect(pathTarget('d:/work/projects/garden/a.md', roots, path.win32, true)).toEqual({ root: 'projects', path: 'garden/a.md' });
    expect(pathTarget('/Work/Projects/garden/a.md', { projects: '/work/projects' }, path.posix, true)).toMatchObject({ root: 'projects' });
    expect(pathTarget('/Work/Projects/garden/a.md', { projects: '/work/projects' }, path.posix, false)).toEqual({ root: 'outside' });
  });

  it('keeps the end of a long path, within the limit', () => {
    const long = `/work/projects/${'deep/'.repeat(40)}file.md`;
    const target = pathTarget(long, { projects: '/work/projects' }, path.posix, false);
    expect(target?.path?.length).toBe(MAX_TARGET_LENGTH);
    expect(target?.path?.startsWith('…')).toBe(true);
    expect(target?.path?.endsWith('/file.md')).toBe(true);
  });

  it('keeps only the briefstack subcommand of a shell command', () => {
    expect(cliTarget('npm run --silent briefstack -- library add projects garden --from "C:/x/p.md"')).toEqual({ root: 'cli', path: 'library add' });
    expect(cliTarget('npm run --silent briefstack -- validate "C:/Users/someone/projects/garden" --json')).toEqual({ root: 'cli', path: 'validate' });
    expect(cliTarget('npm run briefstack -- event session started --session abc')).toEqual({ root: 'cli', path: 'event session' });
    expect(cliTarget('npm run --silent briefstack -- paths --json')).toEqual({ root: 'cli', path: 'paths' });
    for (const command of ['git status', 'echo npm run briefstack -- paths', 'curl https://example.com', 'npm run briefstack', '', undefined]) {
      expect(cliTarget(command), String(command)).toBeUndefined();
    }
  });

  it('never keeps a query, a URL, a pattern, a command or file content', () => {
    const roots = { projects: '/work/projects' };
    expect(targetOf('WebFetch', { url: 'https://example.com/private?q=1' }, roots, path.posix)).toBeUndefined();
    expect(targetOf('WebSearch', { query: 'my private question' }, roots, path.posix)).toBeUndefined();
    expect(targetOf('Bash', { command: 'cat ~/.ssh/id_rsa' }, roots, path.posix)).toBeUndefined();
    expect(targetOf('Grep', { pattern: 'password', path: '/work/projects/garden' }, roots, path.posix)).toEqual({ root: 'projects', path: 'garden' });
    expect(targetOf('Write', { file_path: '/work/projects/garden/a.md', content: 'secret text' }, roots, path.posix)).toEqual({
      root: 'projects',
      path: 'garden/a.md',
    });
    expect(targetOf('Agent', { subagent_type: 'architect', prompt: 'x' }, roots, path.posix)).toBeUndefined();
    expect(targetOf('Read', null, roots, path.posix)).toBeUndefined();
  });

  it('reads an agent model the way usage set writes it, and nothing outside .claude/agents', () => {
    const files: Record<string, string> = {
      [path.posix.join('/repo', '.claude', 'agents', 'architect.md')]: '---\nname: architect\nmodel: opus\neffort: medium\n---\nBody model: haiku\n',
      [path.posix.join('/repo', '.claude', 'agents', 'plain.md')]: 'model: sonnet\n',
    };
    const read = (file: string) => {
      const text = files[file];
      if (text === undefined) throw new Error('ENOENT');
      return text;
    };
    expect(agentModel('/repo', 'architect', read, path.posix)).toBe('opus');
    expect(agentModel('/repo', 'plain', read, path.posix)).toBeUndefined();
    expect(agentModel('/repo', 'missing', read, path.posix)).toBeUndefined();
    expect(agentModel('/repo', '../secrets', read, path.posix)).toBeUndefined();
    expect(agentModel(undefined, 'architect', read, path.posix)).toBeUndefined();
  });

  it('reads the real agent files', () => {
    for (const agent of ['interviewer', 'researcher', 'architect', 'generator', 'reviewer']) {
      expect(agentModel(PACKAGE_ROOT, agent), agent).toMatch(/^[a-z0-9.[\]-]+$/);
    }
  });

  it('adds the new fields only where they belong', () => {
    const roots = { projects: '/work/projects' };
    const context = { roots, pathApi: path.posix, caseInsensitive: false, model: (type: string | undefined) => (type === 'architect' ? 'opus' : undefined) };
    const base = { session_id: SESSION, transcript_path: 'x', cwd: '/code' };
    const now = new Date('2026-10-16T10:00:00Z');
    expect(
      toEvent(
        { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'toolu_01', tool_input: { file_path: '/work/projects/g/a.md' }, effort: { level: 'high' } },
        now,
        context,
      ),
    ).toMatchObject({ type: 'tool.pre', toolUseId: 'toolu_01', target: { root: 'projects', path: 'g/a.md' }, effort: 'high' });
    const post = toEvent({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'toolu_01', effort: { level: 'high' } }, now, context);
    expect(post).toMatchObject({ type: 'tool.post', toolUseId: 'toolu_01' });
    expect(post).not.toHaveProperty('effort');
    expect(post).not.toHaveProperty('target');
    expect(toEvent({ ...base, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'architect' }, now, context)).toMatchObject({ model: 'opus' });
    expect(toEvent({ ...base, hook_event_name: 'SubagentStart', agent_id: 'a2', agent_type: 'other' }, now, context)).not.toHaveProperty('model');
    expect(
      toEvent({ ...base, hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'architect', effort: { level: 'medium' } }, now, context),
    ).toMatchObject({ effort: 'medium' });
    // Odd values are dropped, not written.
    const odd = toEvent({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'a b\nc', effort: { level: 'x'.repeat(200) } }, now, context);
    expect(odd).not.toHaveProperty('toolUseId');
    expect(odd).not.toHaveProperty('effort');
    // Without a context (as in phase 2), no target and no model.
    expect(toEvent({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/work/projects/g/a.md' } }, now)).not.toHaveProperty('target');
  });
});

describe('hook script with the new fields (end to end)', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let home: string;
  let repo: string;
  let projects: string;
  let eventsFile: string;

  const run = (payload: Record<string, unknown>) =>
    new Promise<number>((resolve) => {
      const child = execFile(
        process.execPath,
        [HOOK_SCRIPT],
        { env: { ...process.env, BRIEFSTACK_HOME: home, CLAUDE_PROJECT_DIR: repo } },
        (error) => resolve(error ? Number(error.code ?? 1) : 0),
      );
      child.stdin?.end(JSON.stringify({ session_id: SESSION, transcript_path: 'x', cwd: repo, ...payload }));
    });

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('hook-fields'));
    home = path.join(dir, 'home');
    repo = path.join(dir, 'repo');
    projects = path.join(dir, 'my-projects');
    eventsFile = path.join(home, 'sessions', SESSION, EVENTS_FILE);
    await mkdir(path.dirname(eventsFile), { recursive: true });
    await mkdir(path.join(repo, '.claude', 'agents'), { recursive: true });
    await writeFile(path.join(repo, '.claude', 'agents', 'generator.md'), '---\nname: generator\nmodel: sonnet\neffort: low\n---\nx\n', 'utf8');
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ projectsDir: projects }), 'utf8');
  });
  afterEach(() => cleanup());

  it('writes targets relative to the configured folders, the model and the tool use id, never the input', async () => {
    const secretPath = path.join(dir, 'elsewhere', 'private-diary.md');
    const payloads = [
      { hook_event_name: 'SubagentStart', agent_id: 'g1', agent_type: 'generator' },
      { hook_event_name: 'PreToolUse', agent_id: 'g1', agent_type: 'generator', tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: path.join(projects, 'garden', 'docs', 'BRIEF.md'), content: 'do-not-record' }, effort: { level: 'low' } },
      { hook_event_name: 'PostToolUse', agent_id: 'g1', agent_type: 'generator', tool_name: 'Write', tool_use_id: 't1', tool_response: 'do-not-record' },
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't2', tool_input: { file_path: secretPath } },
      { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 't3', tool_input: { file_path: path.join(home, 'sessions', SESSION, 'spec.json') } },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't4', tool_input: { command: 'npm run --silent briefstack -- spec check "x/spec.json"' } },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't5', tool_input: { command: 'echo do-not-record' } },
      { hook_event_name: 'SubagentStop', agent_id: 'g1', agent_type: 'generator', effort: { level: 'low' } },
    ];
    for (const payload of payloads) expect(await run(payload)).toBe(0);

    const text = await readFile(eventsFile, 'utf8');
    expect(text).not.toContain('do-not-record');
    expect(text).not.toContain('private-diary');
    expect(text).not.toContain(dir.replaceAll('\\', '\\\\'));
    const { events, badLines } = await readEvents(eventsFile);
    expect(badLines).toEqual([]);
    expect(events).toMatchObject([
      { type: 'subagent.start', agentId: 'g1', model: 'sonnet' },
      { type: 'tool.pre', toolUseId: 't1', effort: 'low', target: { root: 'projects', path: 'garden/docs/BRIEF.md' } },
      { type: 'tool.post', toolUseId: 't1' },
      { type: 'tool.pre', toolUseId: 't2', target: { root: 'outside' } },
      { type: 'tool.pre', toolUseId: 't3', target: { root: 'session', path: 'spec.json' } },
      { type: 'tool.pre', toolUseId: 't4', target: { root: 'cli', path: 'spec check' } },
      { type: 'tool.pre', toolUseId: 't5' },
      { type: 'subagent.stop', effort: 'low' },
    ]);
    expect(events[6]).not.toHaveProperty('target');
  });
});
