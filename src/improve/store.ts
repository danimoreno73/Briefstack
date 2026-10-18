import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProposalRecord } from './proposal.js';

/**
 * Where improvements live under the briefstack home:
 *
 *   <home>/improve/proposals/<id>.json   one record per proposal
 *   <home>/improve/<id>/evidence/        what the session read
 *   <home>/improve/<id>/guard.json       the command-hook guard's rules
 *   <home>/improve/worktrees/<id>/       the worktree, while it exists
 *   <home>/improve/suggestions.json      suggestions after creations
 */

export const PROPOSAL_ID_RE = /^imp-[a-z0-9]{6,12}-[a-f0-9]{4}$/;

export function newProposalId(now: Date = new Date()): string {
  return `imp-${now.getTime().toString(36)}-${randomBytes(2).toString('hex')}`;
}

export class ImproveStore {
  constructor(readonly root: string) {}

  get proposalsDir(): string {
    return path.join(this.root, 'proposals');
  }

  proposalDir(id: string): string {
    return path.join(this.root, id);
  }

  evidenceDir(id: string): string {
    return path.join(this.proposalDir(id), 'evidence');
  }

  rulesFile(id: string): string {
    return path.join(this.proposalDir(id), 'guard.json');
  }

  worktreeDir(id: string): string {
    return path.join(this.root, 'worktrees', id);
  }

  get suggestionsFile(): string {
    return path.join(this.root, 'suggestions.json');
  }

  private file(id: string): string {
    if (!PROPOSAL_ID_RE.test(id)) throw new Error(`Not a proposal id: ${id}`);
    return path.join(this.proposalsDir, `${id}.json`);
  }

  async save(record: ProposalRecord): Promise<void> {
    await mkdir(this.proposalsDir, { recursive: true });
    const target = this.file(record.id);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rename(temp, target);
  }

  async load(id: string): Promise<ProposalRecord | undefined> {
    if (!PROPOSAL_ID_RE.test(id)) return undefined;
    try {
      return JSON.parse(await readFile(this.file(id), 'utf8')) as ProposalRecord;
    } catch {
      return undefined;
    }
  }

  /** Every proposal, newest first. Unreadable files are skipped. */
  async list(): Promise<ProposalRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.proposalsDir);
    } catch {
      return [];
    }
    const records: ProposalRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const record = await this.load(name.slice(0, -'.json'.length));
      if (record !== undefined) records.push(record);
    }
    return records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }
}
