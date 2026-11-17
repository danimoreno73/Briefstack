import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BUILD_ID_RE, buildRecordSchema, type BuildRecord } from './types.js';

/**
 * Where builds live under the briefstack home (BRIEF-phase-9):
 *
 *   <home>/builds/<id>/build.json   the record
 *   <home>/builds/<id>/plan/        the planner session's empty working folder
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
