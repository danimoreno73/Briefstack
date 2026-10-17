import type { ChatMessage, ChatSource, ChatStreamEvent, ChatView } from '../chat/types.js';
import { routeHash } from './route.js';

/**
 * Glue between the chat page and the chat API: where a source links to, and
 * how a stream event changes what the page shows. Pure, tested without a
 * browser.
 */

/** The page a source opens, or undefined when there is none. */
export function sourceHref(source: ChatSource): string | undefined {
  switch (source.kind) {
    case 'project':
      return routeHash({ page: 'project', slug: source.ref });
    case 'note': {
      const file = source.ref.replace(/\.md$/, '');
      if (file === 'INDEX') return routeHash({ page: 'library', section: undefined, name: undefined });
      if (file === 'lessons') return routeHash({ page: 'library', section: 'lessons', name: undefined });
      const [section, ...rest] = file.split('/');
      if (section === undefined || rest.length === 0) return undefined;
      return routeHash({ page: 'library', section, name: rest.join('/') });
    }
    case 'session':
      return routeHash({ page: 'session', id: source.ref });
    case 'creation':
      return routeHash({ page: 'new', id: source.ref });
    case 'usage':
      return routeHash({ page: 'usage' });
    case 'settings':
      return routeHash({ page: 'settings' });
  }
}

export type ChatPageState = Omit<ChatView, 'pending'> & { pending?: ChatView['pending']; seq: number };

/** Upserts a message by id, keeping the order by id. */
function upsert(messages: readonly ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index >= 0) return messages.map((candidate, position) => (position === index ? message : candidate));
  return [...messages, message].sort((a, b) => a.id - b.id);
}

/**
 * The page state after one stream event. `reload` is true when the page must
 * fetch the view again (a new chat started). Events already applied are
 * ignored, so a replay never duplicates a message.
 */
export function applyChatEvent(state: ChatPageState, event: ChatStreamEvent): { state: ChatPageState; reload: boolean } {
  if (event.seq <= state.seq) return { state, reload: false };
  const next: ChatPageState = { ...state, seq: event.seq };
  switch (event.kind) {
    case 'message': {
      next.messages = upsert(state.messages, event.data);
      const confirmation = event.data.confirmation;
      if (confirmation !== undefined) {
        if (confirmation.state === 'pending') next.pending = confirmation;
        else if (state.pending?.id === confirmation.id) delete next.pending;
      }
      return { state: next, reload: false };
    }
    case 'status':
      next.status = event.data.status;
      return { state: next, reload: false };
    case 'thread':
      return { state: next, reload: true };
  }
}
