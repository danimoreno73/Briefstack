import path from 'node:path';
import { BriefstackError } from '../errors.js';

/**
 * The longest full path a skill file may get where it is written (the
 * library, its staging folder, a project). Windows without long-path
 * support stops at 260 characters, and git there too; checking first gives
 * a clear error before anything is written instead of a half-written copy.
 */
export const MAX_TARGET_PATH = 250;

/** Throws `skills.pathTooLong` when any file would land on a path longer than `limit` under `base`. */
export function assertPathsFit(base: string, files: readonly { path: string }[], limit: number = MAX_TARGET_PATH): void {
  for (const file of files) {
    const full = path.join(base, ...file.path.split('/'));
    if (full.length > limit) throw new BriefstackError('skills.pathTooLong', { path: file.path.slice(0, 200), length: full.length, limit });
  }
}
