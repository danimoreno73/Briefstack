import { diffHunks, diffLines } from '../chat/diff.js';
import type { DiffHunk } from '../chat/types.js';
import { redactSecretLines } from '../validate/secrets.js';
import { withSafeGit } from './git.js';
import { rawDiff } from './validate.js';

/**
 * The proposal page's diff (BRIEF-phase-7 §3.4): each changed file from the
 * task's base commit to its branch, as line hunks with secrets hidden. Read
 * from the project's repository with git; nothing of the project runs.
 */

export interface ProposalFileDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'other';
  added: number;
  removed: number;
  hunks: DiffHunk[];
  /** Binary, a link, a submodule or too large to show: only its name and status. */
  shown: boolean;
}

export interface ProposalDiff {
  files: ProposalFileDiff[];
  /** More files changed than the page lists. */
  more: number;
}

const MAX_FILES = 200;
const MAX_FILE_BYTES = 256 * 1024;

const statusOf = (letter: string): ProposalFileDiff['status'] => (letter === 'A' ? 'added' : letter === 'M' ? 'modified' : letter === 'D' ? 'deleted' : 'other');

export async function proposalDiff(repoDir: string, base: string, head: string): Promise<ProposalDiff> {
  const entries = await rawDiff(repoDir, base, head);
  const files: ProposalFileDiff[] = [];
  await withSafeGit(repoDir, async (git, run) => {
    const text = async (rev: string, file: string): Promise<string | undefined> => {
      const size = await run(['cat-file', '-s', `${rev}:${file}`]);
      if (size.code !== 0) return '';
      if (Number(size.stdout.trim()) > MAX_FILE_BYTES) return undefined;
      const body = await git(['cat-file', 'blob', `${rev}:${file}`]);
      return body.includes('\0') ? undefined : body;
    };
    for (const entry of entries.slice(0, MAX_FILES)) {
      const status = statusOf(entry.status);
      const special = [entry.oldMode, entry.newMode].some((mode) => mode === '120000' || mode === '160000');
      const before = special || status === 'added' ? '' : await text(base, entry.path);
      const after = special || status === 'deleted' ? '' : await text(head, entry.path);
      if (special || before === undefined || after === undefined) {
        files.push({ path: entry.path, status, added: 0, removed: 0, hunks: [], shown: false });
        continue;
      }
      const lines = diffLines(before, after);
      files.push({
        path: entry.path,
        status,
        added: lines.filter((line) => line.op === '+').length,
        removed: lines.filter((line) => line.op === '-').length,
        hunks: diffHunks(lines).map((hunk) => ({ ...hunk, lines: hunk.lines.map((line) => ({ ...line, text: redactSecretLines(line.text) })) })),
        shown: true,
      });
    }
  });
  return { files, more: Math.max(0, entries.length - MAX_FILES) };
}
