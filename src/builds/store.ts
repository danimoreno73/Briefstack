import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BUILD_ID_RE, buildRecordSchema, type BuildRecord } from './types.js';

/**
 * Where builds live under the briefstack home (BRIEF-phase-9):
 *
 *   <home>/builds/<id>/build.json   the record
 *   <home>/builds/<id>/plan/        the planner session's empty working folder
 *   <home>/builds/<id>/cancel-asked the user asked to cancel; the loop has not recorded it yet
 *
 * The tasks a build runs are ordinary tasks under `<home>/tasks/`.
 */

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

export const buildsRoot = (home: string): string => path.join(home, 'builds');

const CANCEL_FILE = 'cancel-asked';

export class BuildStore {
  constructor(readonly root: string) {}

  buildDir(id: string): string {
    if (!BUILD_ID_RE.test(id)) throw new Error(`Not a build id: ${id}`);
    return path.join(this.root, id);
  }

  planDir(id: string): string {
    return path.join(this.buildDir(id), 'plan');
  }

  recordFile(id: string): string {
    return path.join(this.buildDir(id), 'build.json');
  }

  /** Saves the record as it is now; the saves of one build reach the disk in the order they were asked. */
  async save(record: BuildRecord): Promise<void> {
    const parsed = buildRecordSchema.parse(record);
    const text = `${JSON.stringify(parsed, null, 2)}\n`;
    const key = path.resolve(this.recordFile(parsed.id));
    const next = (writing.get(key) ?? Promise.resolve()).then(() => this.write(parsed.id, text));
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    writing.set(key, tail);
    void tail.then(() => {
      if (writing.get(key) === tail) writing.delete(key);
    });
    return next;
  }

  private async write(id: string, text: string): Promise<void> {
    await mkdir(this.buildDir(id), { recursive: true });
    const target = this.recordFile(id);
    const temp = `${target}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    await writeFile(temp, text, 'utf8');
    await retrying(() => rename(temp, target));
  }

  /** The record, or `undefined` when there is none or it does not read back. */
  async load(id: string): Promise<BuildRecord | undefined> {
    if (!BUILD_ID_RE.test(id)) return undefined;
    try {
      const result = buildRecordSchema.safeParse(JSON.parse(await retrying(() => readFile(this.recordFile(id), 'utf8'))));
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The user's cancel, kept in a file of its own (`cancel-asked`) until the
   * loop records it, so a server stop meanwhile leaves the build cancelled
   * (step 33). Not in `build.json`: a write there from the cancel could put
   * an older record over one the loop just saved (review of step 33, B, I1).
   */
  async markCancel(id: string, at: string): Promise<void> {
    await mkdir(this.buildDir(id), { recursive: true });
    await writeFile(path.join(this.buildDir(id), CANCEL_FILE), `${at}\n`, 'utf8');
  }

  async cancelMarked(id: string): Promise<boolean> {
    if (!BUILD_ID_RE.test(id)) return false;
    return readFile(path.join(this.buildDir(id), CANCEL_FILE), 'utf8').then(
      () => true,
      () => false,
    );
  }

  async clearCancel(id: string): Promise<void> {
    await rm(path.join(this.buildDir(id), CANCEL_FILE), { force: true, maxRetries: 5, retryDelay: 50 });
  }

  /** Removes the planner's working folder (it never holds anything the build needs). */
  async removePlanDir(id: string): Promise<void> {
    await rm(this.planDir(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  /** Every build, newest first. Folders without a readable record are skipped. */
  async list(): Promise<BuildRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }
    const records: BuildRecord[] = [];
    for (const name of names) {
      const record = await this.load(name);
      if (record !== undefined) records.push(record);
    }
    return records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
  }
}
