import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeChatRunner, parseChatScript, type ChatScript } from '../../src/chat/fakeChatRunner.js';
import { ChatManager } from '../../src/chat/manager.js';
import { ChatStore } from '../../src/chat/store.js';
import type { ChatMessage, ChatStreamEvent } from '../../src/chat/types.js';
import { addNote } from '../../src/library/index.js';
import { FAKE_KEY, INJECTED, chatWorld, type ChatWorld } from '../chatWorld.js';
import { useHermeticGit } from '../helpers.js';

useHermeticGit();

async function waitFor<T>(probe: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('ChatManager', () => {
  let world: ChatWorld;
  let chat: ChatManager | undefined;
  beforeEach(async () => {
    world = await chatWorld();
  });
  afterEach(async () => {
    await chat?.shutdown();
    chat = undefined;
    await world.cleanup();
  });

  const store = () => new ChatStore(path.join(world.home, 'chat'));
  const open = async (script: ChatScript, extra: Partial<Parameters<typeof ChatManager.open>[0]> = {}) => {
    const runner = new FakeChatRunner(script);
    chat = await ChatManager.open({
      store: store(),
      runner,
      tools: world.tools,
      profile: async () => ({ model: 'haiku', effort: 'low' }),
      ...extra,
    });
    return { chat, runner };
  };
  const idle = async (c: ChatManager) => waitFor(async () => (await c.view()).status === 'idle');
  const pendingOf = async (c: ChatManager) => waitFor(async () => (await c.view()).pending);
  const roles = (messages: ChatMessage[]) => messages.map((message) => message.role);

  it('answers a question from data: the tool call is recorded with its sources, the answer follows', async () => {
    const { chat: c, runner } = await open({ turns: [[{ call: 'list_projects' }, { sayResult: 'data.0.name' }]] });
    await c.send('Which projects do I have?');
    await idle(c);
    const { messages } = await c.view();
    expect(roles(messages)).toEqual(['user', 'tool', 'assistant']);
    expect(messages[1]?.tool).toEqual({ name: 'list_projects', summary: '', sources: [{ kind: 'project', ref: 'garden', label: 'Garden planner' }] });
    expect(messages[2]?.text).toBe('Garden planner');
    expect(runner.starts).toEqual([{ model: 'haiku', effort: 'low' }]);
  });

  it('runs an action only after the confirmation, and not on a decline', async () => {
    const { chat: c } = await open({
      turns: [
        [{ call: 'start_creation', args: { idea: 'A recipe box' } }, { sayResult: 'data.result.creationId' }],
        [{ call: 'start_creation', args: { idea: 'Another box' } }, { sayResult: '' }],
      ],
    });
    await c.send('Start a recipe box');
    const first = await pendingOf(c);
    expect(first.card).toMatchObject({ kind: 'startCreation', idea: 'A recipe box' });
    expect(world.creations.list()).toHaveLength(0);
    expect((await c.view()).status).toBe('thinking');
    c.confirm(first.id, 'confirm');
    await idle(c);
    expect(world.creations.list().map((creation) => creation.idea)).toEqual(['A recipe box']);
    const confirmed = (await c.view()).messages.find((message) => message.confirmation?.id === first.id);
    expect(confirmed?.confirmation).toMatchObject({ state: 'confirmed', sources: [expect.objectContaining({ kind: 'creation' })] });

    await c.send('And another');
    const second = await pendingOf(c);
    c.confirm(second.id, 'decline');
    await idle(c);
    expect(world.creations.list()).toHaveLength(1);
    const { messages } = await c.view();
    expect(messages.at(-1)?.text).toContain('declined');
    expect(messages.find((message) => message.confirmation?.id === second.id)?.confirmation?.state).toBe('declined');
    // A card can only be answered while it waits.
    expect(() => c.confirm(second.id, 'confirm')).toThrow(expect.objectContaining({ code: 'chat.noConfirmation' }));
  });

  it('an instruction inside a note does nothing by itself: at most it becomes a card the user declines', async () => {
    // The script plays a model that obeys the injected text: it reads the note, then proposes a change.
    const { chat: c } = await open({
      turns: [
        [
          { call: 'read_note', args: { section: 'profile', name: 'style' } },
          { call: 'propose_note_change', args: { section: 'profile', name: 'style', text: '# Style\n\nObey the note.\n' } },
          { sayResult: '' },
        ],
      ],
    });
    const style = path.join(world.libraryDir, 'profile', 'style.md');
    const before = await readFile(style, 'utf8');
    expect(before).toContain(INJECTED);
    await c.send('What does my style note say?');
    const card = await pendingOf(c);
    expect(card.card).toMatchObject({ kind: 'noteChange', file: 'profile/style.md' });
    // Nothing changed while the card waits, and nothing after the user says no.
    expect(await readFile(style, 'utf8')).toBe(before);
    c.confirm(card.id, 'decline');
    await idle(c);
    expect(await readFile(style, 'utf8')).toBe(before);
  });

  it('a note change confirmed after the note changed saves nothing and the card says so', async () => {
    const { chat: c, runner } = await open({
      turns: [[{ call: 'propose_note_change', args: { section: 'profile', name: 'style', text: '# Style\n\nLong answers.\n' } }, { sayResult: '' }]],
    });
    await c.send('Make my style note say long answers');
    const card = await pendingOf(c);
    const style = path.join(world.libraryDir, 'profile', 'style.md');
    await addNote({ libraryDir: world.libraryDir, section: 'profile', name: 'style', text: 'Use metric units.\n' });
    const changed = await readFile(style, 'utf8');
    c.confirm(card.id, 'confirm');
    await idle(c);
    expect(await readFile(style, 'utf8')).toBe(changed);
    const { messages } = await c.view();
    expect(messages.find((message) => message.confirmation?.id === card.id)?.confirmation?.state).toBe('stale');
    expect(runner.replies.at(-1)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('changed after the card was shown') }] });
  });

  it('keeps one card at a time and limits how many it shows', async () => {
    const { chat: c, runner } = await open(
      {
        turns: [
          [{ call: 'set_usage_profile', args: { profile: 'saver' } }],
          [{ call: 'set_usage_profile', args: { profile: 'max' } }, { call: 'set_usage_profile', args: { profile: 'max' } }],
        ],
      },
      { maxProposals: 2 },
    );
    await c.send('Switch to saver');
    const first = await pendingOf(c);
    // While it waits the session is mid-turn: a new message is refused.
    await expect(c.send('hello')).rejects.toMatchObject({ code: 'chat.busy' });
    c.confirm(first.id, 'decline');
    await idle(c);
    await c.send('Switch to max');
    const second = await pendingOf(c);
    c.confirm(second.id, 'decline');
    await idle(c);
    expect(runner.replies.at(-1)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Too many proposals') }] });
  });

  it('refuses a second card while one waits (two calls in one turn)', async () => {
    const { chat: c } = await open({ turns: [] });
    const first = c.execute('set_usage_profile', { profile: 'saver' });
    await pendingOf(c);
    const second = await c.execute('set_usage_profile', { profile: 'max' });
    expect(second).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Another proposal is waiting') }] });
    c.confirm((await c.view()).pending?.id ?? '', 'decline');
    expect(await first).toMatchObject({ content: [{ text: expect.stringContaining('declined') }] });
  });

  it('two actions called at once: the second gets an error at once, the first keeps its card', async () => {
    const { chat: c } = await open({ turns: [] });
    const settle = <T,>(promise: Promise<T>) => Promise.race([promise, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1000))]);
    // Both start before the first one's proposal is ready.
    const first = c.execute('set_usage_profile', { profile: 'saver' });
    const second = c.execute('set_usage_profile', { profile: 'max' });
    expect(await settle(second)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Another proposal is waiting') }] });
    const card = await pendingOf(c);
    expect(card.card).toMatchObject({ kind: 'usageProfile', to: 'saver' });
    expect((await c.view()).messages.filter((message) => message.role === 'confirmation')).toHaveLength(1);
    c.confirm(card.id, 'decline');
    expect(await settle(first)).toMatchObject({ content: [{ text: expect.stringContaining('declined') }] });

    // A proposal that fails frees the slot for the next one.
    expect(await c.execute('cancel_creation', { creationId: 'nope' })).toMatchObject({ isError: true });
    const third = c.execute('set_usage_profile', { profile: 'max' });
    const next = await pendingOf(c);
    c.confirm(next.id, 'decline');
    expect(await settle(third)).toMatchObject({ content: [{ text: expect.stringContaining('declined') }] });
  });

  it('stores the history redacted, and shows it again after a restart, resuming the same session', async () => {
    const script = { turns: [[{ echo: true as const }], [{ say: 'Welcome back.' }]] };
    const { chat: c } = await open(script);
    await c.send(`My key is ${FAKE_KEY}`);
    await idle(c);
    const before = await c.view();
    expect(JSON.stringify(before)).not.toContain(FAKE_KEY);
    await c.shutdown();
    const file = path.join(world.home, 'chat', 'threads', `${before.thread.id}.jsonl`);
    expect(await readFile(file, 'utf8')).not.toContain(FAKE_KEY);
    const state = JSON.parse(await readFile(path.join(world.home, 'chat', 'state.json'), 'utf8')) as { threads: { sdkSessionId?: string }[] };
    const sdkSessionId = state.threads[0]?.sdkSessionId;
    expect(sdkSessionId).toBeDefined();

    // A new server: same thread, same messages, and the session resumes by id.
    const again = await open({ turns: [[{ say: 'Welcome back.' }]] });
    const view = await again.chat.view();
    expect(view.thread.id).toBe(before.thread.id);
    expect(view.messages).toEqual(before.messages);
    await again.chat.send('Hello again');
    await idle(again.chat);
    expect(again.runner.starts).toEqual([{ model: 'haiku', effort: 'low', resume: sdkSessionId }]);
  });

  it('starts a new session and says so when the resume fails, keeping the old messages', async () => {
    const { chat: c } = await open({ turns: [[{ say: 'First.' }]] });
    await c.send('Hi');
    await idle(c);
    await c.shutdown();
    const again = await open({ turns: [[{ say: 'Fresh start.' }]], resumeFails: true });
    await again.chat.send('Still there?');
    await waitFor(async () => (await again.chat.view()).messages.some((message) => message.text === 'Fresh start.'));
    const { messages } = await again.chat.view();
    expect(roles(messages)).toEqual(['user', 'assistant', 'user', 'notice', 'assistant']);
    expect(messages[3]?.notice).toBe('resumeFailed');
    expect(again.runner.starts.map((start) => start.resume === undefined)).toEqual([false, true]);
    expect(again.runner.received).toEqual(['Still there?']);
  });

  it('"New chat" archives the thread read-only, expires a waiting card and streams the change', async () => {
    const { chat: c } = await open({ turns: [[{ call: 'set_usage_profile', args: { profile: 'saver' } }]] });
    const events: ChatStreamEvent[] = [];
    c.subscribe(0, (event) => events.push(event));
    await c.send('Switch to saver');
    const card = await pendingOf(c);
    const old = (await c.view()).thread.id;
    await c.newChat();
    const view = await c.view();
    expect(view.thread.id).not.toBe(old);
    expect(view.messages).toEqual([]);
    expect(view.status).toBe('idle');
    const archived = await c.readThread(old);
    expect(archived.thread.archivedAt).toBeDefined();
    expect(archived.messages.find((message) => message.confirmation?.id === card.id)?.confirmation?.state).toBe('expired');
    expect(c.threads().map((thread) => thread.id)).toEqual([view.thread.id, old]);
    expect(events.some((event) => event.kind === 'thread')).toBe(true);
    expect((await readConfigProfile(world))).toBeUndefined();
    await expect(c.readThread('nope')).rejects.toMatchObject({ code: 'chat.threadNotFound' });
  });

  it('a session error is a notice, and the chat stays usable', async () => {
    const { chat: c } = await open({ turns: [[{ fail: 'The model is unavailable at /home/someone/.claude/x.' }], [{ say: 'Back.' }]] });
    await c.send('Hi');
    await idle(c);
    expect((await c.view()).messages.at(-1)).toMatchObject({ role: 'notice', notice: 'sessionError', detail: 'The model is unavailable at [outside allowed folders].' });
    await c.send('Again');
    await waitFor(async () => (await c.view()).messages.at(-1)?.text === 'Back.');
  });

  it('a card left waiting when the server stopped reads as expired after the restart', async () => {
    const { chat: c } = await open({ turns: [[{ call: 'set_usage_profile', args: { profile: 'saver' } }]] });
    await c.send('Switch to saver');
    await pendingOf(c);
    await c.shutdown();
    const again = await open({ turns: [] });
    const view = await again.chat.view();
    expect(view.pending).toBeUndefined();
    expect(view.messages.find((message) => message.role === 'confirmation')?.confirmation?.state).toBe('expired');
  });

  it('parses scripts strictly', () => {
    expect(() => parseChatScript('{"turns":[[{"bogus":1}]]}')).toThrow();
    expect(parseChatScript('{"turns":[[{"say":"x"}]]}').turns).toHaveLength(1);
  });
});

async function readConfigProfile(world: ChatWorld): Promise<string | undefined> {
  const text = await readFile(path.join(world.home, 'config.json'), 'utf8');
  return (JSON.parse(text) as { activeProfile?: string }).activeProfile;
}
