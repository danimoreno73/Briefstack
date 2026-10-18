/**
 * The global chat (BRIEF-phase-4 §3.1): what is stored, streamed and shown.
 * Every text here has been through the secret redactor before it is kept.
 */

/** Where an answer's data came from, so the user can open it. */
export interface ChatSource {
  kind: 'project' | 'note' | 'session' | 'creation' | 'usage' | 'settings';
  /** A project slug, a note path (`projects/garden.md`), a session or creation id. */
  ref: string;
  label?: string;
}

/** One changed line of a note, for the confirmation card. */
export interface DiffLine {
  op: ' ' | '+' | '-';
  text: string;
}

/** A run of changed lines with a little context; `skipped` unchanged lines come before it. */
export interface DiffHunk {
  skipped: number;
  lines: DiffLine[];
}

/** Exactly what an action will do, shown to the user before it happens. */
export type ConfirmationCard =
  | { kind: 'startCreation'; idea: string; profile: string; active: number; limit: number }
  | { kind: 'cancelCreation'; creationId: string; idea: string; step?: string }
  | {
      kind: 'noteChange';
      section: string;
      name?: string;
      /** Relative path with `/`. */
      file: string;
      /** What `saveNote` will do: a new note, an addition at the end (dated), or a rewrite. */
      mode: 'create' | 'append' | 'rewrite';
      hunks: DiffHunk[];
      added: number;
      removed: number;
    }
  | { kind: 'usageProfile'; from: string; to: string; toLabel: { en: string; es: string } };

/** `stale`: confirmed, but what the card showed no longer held (the note changed), so nothing was done. */
export type ConfirmationState = 'pending' | 'confirmed' | 'declined' | 'failed' | 'expired' | 'stale';

export interface Confirmation {
  id: string;
  tool: string;
  card: ConfirmationCard;
  state: ConfirmationState;
  /** After it ran: a short, redacted line about the error. */
  result?: string;
  /** After it ran: what it made or changed (the new creation, the saved note). */
  sources?: ChatSource[];
}

export type ChatRole = 'user' | 'assistant' | 'tool' | 'confirmation' | 'notice';

/** A notice the chat shows from the server itself, translated by the page. */
export type ChatNotice = 'resumeFailed' | 'sessionError' | 'newThread' | 'suggestions';

/** A suggestion after a creation (phase 5), as a `suggestions` notice carries it. */
export interface ChatSuggestion {
  id: string;
  kind: string;
  creationId: string;
  idea: string;
  target: string;
  params: Record<string, unknown>;
}

export interface ChatMessage {
  /** 1, 2, 3… in the thread. */
  id: number;
  ts: string;
  role: ChatRole;
  /** The user's or Claude's text. */
  text?: string;
  /** A tool the chat used: its name, a short summary of the input, where the data came from. */
  tool?: { name: string; summary: string; sources: ChatSource[]; error?: string };
  confirmation?: Confirmation;
  notice?: ChatNotice;
  /** For `sessionError`: what went wrong, redacted. */
  detail?: string;
  /** For `suggestions`: up to three suggestions after a creation finished. */
  suggestions?: ChatSuggestion[];
}

export interface ChatThreadInfo {
  id: string;
  /** The start of the first user message. */
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Set once "New chat" archived it; archived threads are read-only. */
  archivedAt?: string;
}

export type ChatStatus = 'idle' | 'thinking';

/** The active thread as the page gets it. */
export interface ChatView {
  thread: ChatThreadInfo;
  messages: ChatMessage[];
  status: ChatStatus;
  /** The confirmation waiting for the user, if any (at most one). */
  pending?: Confirmation;
  /** The model and effort the chat runs with (from the usage profile). */
  model?: { model: string; effort: string };
}

interface StreamBase {
  seq: number;
  ts: string;
}

/** The chat's live stream. `message` carries a new or updated message; `thread` means a new chat started. */
export type ChatStreamEvent = StreamBase &
  (
    | { kind: 'message'; data: ChatMessage }
    | { kind: 'status'; data: { status: ChatStatus } }
    | { kind: 'thread'; data: { threadId: string } }
  );

/** What a chat runner reports while it runs. */
export type ChatRunnerEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'turnEnd' }
  /** A resume by session id failed before the session opened. */
  | { kind: 'resumeFailed' }
  | { kind: 'error'; message: string };

/** An MCP tool reply. */
export interface ToolReply {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface ChatRunnerStart {
  /** The SDK session to resume, after a restart or an idle close. */
  resume?: string;
  model: string;
  effort: string;
  /**
   * Runs one chat tool: validation, confirmation, redaction. Both runners
   * call it. `signal` aborts when Claude Code gives up on the call (its
   * timeout); a card still waiting then expires.
   */
  execute(name: string, args: unknown, signal?: AbortSignal): Promise<ToolReply>;
  emit(event: ChatRunnerEvent): void;
}

export interface ChatSession {
  send(text: string): void;
  stop(): Promise<void>;
  /** Settles when the session ended, for any reason. */
  done: Promise<void>;
}

export interface ChatRunner {
  start(options: ChatRunnerStart): ChatSession;
}
