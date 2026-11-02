import path from 'node:path';
import { systemPathEnv, type PathEnv } from '../config/paths.js';
import { findAbsolutePaths, findSecrets } from '../validate/index.js';
import { parseFrontmatter } from '../frontmatter/index.js';
import { maskSecretValues, REDACTED_LINE } from '../validate/secrets.js';
import { declaresHooks, isDefinitionFile, protectedProjectFile } from './guard.js';
import { withSafeGit } from './git.js';
import type { TaskValidation } from './types.js';

/**
 * The server's checks of a task's diff (BRIEF-phase-7 §3.4), from the base
 * commit to the branch's last commit, read with git, never with the model:
 *
 * - `outsideWorktree` (error): a link that leads out of the project, or a
 *   submodule;
 * - `settingsOrHooks` (error): a change to `.claude/settings*.json`,
 *   `.mcp.json` or a hook file, or a skill, command or agent that would
 *   declare hooks;
 * - `secret` and `personalPath` (warnings): added lines that look like a
 *   secret or hold an absolute path from this machine;
 * - `notShown` (warning, decisions.md S10): a file the proposal page lists
 *   by name only, being over `SHOWN_MAX_BYTES` (`large`), binary
 *   (`binary`) or a link that stays in the project (`link`).
 *
 * Errors stop the approval; warnings are shown on the proposal page.
 */

const MAX_FINDINGS = 50;
const MAX_SCANNED_FILE_BYTES = 1024 * 1024;
/** The largest file the proposal page shows; a larger one is listed by name only (proposal.ts). */
export const SHOWN_MAX_BYTES = 256 * 1024;

const LINK_MODE = '120000';
const SUBMODULE_MODE = '160000';

export interface DiffEntry {
  path: string;
  status: string;
  oldMode: string;
  newMode: string;
  oldBlob: string;
  newBlob: string;
}

/** `git diff --raw` between two commits, renames as delete and add. */
export async function rawDiff(dir: string, from: string, to: string): Promise<DiffEntry[]> {
  return withSafeGit(dir, async (git) => {
    const raw = await git(['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', from, to]);
    const parts = raw.split('\0');
    const entries: DiffEntry[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/.exec(parts[i] ?? '');
      const file = parts[i + 1];
      if (meta === null || file === undefined) continue;
      entries.push({ path: file, status: meta[5] ?? 'M', oldMode: meta[1] ?? '', newMode: meta[2] ?? '', oldBlob: meta[3] ?? '', newBlob: meta[4] ?? '' });
    }
    return entries;
  });
}

/** `.claude/agents/**.md` at any depth. */
const isAgentFile = (file: string): boolean => /(^|\/)\.claude\/agents\/.+\.md$/i.test(file);

/** An agent that starts MCP servers or sets a permission mode other than `default` or `plan` (as a task's start refuses: session.ts). */
function agentWidens(text: string): boolean {
  try {
    const { data } = parseFrontmatter(text, 'agent');
    const mode = data.permissionMode;
    return data.mcpServers !== undefined || (mode !== undefined && mode !== 'default' && mode !== 'plan');
  } catch {
    return true;
  }
}

/** Whether a link target written in a repository leads outside it. */
function linkLeavesRepo(file: string, target: string): boolean {
  if (target === '' || path.posix.isAbsolute(target) || path.win32.isAbsolute(target) || /^[A-Za-z]:/.test(target) || target.startsWith('~')) return true;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target.replaceAll('\\', '/')));
  return resolved === '..' || resolved.startsWith('../');
}

export async function validateTaskDiff(worktree: string, base: string, head: string, pathEnv: PathEnv = systemPathEnv()): Promise<TaskValidation[]> {
  const found: TaskValidation[] = [];
  // Errors and warnings are capped apart, so many warnings never push out an error that stops the approval.
  const counts = { error: 0, warning: 0 };
  const add = (item: TaskValidation) => {
    if (counts[item.level] >= MAX_FINDINGS) return;
    counts[item.level] += 1;
    found.push(item);
  };
  const entries = await rawDiff(worktree, base, head);
  await withSafeGit(worktree, async (git, run) => {
    const blob = async (sha: string): Promise<string | undefined> => {
      if (/^0+$/.test(sha)) return undefined;
      const size = Number((await run(['cat-file', '-s', sha])).stdout.trim());
      if (!Number.isFinite(size) || size > MAX_SCANNED_FILE_BYTES) return undefined;
      return git(['cat-file', 'blob', sha]);
    };
    /** Why the proposal page cannot show one side of a file, as proposal.ts decides it. */
    const unshown = async (sha: string): Promise<'large' | 'binary' | undefined> => {
      if (/^0+$/.test(sha)) return undefined;
      const size = await run(['cat-file', '-s', sha]);
      if (size.code !== 0) return undefined;
      if (Number(size.stdout.trim()) > SHOWN_MAX_BYTES) return 'large';
      return (await git(['cat-file', 'blob', sha])).includes('\0') ? 'binary' : undefined;
    };
    for (const entry of entries) {
      const deleted = entry.status === 'D';
      const submodule = entry.newMode === SUBMODULE_MODE || entry.oldMode === SUBMODULE_MODE;
      const link = entry.newMode === LINK_MODE || entry.oldMode === LINK_MODE;
      if (submodule) add({ kind: 'outsideWorktree', level: 'error', file: entry.path, detail: 'submodule' });
      let leaves = false;
      if (entry.newMode === LINK_MODE && !deleted) {
        const target = (await blob(entry.newBlob)) ?? '';
        leaves = linkLeavesRepo(entry.path, target);
        if (leaves) add({ kind: 'outsideWorktree', level: 'error', file: entry.path, detail: 'link' });
      }
      // S10: the page lists this file by name only. A submodule or a link that leads out is already refused.
      if (link && !submodule && !leaves) add({ kind: 'notShown', level: 'warning', file: entry.path, detail: 'link' });
      else if (!link && !submodule) {
        const sides = [entry.status === 'A' ? undefined : await unshown(entry.oldBlob), deleted ? undefined : await unshown(entry.newBlob)];
        const reason = sides.includes('large') ? 'large' : sides.includes('binary') ? 'binary' : undefined;
        if (reason !== undefined) add({ kind: 'notShown', level: 'warning', file: entry.path, detail: reason });
      }
      const protectedReason = protectedProjectFile(entry.path, pathEnv);
      if (protectedReason !== undefined) {
        add({ kind: 'settingsOrHooks', level: 'error', file: entry.path });
        continue;
      }
      if (deleted || entry.newMode === LINK_MODE || entry.newMode === SUBMODULE_MODE) continue;
      const text = await blob(entry.newBlob);
      if (isDefinitionFile(entry.path, pathEnv) && (text === undefined || declaresHooks(text))) add({ kind: 'settingsOrHooks', level: 'error', file: entry.path, detail: 'hooks' });
      else if (text !== undefined && isAgentFile(entry.path) && agentWidens(text)) add({ kind: 'settingsOrHooks', level: 'error', file: entry.path, detail: 'agent' });
      if (text === undefined || text.includes('\0')) continue;
      // Only lines this task added or changed: what was there before is not the task's.
      const patch = await git(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', base, head, '--', entry.path]);
      let secretSeen = false;
      let pathSeen = false;
      let hiddenSeen = false;
      for (const line of patch.split(/\r?\n/)) {
        if (!line.startsWith('+') || line.startsWith('+++')) continue;
        const added = line.slice(1);
        const secret = findSecrets(added).length > 0;
        if (secret && !secretSeen) {
          secretSeen = true;
          add({ kind: 'secret', level: 'warning', file: entry.path });
        }
        // The page hides a secret's value; a line it must hide whole would be approved unseen.
        if (secret && !hiddenSeen && maskSecretValues(added) === REDACTED_LINE) {
          hiddenSeen = true;
          add({ kind: 'hiddenLine', level: 'error', file: entry.path });
        }
        if (!pathSeen && findAbsolutePaths(added, pathEnv).length > 0) {
          pathSeen = true;
          add({ kind: 'personalPath', level: 'warning', file: entry.path });
        }
        if (pathSeen && hiddenSeen) break;
      }
    }
  });
  return found;
}
