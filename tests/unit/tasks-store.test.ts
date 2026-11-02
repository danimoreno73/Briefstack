import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newTaskId, TaskStore } from '../../src/tasks/store.js';
import { branchOf, type TaskRecord, type TaskState } from '../../src/tasks/types.js';
import { tempDir } from '../helpers.js';

// The saves of one task reach the disk in the order they were asked, so the
// last one asked is what stays (review of step 07, M4).

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir('tasks-store'));
});
afterEach(() => cleanup());

/** A promise the test settles. */
const gate = () => {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};

const record = (id: string, state: TaskState): TaskRecord => ({
  v: 1,
  id,
  project: 'garden',
  projectDir: dir,
  description: 'Do it.',
  profile: 'balanced',
  model: 'sonnet',
  effort: 'medium',
  state,
  baseBranch: 'main',
  baseCommit: 'a'.repeat(40),
  branch: branchOf(id),
  hidden: [],
  createdAt: '2026-11-02T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
  rounds: [],
});

/** A store whose writes each wait for a gate the test opens: `reached[i]` opens when write `i` is about to happen. */
class HeldStore extends TaskStore {
  readonly holds = [gate(), gate(), gate()];
  readonly reached = [gate(), gate(), gate()];
  private writes = 0;

  protected override async write(id: string, text: string): Promise<void> {
    const i = this.writes;
    this.writes += 1;
    this.reached[i]?.open();
    await this.holds[i]?.promise;
    await super.write(id, text);
  }
}

describe('TaskStore: the saves of one task', () => {
  it('reach the disk in the order they were asked, even when the first write is the slower one', async () => {
    const store = new HeldStore(dir);
    const id = newTaskId();
    const first = store.save(record(id, 'running'));
    await store.reached[0]?.promise;
    const second = store.save(record(id, 'interrupted'));
    // Released in the reverse order: the second one first, then the first.
    store.holds[1]?.open();
    await new Promise((resolve) => setTimeout(resolve, 50));
    store.holds[0]?.open();
    await Promise.all([first, second]);
    expect((await store.load(id))?.state).toBe('interrupted');
  });

  it('save what the record was when asked, not what it became while it waited', async () => {
    const store = new HeldStore(dir);
    const id = newTaskId();
    const changing = record(id, 'running');
    const first = store.save(changing);
    await store.reached[0]?.promise;
    const second = store.save(record(id, 'proposal'));
    changing.state = 'failed';
    store.holds[0]?.open();
    await store.reached[1]?.promise;
    expect((await store.load(id))?.state).toBe('running');
    store.holds[1]?.open();
    await Promise.all([first, second]);
    expect((await store.load(id))?.state).toBe('proposal');
  });

  it('go on after a save that failed', async () => {
    const store = new HeldStore(dir);
    store.holds.forEach((hold) => hold.open());
    const id = newTaskId();
    await expect(store.save({ ...record(id, 'running'), state: 'nope' as TaskState })).rejects.toThrow();
    await store.save(record(id, 'proposal'));
    expect((await store.load(id))?.state).toBe('proposal');
  });

  it('do not hold back the saves of another task', async () => {
    const store = new HeldStore(dir);
    const one = newTaskId(new Date('2026-11-02T10:00:00Z'));
    const other = newTaskId(new Date('2026-11-02T11:00:00Z'));
    const held = store.save(record(one, 'running'));
    await store.reached[0]?.promise;
    store.holds[1]?.open();
    await store.save(record(other, 'proposal'));
    expect((await store.load(other))?.state).toBe('proposal');
    store.holds[0]?.open();
    await held;
  });
});
