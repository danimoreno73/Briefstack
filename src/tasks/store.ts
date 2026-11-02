import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TASK_ID_RE, taskRecordSchema, type TaskRecord } from './types.js';

/**
 * Where tasks live under the briefstack home (BRIEF-phase-7 §3.2):
 *
 *   <home>/tasks/<id>/task.json    the record
 *   <home>/tasks/<id>/guard.json   the command-hook guard's rules
 *   <home>/tasks/<id>/work/        the worktree, while the task is open
 *
 * The worktree is a folder of its own, so the record and the guard's rules
 * are never inside the folder the session works in, nor in its diff.
 */

/** Windows refuses a rename or read of a file another handle has open for a moment: those are tried again. */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function retrying<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= 40 || !TRANSIENT.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** Per record file, the end of the last write asked for it. */
const writing = new Map<string, Promise<void>>();

export function newTaskId(now: Date = new Date()): string {
  return `${now.getTime().toString(36)}-${randomBytes(2).toString('hex')}`;
}

export const tasksRoot = (home: string): string => path.join(home, 'tasks');

export class TaskStore {
  constructor(readonly root: string) {}

  taskDir(id: string): string {
    if (!TASK_ID_RE.test(id)) throw new Error(`Not a task id: ${id}`);
    return path.join(this.root, id);
  }

  worktreeDir(id: string): string {
    return path.join(this.taskDir(id), 'work');
  }

  rulesFile(id: string): string {
    return path.join(this.taskDir(id), 'guard.json');
  }

  recordFile(id: string): string {
    return path.join(this.taskDir(id), 'task.json');
  }

  /**
   * Saves the record as it is now. The saves of one task reach the disk one
   * at a time, in the order they were asked, so the last one asked is the one
   * that stays (a save nobody waits for cannot land after a later one).
   */
  async save(record: TaskRecord): Promise<void> {
    const parsed = taskRecordSchema.parse(record);
    const text = `${JSON.stringify(parsed, null, 2)}\n`;
    await this.queued(parsed.id, () => this.write(parsed.id, text));
  }

  /** One record's text on disk: written aside, then renamed over the old one. */
  protected async write(id: string, text: string): Promise<void> {
    await mkdir(this.taskDir(id), { recursive: true });
    const target = this.recordFile(id);
    const temp = `${target}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    await writeFile(temp, text, 'utf8');
    await retrying(() => rename(temp, target));
  }

  /** The record, or `undefined` when there is none or it does not read back. */
  async load(id: string): Promise<TaskRecord | undefined> {
    if (!TASK_ID_RE.test(id)) return undefined;
    try {
      const result = taskRecordSchema.safeParse(JSON.parse(await retrying(() => readFile(this.recordFile(id), 'utf8'))));
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Removes a task's folder: only for a task that never started (its start failed). After the saves asked before it. */
  async remove(id: string): Promise<void> {
    const dir = this.taskDir(id);
    await this.queued(id, () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  }

  /** Runs `action` after every write asked before on the same task's record (by its file, so two stores on one folder share it). */
  private queued(id: string, action: () => Promise<void>): Promise<void> {
    const key = path.resolve(this.recordFile(id));
    const next = (writing.get(key) ?? Promise.resolve()).then(action);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    writing.set(key, tail);
    // The last one out leaves no entry behind.
    void tail.then(() => {
      if (writing.get(key) === tail) writing.delete(key);
    });
    return next;
  }

  /** Every task, newest first. Folders without a readable record are skipped. */
  async list(): Promise<TaskRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }
    const records: TaskRecord[] = [];
    for (const name of names) {
      const record = await this.load(name);
      if (record !== undefined) records.push(record);
    }
    return records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
  }
}
