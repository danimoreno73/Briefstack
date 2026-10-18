/**
 * When `briefstack web` should stop: on the first SIGINT or SIGTERM, or on
 * an error nothing caught (an uncaught exception or an unhandled
 * rejection). A crash is handled as a stop, so the normal shutdown closes
 * every creation and ends its process tree instead of Node exiting with
 * the trees still running (docs/decisions.md, "If `briefstack web`
 * crashes").
 */

export type StopEvent = 'SIGINT' | 'SIGTERM' | 'uncaughtException' | 'unhandledRejection';

/** What the trigger needs from the process; tests pass an `EventEmitter`. */
export interface StopEvents {
  on(event: StopEvent, listener: (error?: unknown) => void): unknown;
  off(event: StopEvent, listener: (error?: unknown) => void): unknown;
}

export interface StopTrigger {
  /** Resolves on the first stop; `crashed` when an error caused it. */
  stopped: Promise<{ crashed: boolean }>;
  /**
   * Removes the crash listeners. Until then every later error is reported
   * too and does not end the process, so the shutdown can finish.
   */
  release(): void;
}

/**
 * `signals`: whether SIGINT and SIGTERM stop it. Both are removed after the
 * first stop, so a second Ctrl+C ends the process at once, as before.
 * `onCrash` reports each error.
 */
export function stopTrigger(events: StopEvents, onCrash: (error: unknown) => void, signals = true): StopTrigger {
  let resolve!: (value: { crashed: boolean }) => void;
  const stopped = new Promise<{ crashed: boolean }>((done) => (resolve = done));
  const dropSignals = () => {
    events.off('SIGINT', onSignal);
    events.off('SIGTERM', onSignal);
  };
  const onSignal = () => {
    dropSignals();
    resolve({ crashed: false });
  };
  const onError = (error?: unknown) => {
    onCrash(error);
    dropSignals();
    resolve({ crashed: true });
  };
  if (signals) {
    events.on('SIGINT', onSignal);
    events.on('SIGTERM', onSignal);
  }
  events.on('uncaughtException', onError);
  events.on('unhandledRejection', onError);
  return {
    stopped,
    release: () => {
      dropSignals();
      events.off('uncaughtException', onError);
      events.off('unhandledRejection', onError);
    },
  };
}
