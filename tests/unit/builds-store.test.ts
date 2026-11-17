import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuildStore, buildsRoot } from '../../src/builds/store.js';
import { buildRecordSchema, integrationBranchOf, planOutputSchema, queueItemSchema, type BuildRecord } from '../../src/builds/types.js';
import { taskRecordSchema } from '../../src/tasks/types.js';
import { tempDir } from '../helpers.js';

// Builds (BRIEF-phase-9): the record, the queue's schema and the store.

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('builds-store'));
});
afterEach(() => cleanup());

const AT = '2026-11-17T22:00:00.000Z';

function record(id: string, createdAt = AT): BuildRecord {
  return {
    v: 1,
    id,
    project: 'garden',
    projectDir: path.join(dir, 'garden'),
    state: 'planning',
    profile: 'saver',
    model: 'sonnet',
    effort: 'low',
    createdAt,
    updatedAt: createdAt,
    branch: integrationBranchOf(id),
    tasks: [],
    roundsRun: 0,
  };
}

const item = { title: 'Set up', instruction: 'Create the package.', doneWhen: 'npm test passes.', dependsOn: [] };

describe('the queue schema', () => {
  it('takes a plain item and trims its text', () => {
    expect(queueItemSchema.parse({ ...item, title: '  Set up  ' }).title).toBe('Set up');
  });

  it('refuses empty text, unknown fields, too many items and dependencies out of range', () => {
    expect(queueItemSchema.safeParse({ ...item, title: ' ' }).success).toBe(false);
    expect(queueItemSchema.safeParse({ ...item, extra: 1 }).success).toBe(false);
    expect(queueItemSchema.safeParse({ ...item, dependsOn: [0] }).success).toBe(false);
    expect(queueItemSchema.safeParse({ ...item, dependsOn: [1.5] }).success).toBe(false);
    expect(planOutputSchema.safeParse({ tasks: [], commands: [], checks: [] }).success).toBe(false);
    expect(planOutputSchema.safeParse({ tasks: Array.from({ length: 21 }, () => item), commands: [], checks: [] }).success).toBe(false);
    expect(planOutputSchema.safeParse({ tasks: [item], commands: ['x'.repeat(501)], checks: [] }).success).toBe(false);
    expect(planOutputSchema.safeParse({ tasks: [item], commands: ['npm test'], checks: ['npm test'] }).success).toBe(true);
  });
});

describe('the task record keeps its build', () => {
  it('reads an older record without one, and keeps one when set', () => {
    const base = {
      v: 1,
      id: 'mabc12-0a0b',
      project: 'garden',
      projectDir: dir,
      description: 'x',
      profile: 'saver',
      model: 'sonnet',
      effort: 'low',
      state: 'running',
      baseBranch: 'main',
      baseCommit: 'a'.repeat(40),
      branch: 'briefstack/task-mabc12-0a0b',
      hidden: [],
      createdAt: AT,
      updatedAt: AT,
      rounds: [],
    };
    expect(taskRecordSchema.parse(base).build).toBeUndefined();
    expect(taskRecordSchema.parse({ ...base, build: { id: 'mabc13-0a0b', n: 2 } }).build).toEqual({ id: 'mabc13-0a0b', n: 2 });
    expect(taskRecordSchema.safeParse({ ...base, build: { id: '../x', n: 2 } }).success).toBe(false);
  });
});

describe('BuildStore', () => {
  it('saves, loads and lists newest first; a broken record is skipped', async () => {
    const store = new BuildStore(buildsRoot(dir));
    await store.save(record('mabc12-0a0b', '2026-11-17T20:00:00.000Z'));
    await store.save(record('mabc13-0a0b', '2026-11-17T21:00:00.000Z'));
    expect(JSON.parse(await readFile(store.recordFile('mabc13-0a0b'), 'utf8')).state).toBe('planning');
    expect((await store.load('mabc12-0a0b'))?.branch).toBe('briefstack/build-mabc12-0a0b');
    expect((await store.list()).map((build) => build.id)).toEqual(['mabc13-0a0b', 'mabc12-0a0b']);
    await writeFile(store.recordFile('mabc12-0a0b'), '{ not json', 'utf8');
    expect(await store.load('mabc12-0a0b')).toBeUndefined();
    expect((await store.list()).map((build) => build.id)).toEqual(['mabc13-0a0b']);
  });

  it('refuses ids that are not build ids, and a record that breaks the schema', async () => {
    const store = new BuildStore(buildsRoot(dir));
    expect(() => store.buildDir('../outside')).toThrow();
    expect(await store.load('../outside')).toBeUndefined();
    await expect(store.save({ ...record('mabc12-0a0b'), state: 'flying' as never })).rejects.toThrow();
  });

  it('keeps the last of many saves asked at once', async () => {
    const store = new BuildStore(buildsRoot(dir));
    const base = record('mabc12-0a0b');
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.save({ ...base, roundsRun: i })));
    expect((await store.load(base.id))?.roundsRun).toBe(19);
    expect(buildRecordSchema.parse(await store.load(base.id)).id).toBe(base.id);
  });
});
