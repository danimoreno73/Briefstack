import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ChatMessage, ChatSource, ChatStreamEvent, ChatThreadInfo, ChatView, Confirmation } from '../chat/types.js';
import { ApiError, TOKEN_HEADER } from './api.js';
import { applyChatEvent, sourceHref, type ChatPageState } from './chatData.js';
import { Markdown, PathText } from './common.js';
import { formatWhen } from './format.js';
import { useApp, useDocumentTitle, useLoad, useSend } from './hooks.js';
import { IconCheck, IconClose } from './icons.js';
import { ConfirmModal, ErrorNote, LoadState, Loading, Note } from './kit.js';
import { parseSse } from './progress.js';
import { Diff, SuggestionList } from './improve.js';
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
    <p class="cite">
      <span>{t.chatSources}</span>
      {sources.map((source) => {
        const href = sourceHref(source);
        const label = source.label ?? source.ref;
        return href === undefined ? (
          <span key={`${source.kind}-${source.ref}`}>{label}</span>
        ) : (
          <a key={`${source.kind}-${source.ref}`} href={href}>
            {label}
          </a>
        );
      })}
    </p>
  );
}

/**
 * A confirmation card. While it waits for the user it is cream, with Confirm
 * and Decline; once answered it stays in the thread as a quiet card that says
 * Confirmed or Declined (LEEME).
 */
function Card({ confirmation, answer }: { confirmation: Confirmation; answer?: ((decision: 'confirm' | 'decline') => Promise<void>) | undefined }) {
  const { t, lang } = useApp();
  const [busy, setBusy] = useState(false);
  const { card } = confirmation;
  const pending = confirmation.state === 'pending';
  const decide = async (decision: 'confirm' | 'decline') => {
    if (answer === undefined) return;
    setBusy(true);
    try {
      await answer(decision);
    } finally {
      setBusy(false);
    }
  };
  const stateTone = confirmation.state === 'confirmed' ? 'state st-done' : confirmation.state === 'pending' ? 'meta' : 'state st-cancel';
  return (
    <section
      class={pending ? 'dec dec-sm chat-card' : 'card chat-card'}
      role="group"
      aria-label={t.cardTitle}
      data-testid="chat-card"
      data-state={confirmation.state}
      data-kind={card.kind}
    >
      <h3 class="t-3">{t.cardTitle}</h3>
      {card.kind === 'startCreation' && (
        <>
          <p>{t.cardStartCreation}</p>
          <p class="quote" data-testid="card-idea">
            {card.idea}
          </p>
          <p class="t-small muted">{t.cardStartNote(card.profile, card.active, card.limit)}</p>
          {card.usage !== undefined && (
            <Note tone="warn" testId="card-usage-warning">
              {t.cardUsageWarn(card.usage.fiveHour, card.usage.sevenDay)}
            </Note>
          )}
        </>
      )}
      {card.kind === 'startTask' && (
        <>
          <p>{t.cardStartTask(card.project)}</p>
          <p class="quote" data-testid="card-task">
            {card.description}
          </p>
          <p class="t-small muted">{t.taskStartNotes(card.model, card.effort)}</p>
          <p class="t-small muted">{t.cardStartNote(card.profile, card.active, card.limit)}</p>
          {card.uncommitted > 0 && <p class="t-small muted">{t.cardTaskUncommitted(card.uncommitted)}</p>}
          {card.usage !== undefined && (
            <Note tone="warn" testId="card-usage-warning">
              {t.cardUsageWarn(card.usage.fiveHour, card.usage.sevenDay)}
            </Note>
          )}
        </>
      )}
      {card.kind === 'cancelTask' && (
        <>
          <p>{t.cardCancelTask(card.project)}</p>
          <p class="quote">{card.description}</p>
        </>
      )}
      {card.kind === 'cancelCreation' && (
        <>
          <p>{t.cardCancelCreation}</p>
          <p class="quote">{card.idea}</p>
          {card.step !== undefined && <p class="t-small muted">{t.cardCancelStep(t.stepLabel(card.step))}</p>}
        </>
      )}
      {card.kind === 'noteChange' && (
        <>
          <p>{t.cardNoteChange(card.file, card.mode)}</p>
          {/* The page's diff colours: dark in the cream card of the dark theme, light in the dark card of the light one. */}
          <Diff hunks={card.hunks} testId="card-diff" file={{ path: card.file, added: card.added, removed: card.removed }} />
        </>
      )}
      {card.kind === 'usageProfile' && <p>{t.cardUsageProfile(card.from, card.to, card.toLabel[lang])}</p>}
      {card.kind === 'prepareImprovement' && (
        <>
          <p>{t.cardPrepareImprovement(card.model)}</p>
          <p class="quote" data-testid="card-request">
            {card.request}
          </p>
          <p class="t-small muted">{t.cardEvidence(card.sessions.length, card.lessons, card.suggestionId !== undefined)}</p>
          {card.usage !== undefined && (
            <Note tone="warn" testId="card-usage-warning">
              {t.cardUsageWarn(card.usage.fiveHour, card.usage.sevenDay)}
            </Note>
          )}
        </>
      )}
      {card.kind === 'addSkill' && (
        <>
          <p>{t.cardAddSkill}</p>
          <p class="quote mono" data-testid="card-skill-url">
            {card.url}
          </p>
          <p class="t-small muted">
            {t.cardAddSkillSource(card.repo, card.folder)}
            {card.tags.length > 0 && ` · ${card.tags.join(', ')}`}
          </p>
        </>
      )}
      {card.kind === 'addSkillToProject' && (
        <>
          <p>{t.cardAddSkillToProject(card.skill, card.project, card.location)}</p>
          <p class="t-small" data-testid="card-skill-folder">
            {t.cardSkillFolder} <PathText value={card.folder} />
          </p>
          {card.outsideProjects && (
            <p class="t-small" data-testid="card-skill-outside">
              {t.cardSkillOutside}
            </p>
          )}
          <p class="t-small muted">
            {card.license ?? t.skillLicenseNone}
            {card.hasScripts && ` · ${t.cardSkillScripts}`}
          </p>
        </>
      )}
      <p class={stateTone} data-testid="card-state">
        {confirmation.state === 'confirmed' && <IconCheck />}
        {t.cardState(confirmation.state)}
        {confirmation.result !== undefined && `: ${confirmation.result}`}
      </p>
      {confirmation.sources !== undefined && <Sources sources={confirmation.sources} />}
      {pending && answer !== undefined && (
        <div class="btn-row">
          <button type="button" class="btn btn-primary" disabled={busy} onClick={() => void decide('confirm')}>
            {t.cardConfirm}
          </button>
          <button type="button" class="btn btn-secondary" disabled={busy} onClick={() => void decide('decline')}>
            {t.cardDecline}
          </button>
        </div>
      )}
    </section>
  );
}

function Message({ message, answer }: { message: ChatMessage; answer?: ((id: string, decision: 'confirm' | 'decline') => Promise<void>) | undefined }) {
  const { t } = useApp();
  switch (message.role) {
    case 'user':
      return (
        <li class="bubble bubble-user" data-role="user">
          <span class="sr-only">{t.chatYou}: </span>
          <p class="chat-text">{message.text}</p>
        </li>
      );
    case 'assistant':
      return (
        <li class="bubble bubble-bot" data-role="assistant">
          <span class="sr-only">{t.chatClaude}: </span>
          <Markdown text={message.text ?? ''} />
        </li>
      );
    case 'tool':
      return (
        <li class="tool-line" data-role="tool">
          <span>
            {t.chatUsedTool(message.tool?.name ?? '')}
            {message.tool?.summary ? ` (${message.tool.summary})` : ''}
            {message.tool?.error !== undefined && ` · ${t.chatToolFailed} ${message.tool.error}`}
          </span>
          {message.tool !== undefined && <Sources sources={message.tool.sources} />}
        </li>
      );
    case 'confirmation':
      return (
        <li class="thread-item" data-role="confirmation">
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
          <li class="card thread-item" data-role="notice" data-notice="suggestions">
            <p class="strong">{t.chatNoticeSuggestions}</p>
            <SuggestionList suggestions={(message.suggestions ?? []).map((s) => ({ ...s, createdAt: message.ts, params: s.params as SuggestionView['params'] }))} />
          </li>
        );
      }
      return (
        <li class="thread-item" data-role="notice" role="status">
          <Note tone="warn">
            {message.notice === 'resumeFailed' ? t.chatNoticeResumeFailed : t.chatNoticeSessionError}
            {message.detail !== undefined && ` ${message.detail}`}
          </Note>
        </li>
      );
  }
}

/** The thread, kept scrolled to the end. */
function Messages({ messages, answer }: { messages: readonly ChatMessage[]; answer?: (id: string, decision: 'confirm' | 'decline') => Promise<void> }) {
  const { t } = useApp();
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length]);
  if (messages.length === 0) return <p class="muted chat-empty">{t.chatEmpty}</p>;
  return (
    <ol class="thread-list" aria-live="polite" data-testid="chat-messages">
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

  if (state === undefined)
    return (
      <div class="thread" data-testid={compact ? 'chat-drawer-panel' : 'chat-panel'}>
        {chat.error === undefined ? <Loading /> : <ErrorNote error={chat.error} />}
      </div>
    );
  const waitingForCard = state.messages.some((message) => message.role === 'confirmation' && message.confirmation?.state === 'pending');

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
    <div class="chat-panel" data-testid={compact ? 'chat-drawer-panel' : 'chat-panel'}>
      <div class="chat-bar">
        {!compact && state.model !== undefined && <p class="meta">{t.chatModel(state.model.model, state.model.effort)}</p>}
        <button type="button" class="btn btn-ghost btn-sm push-end" onClick={() => setAsking(true)} disabled={state.messages.length === 0}>
          {t.chatNew}
        </button>
      </div>
      <div class="thread">
        {problem !== undefined && <ErrorNote error={problem} />}
        <Messages messages={state.messages} answer={answer} />
        {state.status === 'thinking' && (
          <p role="status" class="thinking" data-testid="chat-thinking">
            <span class="dot pulse" />
            {/* While a card waits, the chat is waiting for the user, not answering (audit M10). */}
            {waitingForCard ? t.chatWaitingCard : t.chatThinking}
          </p>
        )}
      </div>
      <ReplyBox
        id={compact ? 'chat-drawer-input' : 'chat-input'}
        label={t.chatMessageLabel}
        hint={t.chatMessageHint}
        sendLabel={t.chatSend}
        onSend={sendMessage}
        disabled={state.status === 'thinking'}
        rows={compact ? 2 : 2}
        look="composer"
      />
      {asking && (
        <ConfirmModal
          title={t.chatNewTitle}
          body={t.chatNewBody}
          confirmLabel={t.chatNew}
          cancelLabel={t.cancel}
          tone="normal"
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

/** The list beside the thread: the active chat, then the past ones (read-only). */
function ChatList({ current }: { current: string | undefined }) {
  const { t, lang } = useApp();
  const list = useLoad<{ threads: ChatThreadInfo[] }>('/api/chat/threads');
  return (
    <nav class="chat-list" aria-label={t.chatPast}>
      <a class="conv" href={routeHash({ page: 'chat', thread: undefined })} aria-current={current === undefined ? 'true' : undefined}>
        <span>{t.chatActive}</span>
      </a>
      <p class="meta">{t.chatPast}</p>
      <LoadState loaded={list}>
        {({ threads }) => {
          const past = threads.filter((thread) => thread.archivedAt !== undefined);
          if (past.length === 0) return <p class="t-small muted">{t.chatPastEmpty}</p>;
          return (
            <ul class="stack-2" data-testid="chat-past">
              {past.map((thread) => (
                <li key={thread.id}>
                  <a class="conv" href={routeHash({ page: 'chat', thread: thread.id })} aria-current={current === thread.id ? 'true' : undefined}>
                    <span>{thread.title === '' ? t.chatUntitled : thread.title}</span>
                    <span class="meta">{formatWhen(thread.updatedAt, lang)}</span>
                  </a>
                </li>
              ))}
            </ul>
          );
        }}
      </LoadState>
    </nav>
  );
}

function PastChat({ id }: { id: string }) {
  const { t } = useApp();
  const thread = useLoad<{ thread: ChatThreadInfo; messages: ChatMessage[] }>(`/api/chat/threads/${encodeURIComponent(id)}`);
  return (
    <div class="thread">
      <div class="readonly" data-testid="chat-read-only">
        <span>{t.chatReadOnly}</span>
        <a class="btn btn-primary btn-sm" href={routeHash({ page: 'chat', thread: undefined })}>
          {t.chatBackToActive}
        </a>
      </div>
      <LoadState loaded={thread}>
        {(view) => (
          <>
            <h2 class="t-2">{view.thread.title === '' ? t.chatUntitled : view.thread.title}</h2>
            <Messages messages={view.messages} />
          </>
        )}
      </LoadState>
    </div>
  );
}

export function ChatPage({ thread }: { thread: string | undefined }) {
  const { t } = useApp();
  const [version, setVersion] = useState(0);
  useDocumentTitle(t.chatTitle);
  return (
    <>
      <header class="page-head">
        <div class="page-head-text">
          <h1 class="t-1">{t.chatTitle}</h1>
          <p class="lead">{t.chatIntro}</p>
        </div>
      </header>
      <div class="chat">
        <ChatList key={version} current={thread} />
        <div class="chat-main">
          {thread === undefined ? <ChatPanel onNewChat={() => setVersion((value) => value + 1)} /> : <PastChat key={thread} id={thread} />}
        </div>
      </div>
    </>
  );
}

/** What Tab may move to inside the drawer, in order. */
const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The open drawer: a modal dialog over any page. Focus starts on its close
 * button and stays inside it (Tab wraps); Escape or a tap on the dimmed page
 * closes it, and the shell gives focus back to whatever opened it.
 */
export function ChatDrawer({ onClose }: { onClose(): void }) {
  const { t } = useApp();
  const drawer = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // Before the browser paints, so a key pressed at once already lands inside.
  useLayoutEffect(() => {
    closeButton.current?.focus();
  }, []);
  const trap = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || drawer.current === null) return;
    const items = [...drawer.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null);
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <>
      <div class="drawer-scrim" aria-hidden="true" onClick={onClose} />
      <aside
        ref={drawer}
        id="chat-drawer"
        class="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-drawer-title"
        data-testid="chat-drawer"
        onKeyDown={trap}
      >
        <div class="drawer-head">
          <h2 class="t-2" id="chat-drawer-title">
            {t.chatTitle}
          </h2>
          <div class="btn-row">
            <a class="btn btn-ghost btn-sm" href={routeHash({ page: 'chat', thread: undefined })}>
              {t.chatOpenPage}
            </a>
            <button ref={closeButton} type="button" class="btn btn-ghost btn-icon" aria-label={t.chatClose} onClick={onClose}>
              <IconClose />
            </button>
          </div>
        </div>
        <ChatPanel compact />
      </aside>
    </>
  );
}

export type { ChatView };
