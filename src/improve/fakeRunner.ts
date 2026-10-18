import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ImprovementRunner, ImproveRunHandle, ImproveRunOutcome, ImproveRunStart, Submission } from './types.js';

/**
 * A scripted improvement runner for tests (BRIEF-phase-5 §5): each round
 * edits files in the worktree and hands in a submission, with no model.
 * It writes straight to disk, past any guard, so tests can also check that
 * the server's validators reject a forbidden edit.
 */

export type FakeEdit =
  /** Replaces the first occurrence of `find` in an existing file. */
  | { file: string; find: string; replace: string }
  /** Writes the whole file (also a new one). */
  | { file: string; text: string };

export interface FakeRound {
  edits?: FakeEdit[];
  submission?: Submission;
  /** The run fails with this error instead. */
  fail?: string;
  /** Waits until `release()` is called before finishing (to test what happens meanwhile). */
  hold?: boolean;
  /** A line the session "says" at the end. */
  text?: string;
}

export interface FakeImproveScript {
  /** One per round, in order; the last one repeats. */
  rounds: FakeRound[];
}

export class FakeImprovementRunner implements ImprovementRunner {
  /** Every start, for tests to inspect. */
  readonly started: ImproveRunStart[] = [];
  private releases: (() => void)[] = [];

  constructor(public script: FakeImproveScript) {}

  /** Lets every held round finish. */
  release(): void {
    const pending = this.releases;
    this.releases = [];
    for (const resolve of pending) resolve();
  }

  start(start: ImproveRunStart): ImproveRunHandle {
    this.started.push(start);
    const round = this.script.rounds[Math.min(this.started.length - 1, this.script.rounds.length - 1)] ?? {};
    let stopped = false;
    let stop: () => void = () => undefined;
    const stoppedPromise = new Promise<void>((resolve) => (stop = resolve));
    const done = (async (): Promise<ImproveRunOutcome> => {
      start.emit({ kind: 'status', status: 'starting' });
      start.emit({ kind: 'status', status: 'running' });
      if (round.hold === true) await Promise.race([new Promise<void>((resolve) => this.releases.push(resolve)), stoppedPromise]);
      if (stopped) return { kind: 'stopped' };
      if (round.fail !== undefined) return { kind: 'failed', error: round.fail };
      for (const edit of round.edits ?? []) {
        const target = path.join(start.worktreeDir, ...edit.file.split('/'));
        if ('text' in edit) await writeFile(target, edit.text, 'utf8');
        else {
          const current = await readFile(target, 'utf8');
          await writeFile(target, current.replace(edit.find, edit.replace), 'utf8');
        }
      }
      if (round.text !== undefined) start.emit({ kind: 'text', text: round.text });
      return round.submission === undefined ? { kind: 'ended' } : { kind: 'ended', submission: round.submission };
    })();
    return {
      done,
      stop: async () => {
        stopped = true;
        stop();
        await done.catch(() => undefined);
      },
    };
  }
}
