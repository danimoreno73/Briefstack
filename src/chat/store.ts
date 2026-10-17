import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BriefstackError } from '../errors.js';
import type { ChatMessage, ChatThreadInfo } from './types.js';

/**
 * The chat history under the briefstack home (BRIEF-phase-4 §3.1):
 *
 * - `chat/state.json`: the active thread, every thread's info, and the SDK
 *   session id each one resumes;
 * - `chat/threads/<id>.jsonl`: one message per line. A message that changes
 *   later (a confirmation answered) is written again with the same `id`; the
 *   last line wins.
 *
 * Messages arrive already redacted. Nothing here is ever sent to a model.
 */

export interface ChatThreadRecord extends ChatThreadInfo {
  /** The SDK session the thread resumes; absent before its first answer. */
  sdkSessionId?: string;
}

export interface ChatStoreState {
  v: 1;
  active?: string;
  threads: ChatThreadRecord[];
}

const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isThreadId(value: string): boolean {
  return THREAD_ID_RE.test(value);
}

export class ChatStore {
  constructor(private readonly dir: string) {}

  private get stateFile(): string {
    return path.join(this.dir, 'state.json');
  }

  private threadFile(id: string): string {
    if (!isThreadId(id)) throw new BriefstackError('chat.threadNotFound', { id });
    return path.join(this.dir, 'threads', `${id}.jsonl`);
  }

  async loadState(): Promise<ChatStoreState> {
    let text: string;
    try {
      text = await readFile(this.stateFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, threads: [] };
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as Partial<ChatStoreState>;
      const threads = Array.isArray(parsed.threads)
        ? parsed.threads.filter((thread): thread is ChatThreadRecord => typeof thread?.id === 'string' && isThreadId(thread.id))
        : [];
      const active = typeof parsed.active === 'string' && threads.some((thread) => thread.id === parsed.active) ? parsed.active : undefined;
      return { v: 1, threads, ...(active === undefined ? {} : { active }) };
    } catch {
      // A damaged state file starts a new history; the thread files stay on disk.
      return { v: 1, threads: [] };
    }
  }

  async saveState(state: ChatStoreState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const temp = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temp, this.stateFile);
  }

  async append(threadId: string, message: ChatMessage): Promise<void> {
    const file = this.threadFile(threadId);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(message)}\n`, 'utf8');
  }

  /** The thread's messages in order, each at its latest version. Unreadable lines are skipped. */
  async readThread(threadId: string): Promise<ChatMessage[]> {
    let text: string;
    try {
      text = await readFile(this.threadFile(threadId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const byId = new Map<number, ChatMessage>();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      try {
        const message = JSON.parse(line) as ChatMessage;
        if (typeof message.id === 'number' && typeof message.role === 'string') byId.set(message.id, message);
      } catch {
        // A line cut by a crash: skipped.
      }
    }
    return [...byId.values()].sort((a, b) => a.id - b.id);
  }
}
