import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatStreamEvent } from '../../src/chat/types.js';
import { applyChatEvent, sourceHref, type ChatPageState } from '../../src/ui/chatData.js';

const base = (): ChatPageState => ({
  thread: { id: 't', title: '', createdAt: 'x', updatedAt: 'x' },
  messages: [],
  status: 'idle',
  seq: 0,
});
const message = (id: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, ts: 'x', role: 'assistant', text: `m${id}`, ...extra });
const event = (seq: number, item: Omit<ChatStreamEvent, 'seq' | 'ts'>): ChatStreamEvent => ({ seq, ts: 'x', ...item }) as ChatStreamEvent;

describe('chat page data', () => {
  it('links every source to its page', () => {
    expect(sourceHref({ kind: 'project', ref: 'garden' })).toBe('#/projects/garden');
    expect(sourceHref({ kind: 'note', ref: 'profile/style.md' })).toBe('#/library/profile/style');
    expect(sourceHref({ kind: 'note', ref: 'lessons.md' })).toBe('#/library/lessons');
    expect(sourceHref({ kind: 'note', ref: 'INDEX.md' })).toBe('#/library');
    expect(sourceHref({ kind: 'session', ref: 's1' })).toBe('#/sessions/s1');
    expect(sourceHref({ kind: 'creation', ref: 'c1' })).toBe('#/new/c1');
    expect(sourceHref({ kind: 'usage', ref: 'balanced' })).toBe('#/usage');
    expect(sourceHref({ kind: 'settings', ref: 'settings' })).toBe('#/settings');
    expect(sourceHref({ kind: 'proposal', ref: 'imp-abcdef-1234' })).toBe('#/improve/imp-abcdef-1234');
    expect(sourceHref({ kind: 'suggestion', ref: 'sug-1' })).toBe('#/improve');
  });

  it('applies messages once each, in order, and updates a message by id', () => {
    let state = base();
    for (const item of [
      event(1, { kind: 'message', data: message(2) }),
      event(2, { kind: 'message', data: message(1) }),
      event(2, { kind: 'message', data: message(9) }),
      event(3, { kind: 'message', data: message(2, { text: 'edited' }) }),
      event(4, { kind: 'status', data: { status: 'thinking' } }),
    ]) {
      state = applyChatEvent(state, item).state;
    }
    expect(state.messages.map((m) => m.text)).toEqual(['m1', 'edited']);
    expect(state).toMatchObject({ status: 'thinking', seq: 4 });
  });

  it('tracks the waiting card and asks for a reload on a new chat', () => {
    const card = { id: 'k', tool: 'set_usage_profile', card: { kind: 'usageProfile', from: 'a', to: 'b', toLabel: { en: 'B', es: 'B' } }, state: 'pending' } as const;
    let state = applyChatEvent(base(), event(1, { kind: 'message', data: message(1, { role: 'confirmation', confirmation: card }) })).state;
    expect(state.pending?.id).toBe('k');
    state = applyChatEvent(state, event(2, { kind: 'message', data: message(1, { role: 'confirmation', confirmation: { ...card, state: 'declined' } }) })).state;
    expect(state.pending).toBeUndefined();
    expect(applyChatEvent(state, event(3, { kind: 'thread', data: { threadId: 'u' } })).reload).toBe(true);
  });
});
