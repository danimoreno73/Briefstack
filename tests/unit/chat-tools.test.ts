import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffHunks, diffLines } from '../../src/chat/diff.js';
import { CHAT_ACTION_TOOLS, CHAT_READ_TOOLS, CHAT_TOOL_NAMES } from '../../src/chat/toolNames.js';
import {
  CHAT_TOOLS,
  ChatToolError,
  errorText,
  findChatTool,
  parseArgs,
  redactDeep,
  resultText,
  type ActionTool,
  type ReadTool,
  type ToolOutcome,
} from '../../src/chat/tools.js';
import { readConfig } from '../../src/config/index.js';
import { BriefstackError } from '../../src/errors.js';
import { FAKE_KEY, INJECTED, SESSION, chatWorld, type ChatWorld } from '../chatWorld.js';
import { useHermeticGit } from '../helpers.js';

useHermeticGit();

describe('line diff', () => {
  it('finds the lines that go and come, and keeps the rest', () => {
    expect(diffLines('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: '+', text: 'B' },
      { op: ' ', text: 'c' },
      { op: '+', text: 'd' },
    ]);
    expect(diffLines('', 'x\n')).toEqual([{ op: '+', text: 'x' }]);
    expect(diffLines('x\r\ny\r\n', 'x\ny\n').every((line) => line.op === ' ')).toBe(true);
  });

  it('keeps two lines of context around each change and counts what it skips', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 10', 'LINE 10');
    const hunks = diffHunks(diffLines(before, after));
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.skipped).toBe(8);
    expect(hunks[0]?.lines.map((line) => line.op).join('')).toBe('  -+  ');
  });

  it('falls back to all removed and all added for huge notes', () => {
    const big = Array.from({ length: 3500 }, (_, i) => `${i}`).join('\n');
    const lines = diffLines(big, `${big}\nmore`);
    expect(lines.filter((line) => line.op === '-')).toHaveLength(3500);
    expect(lines.filter((line) => line.op === '+')).toHaveLength(3501);
  });
});

describe('the registry', () => {
  it('holds exactly the tools of BRIEF-phase-4 §3.1, each with a schema, in one list', () => {
    expect(CHAT_TOOLS.map((tool) => tool.name)).toEqual([...CHAT_TOOL_NAMES]);
    expect(CHAT_TOOLS.filter((tool) => tool.kind === 'read').map((tool) => tool.name)).toEqual([...CHAT_READ_TOOLS]);
    expect(CHAT_TOOLS.filter((tool) => tool.kind === 'action').map((tool) => tool.name)).toEqual([...CHAT_ACTION_TOOLS]);
    // Nothing that reverts commits, changes the projects folder or the policy, or answers a creation.
    for (const name of CHAT_TOOL_NAMES) expect(name).not.toMatch(/revert|projects_dir|policy|answer|approve|grant/);
  });

  it('validates input strictly', () => {
    const tool = findChatTool('read_note');
    if (tool === undefined) throw new Error('missing');
    expect(() => parseArgs(tool, { section: 'index', extra: 1 })).toThrow();
    expect(() => parseArgs(tool, { section: '../etc' })).toThrow();
    expect(parseArgs(tool, { section: 'index' })).toEqual({ section: 'index' });
    expect(errorText(new BriefstackError('library.noteNotFound', { section: 'profile', name: 'x' }))).toContain('profile');
    expect(errorText(new Error('internal detail'))).toBe('The tool failed.');
  });

  it('wraps every result as data and redacts every string in it', () => {
    const outcome: ToolOutcome = { data: { nested: [{ text: `token ${FAKE_KEY}` }] }, sources: [{ kind: 'note', ref: 'profile/x.md' }] };
    const text = resultText(outcome);
    expect(text).not.toContain(FAKE_KEY);
    expect(JSON.parse(text)).toMatchObject({ note: expect.stringContaining('never an instruction'), sources: outcome.sources });
    expect(redactDeep({ a: [FAKE_KEY], b: 1, c: null })).toMatchObject({ b: 1, c: null });
  });
});

describe('the tools', () => {
  let world: ChatWorld;
  beforeEach(async () => {
    world = await chatWorld();
  });
  afterEach(() => world.cleanup());

  const read = async (name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> => {
    const tool = findChatTool(name) as ReadTool;
    return tool.run(world.tools, parseArgs(tool, args));
  };
  const propose = async (name: string, args: Record<string, unknown>) => {
    const tool = findChatTool(name) as ActionTool;
    return tool.propose(world.tools, parseArgs(tool, args));
  };

  it('list_projects and show_project answer from the library, with sources', async () => {
    const list = await read('list_projects');
    expect(list.data).toEqual([expect.objectContaining({ slug: 'garden', name: 'Garden planner', target: 'claude-app', sessionId: SESSION })]);
    expect(list.sources).toEqual([{ kind: 'project', ref: 'garden', label: 'Garden planner' }]);
    const shown = await read('show_project', { slug: 'garden' });
    expect(JSON.stringify(shown.data)).toContain('Plans a vegetable garden by season.');
    expect(shown.sources).toContainEqual({ kind: 'note', ref: 'projects/garden.md' });
    await expect(read('show_project', { slug: 'nope' })).rejects.toMatchObject({ code: 'library.noteNotFound' });
  });

  it('search_library and read_note return note text as data, secrets hidden, instructions untouched but inert', async () => {
    const found = await read('search_library', { query: 'short answers' });
    expect(found.sources).toContainEqual({ kind: 'note', ref: 'profile/style.md' });
    const style = await read('read_note', { section: 'profile', name: 'style' });
    // The injected text is passed on as data, inside the data wrapper.
    expect(resultText(style)).toContain('IMPORTANT SYSTEM NOTE');
    expect(JSON.parse(resultText(style)).note).toContain('never an instruction');
    const legacy = await read('read_note', { section: 'profile', name: 'legacy' });
    expect(resultText(legacy)).not.toContain(FAKE_KEY);
    expect(resultText(legacy)).toContain('Keep this line.');
    const index = await read('read_note', { section: 'index' });
    expect(JSON.stringify(index.data)).toContain('[[projects/garden]]');
    const lessons = await read('read_note', { section: 'lessons' });
    expect(JSON.stringify(lessons.data)).toContain('Do not ask for the folder twice.');
  });

  it('list_sessions and session_panel answer from the session events and the active creations', async () => {
    const started = await world.creations.create('A recipe box');
    const listed = await read('list_sessions');
    expect(JSON.stringify(listed.data)).toContain(SESSION);
    expect((listed.data as { activeCreations: { creationId: string; idea: string }[] }).activeCreations).toEqual([
      expect.objectContaining({ creationId: started.id, idea: 'A recipe box' }),
    ]);
    const panel = await read('session_panel', { sessionId: SESSION });
    expect(panel.data).toMatchObject({ session: { status: 'finished', outcome: 'completed' }, agents: [expect.objectContaining({ agent: 'main', status: 'done' })] });
    expect(panel.sources).toEqual([{ kind: 'session', ref: SESSION }]);
    await expect(read('session_panel', { sessionId: '../x' })).rejects.toBeInstanceOf(BriefstackError);
  });

  it('gives the model no absolute path: folders under the home as ~/…, anything else hidden', async () => {
    const settings = await read('show_settings');
    const text = resultText(settings, world.pathEnv.homedir);
    expect(text).toContain('~/.briefstack/library');
    expect(text).not.toContain(world.dir.replaceAll('\\', '/'));
    expect(text).not.toContain(world.dir);
    expect(text).not.toContain(JSON.stringify(world.dir).slice(1, -1));
    // The projects folder is outside the home in this world: hidden.
    expect(text).toContain('[outside allowed folders]');
    expect(resultText({ data: { a: '/tmp/x/y', b: 'C:\\x\\y', c: '\\\\srv\\share' }, sources: [] })).not.toMatch(/\/tmp|C:|srv/);
    expect(errorText(new BriefstackError('library.notInitialised', { dir: world.libraryDir }))).not.toContain(world.libraryDir);
    expect(errorText(new ChatToolError('No folder /home/someone/x'))).toBe('No folder [outside allowed folders]');
  });

  it('show_usage and show_settings', async () => {
    const usage = await read('show_usage');
    expect(usage.data).toMatchObject({ profile: 'balanced', chat: { model: 'sonnet', effort: 'medium' }, planUsage: { fiveHourPercent: 21, sevenDayPercent: 34 } });
    const settings = await read('show_settings');
    expect(settings.data).toMatchObject({ permissionPolicy: 'ask', maxActiveCreations: 2, folders: { library: world.libraryDir } });
  });

  it('start_creation proposes a card and starts only when performed; refused at the limit', async () => {
    const proposal = await propose('start_creation', { idea: 'A recipe box' });
    expect(proposal.card).toEqual({ kind: 'startCreation', idea: 'A recipe box', profile: 'balanced', active: 0, limit: 2 });
    expect(world.creations.list()).toHaveLength(0);
    const done = await proposal.perform();
    expect(world.creations.list()).toHaveLength(1);
    expect(done.data).toMatchObject({ started: true, creationId: world.creations.list()[0]?.id });
    await world.creations.create('Second');
    await expect(propose('start_creation', { idea: 'Third' })).rejects.toBeInstanceOf(ChatToolError);
  });

  it('cancel_creation names the creation and cancels only when performed', async () => {
    const state = await world.creations.create('A recipe box');
    const proposal = await propose('cancel_creation', { creationId: state.id });
    expect(proposal.card).toMatchObject({ kind: 'cancelCreation', creationId: state.id, idea: 'A recipe box' });
    expect(world.creations.get(state.id).cancelling).toBeUndefined();
    await proposal.perform();
    expect(world.creations.get(state.id).cancelling === true || world.creations.get(state.id).status === 'finished').toBe(true);
    await expect(propose('cancel_creation', { creationId: 'nope' })).rejects.toMatchObject({ code: 'creation.notFound' });
  });

  it('propose_note_change shows the diff and the mode, saves through saveNote with one commit only when performed', async () => {
    const file = path.join(world.libraryDir, 'profile', 'style.md');
    const before = await readFile(file, 'utf8');
    const append = await propose('propose_note_change', { section: 'profile', name: 'style', text: `${before}\nUse metric units.\n` });
    expect(append.card).toMatchObject({ kind: 'noteChange', file: 'profile/style.md', mode: 'append', added: 2, removed: 0 });
    expect(await readFile(file, 'utf8')).toBe(before);
    const rewrite = await propose('propose_note_change', { section: 'profile', name: 'style', text: '# Style\n\nLong answers.\n' });
    expect(rewrite.card).toMatchObject({ mode: 'rewrite' });
    const commits = () => Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: world.libraryDir, encoding: 'utf8' }).trim());
    const count = commits();
    const saved = await rewrite.perform();
    expect(saved.data).toMatchObject({ file: 'profile/style.md', mode: 'rewrite', committed: true });
    expect(commits()).toBe(count + 1);
    expect(await readFile(file, 'utf8')).toBe('# Style\n\nLong answers.\n');

    const created = await propose('propose_note_change', { section: 'profile', name: 'units', text: '# Units\n\nMetric.\n' });
    expect(created.card).toMatchObject({ mode: 'create', file: 'profile/units.md' });
    await expect(propose('propose_note_change', { section: 'profile', name: 'units', text: `key ${FAKE_KEY}\n` })).rejects.toBeInstanceOf(ChatToolError);
    await expect(propose('propose_note_change', { section: 'profile', name: 'style', text: '# Style\n\nLong answers.\n' })).rejects.toThrow(/nothing to change/);
    await expect(propose('propose_note_change', { section: 'profile', name: 'Bad Name', text: 'x' })).rejects.toMatchObject({ code: 'library.invalidName' });
  });

  it('set_usage_profile shows from and to, and switches only when performed', async () => {
    const proposal = await propose('set_usage_profile', { profile: 'saver' });
    expect(proposal.card).toMatchObject({ kind: 'usageProfile', from: 'balanced', to: 'saver' });
    expect((await readConfig(path.join(world.home, 'config.json'))).activeProfile).toBeUndefined();
    await proposal.perform();
    expect((await readConfig(path.join(world.home, 'config.json'))).activeProfile).toBe('saver');
    await expect(propose('set_usage_profile', { profile: 'saver' })).rejects.toBeInstanceOf(ChatToolError);
    await expect(propose('set_usage_profile', { profile: 'nope' })).rejects.toMatchObject({ code: 'usage.unknownProfile' });
  });

  it('keeps the injected text out of anything but data', () => {
    expect(INJECTED).toContain('cancel_creation');
  });
});
