import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseFrontmatter } from '../frontmatter/index.js';

const execFileAsync = promisify(execFile);

export const DRIFT_FIELDS = ['model', 'effort'] as const;
export type DriftField = (typeof DRIFT_FIELDS)[number];

export interface DriftItem {
  /** File name inside the agents folder, e.g. `reviewer.md`. */
  file: string;
  field: DriftField;
  /** Value at `HEAD`; undefined when the field is absent there. */
  committed: string | undefined;
  current: string | undefined;
}

export type DriftResult =
  | { status: 'skipped' }
  | {
      status: 'checked';
      drift: DriftItem[];
      /** Files with no committed version to compare against. */
      uncommitted: string[];
    };

async function git(args: readonly string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

function fieldValue(data: Record<string, unknown>, field: DriftField): string | undefined {
  const value = data[field];
  return value === undefined || value === null ? undefined : String(value);
}

/**
 * Compares `model` and `effort` of each agent file with its version at
 * `HEAD`. Skipped (no error) when git is missing, the folder is not in a
 * repo, or the repo has no commits.
 */
export async function checkAgentDrift(agentsDir: string): Promise<DriftResult> {
  let files: string[];
  try {
    files = (await readdir(agentsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { status: 'skipped' };
  }
  if ((await git(['rev-parse', '--verify', '--quiet', 'HEAD'], agentsDir)) === undefined) {
    return { status: 'skipped' };
  }

  const drift: DriftItem[] = [];
  const uncommitted: string[] = [];
  for (const file of files) {
    const target = path.join(agentsDir, file);
    // `./` makes the path relative to `cwd` rather than to the repo root.
    const committedText = await git(['show', `HEAD:./${file}`], agentsDir);
    if (committedText === undefined) {
      uncommitted.push(file);
      continue;
    }
    const committed = parseFrontmatter(committedText, `HEAD:${file}`).data;
    const current = parseFrontmatter(await readFile(target, 'utf8'), target).data;
    for (const field of DRIFT_FIELDS) {
      const before = fieldValue(committed, field);
      const now = fieldValue(current, field);
      if (before !== now) drift.push({ file, field, committed: before, current: now });
    }
  }
  return { status: 'checked', drift, uncommitted };
}
