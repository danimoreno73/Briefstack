import { diffHunks, diffLines } from '../chat/diff.js';
import { redactSecretLines } from '../validate/secrets.js';
import { classifyAsset } from './allowlist.js';
import { checkProposedText, type PreparedContext } from './filters.js';
import { changedFiles, fileAt } from './git.js';
import { lockedBlockProblems } from './locked.js';
import type { ProposalFile, ValidationProblem } from './proposal.js';
import { splitFrontmatter } from './text.js';
import type { Submission } from './types.js';

/**
 * The server's checks on a round (BRIEF-phase-5 §3.3): run on the commit the
 * server made of the worktree, never on what the session says it did.
 * - every changed path is allowlisted (`allowlist.ts`) and was modified, not
 *   added, deleted or renamed, keeps its file mode, and stays plain text;
 * - agent and skill files keep their frontmatter byte for byte;
 * - locked blocks are kept exactly (`locked.ts`);
 * - added lines hold no secret, personal path or profile text (`filters.ts`);
 * - every changed file has a rationale in the submission.
 * The proposal is approvable only with no problem at all.
 */

export interface RoundCheck {
  files: ProposalFile[];
  problems: ValidationProblem[];
}

const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);
const hasBinary = (text: string) => text.includes(NUL) || text.includes(REPLACEMENT);

/** What was in the worktree outside git, listed before the round was committed. */
export interface StrayFiles {
  /** New files the round commit then took in. */
  untracked: readonly string[];
  /** Files git ignores, which the commit leaves out but build and tests would see. */
  ignored: readonly string[];
}

export async function validateRound(params: {
  repoDir: string;
  baseCommit: string;
  head: string;
  stray: StrayFiles;
  submission: Submission | undefined;
  context: PreparedContext;
}): Promise<RoundCheck> {
  const { repoDir, baseCommit, head } = params;
  const problems: ValidationProblem[] = [];
  const files: ProposalFile[] = [];
  const untracked = new Set(params.stray.untracked);
  for (const file of params.stray.untracked) {
    problems.push({ kind: 'notModified', file, detail: 'a new file the session created; only edits of existing files are allowed' });
  }
  for (const file of params.stray.ignored) {
    problems.push({ kind: 'forbiddenPath', file, detail: 'a file git ignores, left in the worktree' });
  }
  const changed = await changedFiles(repoDir, baseCommit, head);
  if (changed.length === 0) problems.push({ kind: 'noChanges', detail: 'the session changed no file' });
  const explained = new Map((params.submission?.changes ?? []).map((change) => [change.file.replaceAll('\\', '/'), change]));

  for (const entry of changed) {
    const asset = classifyAsset(entry.path);
    const base = await fileAt(repoDir, baseCommit, entry.path);
    const proposed = await fileAt(repoDir, head, entry.path);
    const lines = diffLines(base ?? '', proposed ?? '');
    const why = explained.get(entry.path);
    const file: ProposalFile = {
      path: entry.path,
      kind: asset?.kind ?? 'other',
      status: entry.status,
      hunks: diffHunks(lines).map((hunk) => ({ ...hunk, lines: hunk.lines.map((line) => ({ ...line, text: redactSecretLines(line.text) })) })),
      added: lines.filter((line) => line.op === '+').length,
      removed: lines.filter((line) => line.op === '-').length,
      ...(why === undefined ? {} : { rationale: why.rationale, evidence: why.evidence }),
    };
    files.push(file);
    // Already reported as a new file, before the commit.
    if (untracked.has(entry.path)) continue;
    if (asset === undefined) {
      problems.push({ kind: 'forbiddenPath', file: entry.path, detail: 'not a file an improvement may change' });
      continue;
    }
    if (entry.status !== 'modified' || base === undefined || proposed === undefined) {
      problems.push({ kind: 'notModified', file: entry.path, detail: `the file was ${entry.status}; only edits of existing files are allowed` });
      continue;
    }
    if (entry.mode !== entry.baseMode) {
      problems.push({ kind: 'mode', file: entry.path, detail: `the file mode changed from ${entry.baseMode ?? '?'} to ${entry.mode ?? '?'}; only the text may change` });
      continue;
    }
    if (hasBinary(proposed)) {
      problems.push({ kind: 'notText', file: entry.path, detail: 'the file is not plain text' });
      continue;
    }
    file.base = base;
    file.proposed = proposed;
    if (asset.bodyOnly && splitFrontmatter(base).head !== splitFrontmatter(proposed).head) {
      problems.push({ kind: 'frontmatter', file: entry.path, detail: 'the frontmatter changed; only the body may change' });
    }
    for (const detail of lockedBlockProblems(base, proposed)) problems.push({ kind: 'locked', file: entry.path, detail });
    for (const found of checkProposedText(base, proposed, params.context)) problems.push({ kind: found.kind, file: entry.path, line: found.line, detail: found.detail });
    if (why === undefined) problems.push({ kind: 'unexplained', file: entry.path, detail: 'the submission gives no rationale for this file' });
  }
  return { files, problems };
}
