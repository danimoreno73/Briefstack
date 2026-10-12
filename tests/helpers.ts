import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SpecInput } from '../src/spec/index.js';

/** A minimal valid spec; override fields per test. */
export function specInput(overrides: Partial<SpecInput> = {}): SpecInput {
  return {
    specVersion: 1,
    name: 'Garden planner',
    slug: 'garden-planner',
    summary: 'Plan a vegetable garden across seasons.',
    language: 'en',
    type: 'generic',
    target: 'claude-code',
    profile: 'balanced',
    goal: 'Know what to plant and when.',
    audience: 'A home gardener.',
    deliverables: ['A planting calendar'],
    doneWhen: ['The calendar covers a full year'],
    ...overrides,
  };
}

/** Creates a temp folder and returns it with a cleanup function. */
export async function tempDir(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `briefstack-${prefix}-`));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Writes files given as `{ 'a/b.md': 'content' }` under `root`. */
export async function writeTree(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}
