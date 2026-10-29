import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffHunks, diffLines } from '../../src/chat/diff.js';
import { hasRedactionMarker, restoreRedactedLines } from '../../src/chat/restore.js';
import { CHAT_ACTION_TOOLS, CHAT_READ_TOOLS, CHAT_TOOL_NAMES } from '../../src/chat/toolNames.js';
import {
  CHAT_TOOLS,
  ChatToolError,
  StaleProposalError,
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
import { addNote } from '../../src/library/index.js';
import { FAKE_KEY, INJECTED, SESSION, chatWorld, type ChatWorld } from '../chatWorld.js';
import { useHermeticGit } from '../helpers.js';

useHermeticGit();

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

describe('restoring lines from the redacted view', () => {
  const redact = (line: string) => line.replace('SECRET', '[redacted]').replace('/abs/', '[outside allowed folders]/');

  it('gives kept lines their own text back, in place or moved when unambiguous', () => {
    const original = 'a\nkey SECRET\npath /abs/x\nb\n';
    expect(restoreRedactedLines(original, 'a\nkey [redacted]\npath [outside allowed folders]/x\nB\n', redact)).toEqual({ text: 'a\nkey SECRET\npath /abs/x\nB\n', markers: [] });
    expect(restoreRedactedLines(original, 'path [outside allowed folders]/x\na\nb\n', redact)).toEqual({ text: 'path /abs/x\na\nb\n', markers: [] });
  });

  it('lists placeholders left in new or changed lines', () => {
    expect(restoreRedactedLines('a\n', 'a\nsee [redacted]\n~/x\nok\n', redact).markers).toEqual([2, 3]);
    // Two different lines with the same redacted form: a moved one cannot be told apart.
    expect(restoreRedactedLines('key SECRET\nkey SECRET2\nz\n', 'z\nkey [redacted]\n', (line) => line.replace(/SECRET\d?/, '[redacted]')).markers).toEqual([2]);
    // A line the note already holds as it is, moved, is not new text.
    expect(restoreRedactedLines('home ~/x\nz\n', 'z\nhome ~/x\n', (line) => line).markers).toEqual([]);
  });

  it('knows the placeholders', () => {
    expect(hasRedactionMarker('[redacted]')).toBe(true);
    expect(hasRedactionMarker('in [outside allowed folders].')).toBe(true);
    expect(hasRedactionMarker('cd ~/projects')).toBe(true);
    expect(hasRedactionMarker('about 3~4 days, a~/b')).toBe(false);
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

  it('list_sessions and session_panel give the step as the panel words it (stepText)', async () => {
    const started = await world.creations.create('A recipe box');
    // The fake flow opens the interview and asks a question there.
    await waitFor(() => world.creations.get(started.id).pending !== undefined);
    const listed = await read('list_sessions');
    const active = (listed.data as { activeCreations: { creationId: string; stepText: string }[] }).activeCreations;
    expect(active).toEqual([expect.objectContaining({ creationId: started.id, stepText: 'Step 3 of 9: Interview — waiting for your answers' })]);

    const sessionId = world.creations.get(started.id).sessionId;
    if (sessionId === undefined) throw new Error('no session id');
    const live = await read('session_panel', { sessionId });
    expect(live.data).toMatchObject({ stepText: 'Step 3 of 9: Interview — waiting for your answers' });
    const done = await read('session_panel', { sessionId: SESSION });
    expect(done.data).toMatchObject({ stepText: 'Step 3 of 9: Interview — finished, completed' });
    const spanish = await (findChatTool('session_panel') as ReadTool).run({ ...world.tools, lang: 'es' }, { sessionId: SESSION });
    expect(spanish.data).toMatchObject({ stepText: 'Paso 3 de 9: Entrevista — terminada, completada' });
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
    expect(usage.data).toMatchObject({ profile: 'balanced', chat: { model: 'sonnet', effort: 'medium' }, work: { model: 'sonnet', effort: 'medium' }, planUsage: { fiveHourPercent: 21, sevenDayPercent: 34 } });
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

  it('start_creation refuses an idea with a secret instead of showing it redacted and starting it whole', async () => {
    await expect(propose('start_creation', { idea: `A deploy bot\nkey ${FAKE_KEY}` })).rejects.toThrow(/looks like a secret on line 2.*remove it/);
    expect(world.creations.list()).toHaveLength(0);
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

  it('propose_note_change saves nothing when the note changed after the card was shown', async () => {
    const file = path.join(world.libraryDir, 'lessons.md');
    const before = await readFile(file, 'utf8');
    const proposal = await propose('propose_note_change', { section: 'lessons', text: before.replace('Do not ask for the folder twice.', 'Ask once.') });
    expect(proposal.card).toMatchObject({ mode: 'rewrite' });
    // A creation finishes and adds a lesson while the card waits.
    await addNote({ libraryDir: world.libraryDir, section: 'lessons', text: 'Show the plan usage early.\n' });
    const after = await readFile(file, 'utf8');
    await expect(proposal.perform()).rejects.toBeInstanceOf(StaleProposalError);
    expect(await readFile(file, 'utf8')).toBe(after);
    expect(after).toContain('Show the plan usage early.');
  });

  it('propose_note_change gives lines kept from the redacted view their real text back, and refuses placeholders in new lines', async () => {
    // What the model reads: the project's absolute path is hidden.
    const seen = (JSON.parse(resultText(await read('read_note', { section: 'projects', name: 'garden' }), world.pathEnv.homedir)) as { data: { text: string } }).data.text;
    expect(seen).toContain('path: [outside allowed folders]');
    const file = path.join(world.libraryDir, 'projects', 'garden.md');
    const before = await readFile(file, 'utf8');
    const realPath = path.join(world.projectsDir, 'garden').replaceAll('\\', '/');
    expect(before).toContain(`path: ${realPath}`);

    // An edit elsewhere keeps the real path: the card does not show the path line as changed, and the save keeps it.
    const edit = await propose('propose_note_change', { section: 'projects', name: 'garden', text: seen.replace('Plans a vegetable garden by season.', 'Plans a garden by month.') });
    const changed = (edit.card as { hunks: { lines: { op: string; text: string }[] }[] }).hunks.flatMap((hunk) => hunk.lines).filter((line) => line.op !== ' ');
    expect(changed.map((line) => line.text)).toEqual(['Plans a vegetable garden by season.', 'Plans a garden by month.']);
    await edit.perform();
    const after = await readFile(file, 'utf8');
    expect(after).toContain(`path: ${realPath}`);
    expect(after).not.toContain('[outside allowed folders]');
    expect(after).toContain('Plans a garden by month.');

    // A placeholder in a new or changed line is refused: it stands for text the model never saw.
    const now = (JSON.parse(resultText(await read('read_note', { section: 'projects', name: 'garden' }), world.pathEnv.homedir)) as { data: { text: string } }).data.text;
    for (const line of ['Copy of [outside allowed folders] too.', 'Lives in ~/garden-copy.', `Old key: [redacted]`]) {
      await expect(propose('propose_note_change', { section: 'projects', name: 'garden', text: `${now}\n${line}\n` })).rejects.toThrow(/placeholder/);
    }
    await expect(propose('propose_note_change', { section: 'projects', name: 'garden', text: now.replace(`path: [outside allowed folders]`, 'path: [outside allowed folders]/x') })).rejects.toThrow(/placeholder/);

    // A note with a secret line kept as read cannot be edited from the chat; leaving the line out can.
    const legacy = (JSON.parse(resultText(await read('read_note', { section: 'profile', name: 'legacy' }))) as { data: { text: string } }).data.text;
    await expect(propose('propose_note_change', { section: 'profile', name: 'legacy', text: `${legacy}More.\n` })).rejects.toThrow(/looks like a secret/);
    const dropped = await propose('propose_note_change', { section: 'profile', name: 'legacy', text: '# Legacy\n\nKeep this line.\n' });
    expect(dropped.card).toMatchObject({ mode: 'rewrite', removed: 1, added: 0 });
  });

  it('propose_note_change shows a dropped secret line redacted on the card (the card is what the history keeps)', async () => {
    const dropped = await propose('propose_note_change', { section: 'profile', name: 'legacy', text: '# Legacy\n\nKeep this line.\n' });
    expect(JSON.stringify(dropped.card)).not.toContain(FAKE_KEY);
    const lines = (dropped.card as { hunks: { lines: { op: string; text: string }[] }[] }).hunks.flatMap((hunk) => hunk.lines);
    expect(lines).toContainEqual({ op: '-', text: '[redacted]' });
    await dropped.perform();
    expect(await readFile(path.join(world.libraryDir, 'profile', 'legacy.md'), 'utf8')).toBe('# Legacy\n\nKeep this line.\n');
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
