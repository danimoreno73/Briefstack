import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ChatMessage, ChatSource, ChatStreamEvent, ChatThreadInfo, ChatView, Confirmation } from '../chat/types.js';
import { ApiError, TOKEN_HEADER } from './api.js';
import { applyChatEvent, sourceHref, type ChatPageState } from './chatData.js';
import { ConfirmDialog, ErrorBanner, Loader, Markdown } from './common.js';
import { formatWhen } from './format.js';
import { useApp, useLoad, useSend } from './hooks.js';
import { parseSse } from './progress.js';
import { SuggestionList } from './improve.js';
import { ReplyBox } from './reply.js';
import { routeHash } from './route.js';
import type { SuggestionView } from './types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The active chat, kept current from its stream; reconnects and reloads after "New chat". */
function useChat() {
  const { token } = useApp();
  const send = useSend();
  const [state, setState] = useState<ChatPageState | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [epoch, setEpoch] = useState(0);
  const reload = useCallback(() => setEpoch((value) => value + 1), []);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      let view: ChatPageState;
      try {
        const res = await fetch('/api/chat', { headers: { [TOKEN_HEADER]: token }, credentials: 'omit', signal: abort.signal });
        const body = (await res.json()) as ChatPageState & { code?: string; params?: Record<string, unknown> };
        if (!res.ok) throw new ApiError(res.status, body.code ?? 'web.unknown', body.params);
        view = body;
        setState(view);
        setError(undefined);
      } catch (failure) {
        if (!abort.signal.aborted) setError(failure);
        return;
      }
      let last = view.seq;
      while (!abort.signal.aborted) {
        try {
          const res = await fetch(`/api/chat/stream?from=${last}`, { headers: { [TOKEN_HEADER]: token }, credentials: 'omit', signal: abort.signal });
          if (!res.ok || res.body === null) throw new Error('stream');
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parsed = parseSse(buffer);
            buffer = parsed.rest;
            const events = parsed.frames.map((frame) => JSON.parse(frame.data ?? 'null') as ChatStreamEvent | null).filter((event): event is ChatStreamEvent => event !== null);
            let mustReload = false;
            setState((previous) => {
              if (previous === undefined) return previous;
              let next = previous;
              for (const event of events) {
                const applied = applyChatEvent(next, event);
                next = applied.state;
                mustReload ||= applied.reload;
              }
              return next;
            });
            const lastEvent = events.at(-1);
            if (lastEvent !== undefined) last = Math.max(last, lastEvent.seq);
            if (mustReload) {
              reload();
              return;
            }
          }
        } catch {
          if (abort.signal.aborted) return;
          await sleep(1000);
        }
      }
    })();
    return () => abort.abort();
  }, [token, epoch, reload]);

  return {
    state,
    error,
    reload,
    sendMessage: (text: string) => send('POST', '/api/chat/messages', { text }),
    confirm: (id: string, decision: 'confirm' | 'decline') => send('POST', `/api/chat/confirmations/${encodeURIComponent(id)}`, { decision }),
    newChat: () => send('POST', '/api/chat/new'),
  };
}

function Sources({ sources }: { sources: readonly ChatSource[] }) {
  const { t } = useApp();
  if (sources.length === 0) return null;
  return (
    <span class="chat-sources">
      {t.chatSources}{' '}
      {sources.map((source, index) => {
        const href = sourceHref(source);
        const label = source.label ?? source.ref;
        return (
          <span key={`${source.kind}-${source.ref}`}>
            {index > 0 && ', '}
            {href === undefined ? label : <a href={href}>{label}</a>}
          </span>
        );
      })}
    </span>
  );
}

function Card({ confirmation, answer }: { confirmation: Confirmation; answer?: ((decision: 'confirm' | 'decline') => Promise<void>) | undefined }) {
  const { t, lang } = useApp();
  const [busy, setBusy] = useState(false);
  const { card } = confirmation;
  const decide = async (decision: 'confirm' | 'decline') => {
    if (answer === undefined) return;
    setBusy(true);
    try {
      await answer(decision);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="chat-card" role="group" aria-label={t.cardTitle} data-testid="chat-card" data-state={confirmation.state} data-kind={card.kind}>
      <strong>{t.cardTitle}</strong>
      {card.kind === 'startCreation' && (
        <>
          <p>{t.cardStartCreation}</p>
          <blockquote data-testid="card-idea">{card.idea}</blockquote>
          <p class="muted">{t.cardStartNote(card.profile, card.active, card.limit)}</p>
        </>
      )}
      {card.kind === 'cancelCreation' && (
        <>
          <p>{t.cardCancelCreation}</p>
          <blockquote>{card.idea}</blockquote>
          {card.step !== undefined && <p class="muted">{t.cardCancelStep(t.stepLabel(card.step))}</p>}
        </>
      )}
      {card.kind === 'noteChange' && (
        <>
          <p>{t.cardNoteChange(card.file, card.mode)}</p>
          <pre class="diff" data-testid="card-diff">
            {card.hunks.flatMap((hunk, index) => [
              ...(hunk.skipped > 0 ? [<span key={`s${index}`} class="diff-skip">{`${t.cardSkipped(hunk.skipped)}\n`}</span>] : []),
              ...hunk.lines.map((line, position) => (
                <span key={`${index}-${position}`} class={line.op === '+' ? 'diff-add' : line.op === '-' ? 'diff-del' : undefined}>
                  {`${line.op} ${line.text}\n`}
                </span>
              )),
            ])}
          </pre>
          <p class="muted">{t.cardNoteCounts(card.added, card.removed)}</p>
        </>
      )}
      {card.kind === 'usageProfile' && <p>{t.cardUsageProfile(card.from, card.to, card.toLabel[lang])}</p>}
      {card.kind === 'prepareImprovement' && (
        <>
          <p>{t.cardPrepareImprovement(card.model)}</p>
          <blockquote data-testid="card-request">{card.request}</blockquote>
          <p class="muted">{t.cardEvidence(card.sessions.length, card.lessons, card.suggestionId !== undefined)}</p>
        </>
      )}
      <p class="chat-card-state" data-testid="card-state">
        {t.cardState(confirmation.state)}
        {confirmation.result !== undefined && `: ${confirmation.result}`}
      </p>
      {confirmation.sources !== undefined && <Sources sources={confirmation.sources} />}
      {confirmation.state === 'pending' && answer !== undefined && (
        <div class="actions">
          <button type="button" class="primary" disabled={busy} onClick={() => void decide('confirm')}>
            {t.cardConfirm}
          </button>
          <button type="button" disabled={busy} onClick={() => void decide('decline')}>
            {t.cardDecline}
          </button>
        </div>
      )}
    </div>
  );
}

function Message({ message, answer }: { message: ChatMessage; answer?: ((id: string, decision: 'confirm' | 'decline') => Promise<void>) | undefined }) {
  const { t } = useApp();
  switch (message.role) {
    case 'user':
      return (
        <li class="chat-msg chat-user" data-role="user">
          <span class="chat-who">{t.chatYou}</span>
          <p class="chat-text">{message.text}</p>
        </li>
      );
    case 'assistant':
      return (
        <li class="chat-msg chat-assistant" data-role="assistant">
          <span class="chat-who">{t.chatClaude}</span>
          <Markdown text={message.text ?? ''} />
        </li>
      );
    case 'tool':
      return (
        <li class="chat-msg chat-tool muted" data-role="tool">
          {t.chatUsedTool(message.tool?.name ?? '')}
          {message.tool?.summary ? ` (${message.tool.summary})` : ''}
          {message.tool?.error !== undefined && ` · ${t.chatToolFailed} ${message.tool.error}`}{' '}
          {message.tool !== undefined && <Sources sources={message.tool.sources} />}
        </li>
      );
    case 'confirmation':
      return (
        <li class="chat-msg" data-role="confirmation">
          {message.confirmation !== undefined && (
            <Card
              confirmation={message.confirmation}
              answer={answer === undefined || message.confirmation === undefined ? undefined : (decision) => answer((message.confirmation as Confirmation).id, decision)}
            />
          )}
        </li>
      );
    case 'notice':
      if (message.notice === 'suggestions') {
        return (
          <li class="chat-msg chat-notice" data-role="notice" data-notice="suggestions">
            <p>{t.chatNoticeSuggestions}</p>
            <SuggestionList suggestions={(message.suggestions ?? []).map((s) => ({ ...s, createdAt: message.ts, params: s.params as SuggestionView['params'] }))} />
          </li>
        );
      }
      return (
        <li class="chat-msg chat-notice" data-role="notice" role="status">
          {message.notice === 'resumeFailed' ? t.chatNoticeResumeFailed : t.chatNoticeSessionError}
          {message.detail !== undefined && ` ${message.detail}`}
        </li>
      );
  }
}

/** The list of messages, kept scrolled to the end. */
function Messages({ messages, answer }: { messages: readonly ChatMessage[]; answer?: (id: string, decision: 'confirm' | 'decline') => Promise<void> }) {
  const { t } = useApp();
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length]);
  if (messages.length === 0) return <p class="empty">{t.chatEmpty}</p>;
  return (
    <ol class="chat-messages" aria-live="polite" data-testid="chat-messages">
      {messages.map((message) => (
        <Message key={message.id} message={message} answer={answer} />
      ))}
      <li ref={end} aria-hidden="true" class="chat-end" />
    </ol>
  );
}

/** The active chat: messages, the waiting card, the box. Used by the page and by the drawer. */
export function ChatPanel({ compact = false, onNewChat }: { compact?: boolean; onNewChat?: () => void }) {
  const { t } = useApp();
  const chat = useChat();
  const [problem, setProblem] = useState<unknown>(undefined);
  const [asking, setAsking] = useState(false);
  const state = chat.state;

  if (state === undefined) return chat.error === undefined ? <p role="status">{t.loading}</p> : <ErrorBanner error={chat.error} />;

  const answer = async (id: string, decision: 'confirm' | 'decline') => {
    setProblem(undefined);
    try {
      await chat.confirm(id, decision);
    } catch (failure) {
      setProblem(failure);
      chat.reload();
    }
  };
  const sendMessage = async (text: string): Promise<boolean> => {
    setProblem(undefined);
    try {
      await chat.sendMessage(text);
      return true;
    } catch (failure) {
      setProblem(failure);
      return false;
    }
  };

  return (
    <div class={compact ? 'chat chat-compact' : 'chat'} data-testid={compact ? 'chat-drawer-panel' : 'chat-panel'}>
      {!compact && state.model !== undefined && <p class="muted">{t.chatModel(state.model.model, state.model.effort)}</p>}
      {problem !== undefined && <ErrorBanner error={problem} />}
      <Messages messages={state.messages} answer={answer} />
      {state.status === 'thinking' && (
        <p role="status" class="muted" data-testid="chat-thinking">
          {t.chatThinking}
        </p>
      )}
      <ReplyBox
        id={compact ? 'chat-drawer-input' : 'chat-input'}
        label={t.chatMessageLabel}
        hint={t.chatMessageHint}
        sendLabel={t.chatSend}
        onSend={sendMessage}
        disabled={state.status === 'thinking'}
        rows={compact ? 2 : 3}
      />
      <div class="actions">
        <button type="button" onClick={() => setAsking(true)} disabled={state.messages.length === 0}>
          {t.chatNew}
        </button>
        {compact && <a href={routeHash({ page: 'chat', thread: undefined })}>{t.chatOpenPage}</a>}
      </div>
      {asking && (
        <ConfirmDialog
          title={t.chatNewTitle}
          body={t.chatNewBody}
          confirmLabel={t.chatNew}
          onConfirm={() => {
            setAsking(false);
            chat.newChat().then(
              () => {
                chat.reload();
                onNewChat?.();
              },
              (failure: unknown) => setProblem(failure),
            );
          }}
          onCancel={() => setAsking(false)}
        />
      )}
    </div>
  );
}

function PastChats() {
  const { t, lang } = useApp();
  const list = useLoad<{ threads: ChatThreadInfo[] }>('/api/chat/threads');
  return (
    <>
      <h2>{t.chatPast}</h2>
      <Loader loaded={list}>
        {({ threads }) => {
          const past = threads.filter((thread) => thread.archivedAt !== undefined);
          if (past.length === 0) return <p class="empty">{t.chatPastEmpty}</p>;
          return (
            <ul data-testid="chat-past">
              {past.map((thread) => (
                <li key={thread.id}>
                  <a href={routeHash({ page: 'chat', thread: thread.id })}>{thread.title === '' ? t.chatUntitled : thread.title}</a>{' '}
                  <span class="muted">· {formatWhen(thread.updatedAt, lang)}</span>
                </li>
              ))}
            </ul>
          );
        }}
      </Loader>
    </>
  );
}

function PastChat({ id }: { id: string }) {
  const { t } = useApp();
  const thread = useLoad<{ thread: ChatThreadInfo; messages: ChatMessage[] }>(`/api/chat/threads/${encodeURIComponent(id)}`);
  return (
    <section>
      <h1>{t.chatTitle}</h1>
      <p class="muted" data-testid="chat-read-only">
        {t.chatReadOnly} <a href={routeHash({ page: 'chat', thread: undefined })}>{t.chatBackToActive}</a>
      </p>
      <Loader loaded={thread}>
        {(view) => (
          <>
            <h2>{view.thread.title === '' ? t.chatUntitled : view.thread.title}</h2>
            <Messages messages={view.messages} />
          </>
        )}
      </Loader>
    </section>
  );
}

export function ChatPage({ thread }: { thread: string | undefined }) {
  const { t } = useApp();
  const [version, setVersion] = useState(0);
  if (thread !== undefined) return <PastChat key={thread} id={thread} />;
  return (
    <section>
      <h1>{t.chatTitle}</h1>
      <p>{t.chatIntro}</p>
      <ChatPanel onNewChat={() => setVersion((value) => value + 1)} />
      <PastChats key={version} />
    </section>
  );
}

/** The compact chat on every page: a button that opens a side panel. */
export function ChatDrawer() {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    // Back to where the user was.
    setTimeout(() => opener.current?.focus(), 0);
  };
  return (
    <>
      <button ref={opener} type="button" class="chat-toggle" aria-expanded={open} aria-controls="chat-drawer" onClick={() => setOpen(true)} hidden={open}>
        {t.chatOpen}
      </button>
      {open && (
        <aside
          id="chat-drawer"
          class="chat-drawer"
          aria-label={t.chatTitle}
          data-testid="chat-drawer"
          onKeyDown={(event) => {
            if (event.key === 'Escape') close();
          }}
        >
          <div class="chat-drawer-head">
            <strong>{t.chatTitle}</strong>
            <button type="button" onClick={close}>
              {t.chatClose}
            </button>
          </div>
          <ChatPanel compact />
        </aside>
      )}
    </>
  );
}

export type { ChatView };
