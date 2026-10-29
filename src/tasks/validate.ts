import path from 'node:path';
import { systemPathEnv, type PathEnv } from '../config/paths.js';
import { findAbsolutePaths, findSecrets } from '../validate/index.js';
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
 *   secret or hold an absolute path from this machine.
 *
 * Errors stop the approval; warnings are shown on the proposal page.
 */

const MAX_FINDINGS = 50;
const MAX_SCANNED_FILE_BYTES = 1024 * 1024;

export interface DiffEntry {
  path: string;
  status: string;
  oldMode: string;
  newMode: string;
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
      entries.push({ path: file, status: meta[5] ?? 'M', oldMode: meta[1] ?? '', newMode: meta[2] ?? '', newBlob: meta[4] ?? '' });
    }
    return entries;
  });
}

/** Whether a link target written in a repository leads outside it. */
function linkLeavesRepo(file: string, target: string): boolean {
  if (target === '' || path.posix.isAbsolute(target) || path.win32.isAbsolute(target) || /^[A-Za-z]:/.test(target) || target.startsWith('~')) return true;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target.replaceAll('\\', '/')));
  return resolved === '..' || resolved.startsWith('../');
}

export async function validateTaskDiff(worktree: string, base: string, head: string, pathEnv: PathEnv = systemPathEnv()): Promise<TaskValidation[]> {
  const found: TaskValidation[] = [];
  const add = (item: TaskValidation) => {
    if (found.length < MAX_FINDINGS) found.push(item);
  };
  const entries = await rawDiff(worktree, base, head);
  await withSafeGit(worktree, async (git, run) => {
    const blob = async (sha: string): Promise<string | undefined> => {
      if (/^0+$/.test(sha)) return undefined;
      const size = Number((await run(['cat-file', '-s', sha])).stdout.trim());
      if (!Number.isFinite(size) || size > MAX_SCANNED_FILE_BYTES) return undefined;
      return git(['cat-file', 'blob', sha]);
    };
    for (const entry of entries) {
      const deleted = entry.status === 'D';
      if (entry.newMode === '160000' || entry.oldMode === '160000') add({ kind: 'outsideWorktree', level: 'error', file: entry.path, detail: 'submodule' });
      if (entry.newMode === '120000' && !deleted) {
        const target = (await blob(entry.newBlob)) ?? '';
        if (linkLeavesRepo(entry.path, target)) add({ kind: 'outsideWorktree', level: 'error', file: entry.path, detail: 'link' });
      }
      const protectedReason = protectedProjectFile(entry.path, pathEnv);
      if (protectedReason !== undefined) {
        add({ kind: 'settingsOrHooks', level: 'error', file: entry.path });
        continue;
      }
      if (deleted || entry.newMode === '120000' || entry.newMode === '160000') continue;
      const text = await blob(entry.newBlob);
      if (isDefinitionFile(entry.path, pathEnv) && (text === undefined || declaresHooks(text))) add({ kind: 'settingsOrHooks', level: 'error', file: entry.path, detail: 'hooks' });
      if (text === undefined || text.includes('\0')) continue;
      // Only lines this task added or changed: what was there before is not the task's.
      const patch = await git(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', base, head, '--', entry.path]);
      let secretSeen = false;
      let pathSeen = false;
      for (const line of patch.split(/\r?\n/)) {
        if (!line.startsWith('+') || line.startsWith('+++')) continue;
        const added = line.slice(1);
        if (!secretSeen && findSecrets(added).length > 0) {
          secretSeen = true;
          add({ kind: 'secret', level: 'warning', file: entry.path });
        }
        if (!pathSeen && findAbsolutePaths(added, pathEnv).length > 0) {
          pathSeen = true;
          add({ kind: 'personalPath', level: 'warning', file: entry.path });
        }
        if (secretSeen && pathSeen) break;
      }
    }
  });
  return found;
}
