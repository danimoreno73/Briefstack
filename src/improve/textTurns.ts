import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Turns of a creation that ended in text (a question asked in plain text,
 * which the web app cannot answer), by session id. They are not in
 * `events.jsonl`; the creation manager counts them in memory and this file
 * keeps them, so an improvement prepared after a server restart still gets
 * them as evidence. `<home>/improve/text-turns.json`, newest first.
 */

export const MAX_TEXT_TURN_SESSIONS = 200;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

interface Entry {
  id: string;
  count: number;
}

const isEntry = (value: unknown): value is Entry => {
  const entry = value as Partial<Entry> | null;
  return typeof entry?.id === 'string' && SESSION_ID_RE.test(entry.id) && typeof entry.count === 'number' && Number.isInteger(entry.count) && entry.count > 0;
};

export class TextTurnStore {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string) {}

  private async list(): Promise<Entry[]> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as { sessions?: unknown };
      return Array.isArray(parsed.sessions) ? parsed.sessions.filter(isEntry) : [];
    } catch {
      return [];
    }
  }

  /** The count kept for a session, or undefined when none is. */
  async count(sessionId: string): Promise<number | undefined> {
    return (await this.list()).find((entry) => entry.id === sessionId)?.count;
  }

  /** Keeps `count` for the session (the manager's own count, so a repeated call changes nothing), first in the list. */
  record(sessionId: string, count: number): Promise<void> {
    if (!SESSION_ID_RE.test(sessionId) || !Number.isInteger(count) || count < 1) return Promise.resolve();
    const next = this.writes.then(async () => {
      const list = [{ id: sessionId, count }, ...(await this.list()).filter((entry) => entry.id !== sessionId)].slice(0, MAX_TEXT_TURN_SESSIONS);
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify({ v: 1, sessions: list }, null, 2)}\n`, 'utf8');
        await rename(temp, this.file);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.writes = next.catch(() => undefined);
    return next;
  }
}
