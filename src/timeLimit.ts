/**
 * Waits for `work`, at most `ms`. Resolves `true` when it settled in time
 * (fulfilled or rejected), `false` otherwise. The timer is not `unref`'d: while
 * this waits, the process stays alive, so a top-level `await` never ends as
 * "unsettled" because everything else it waits on let go of the event loop.
 */
export async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true, () => true), limit]);
  } finally {
    clearTimeout(timer);
  }
}
