import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { stopTrigger } from '../../src/stopTrigger.js';

describe('stopTrigger', () => {
  it('stops on the first signal and then lets a second one through', async () => {
    const events = new EventEmitter();
    const trigger = stopTrigger(events, () => undefined);
    events.emit('SIGINT');
    expect(await trigger.stopped).toEqual({ crashed: false });
    expect(events.listenerCount('SIGINT') + events.listenerCount('SIGTERM')).toBe(0);
    trigger.release();
    expect(events.listenerCount('uncaughtException') + events.listenerCount('unhandledRejection')).toBe(0);
  });

  it('handles an uncaught exception or an unhandled rejection as a stop, and reports every error until released', async () => {
    const events = new EventEmitter();
    const seen: unknown[] = [];
    const trigger = stopTrigger(events, (error) => seen.push(error));
    const first = new Error('boom');
    events.emit('uncaughtException', first);
    expect(await trigger.stopped).toEqual({ crashed: true });
    events.emit('unhandledRejection', 'later');
    expect(seen).toEqual([first, 'later']);
    trigger.release();
    expect(events.listenerCount('uncaughtException')).toBe(0);
  });

  it('listens to no signal when told not to', () => {
    const events = new EventEmitter();
    stopTrigger(events, () => undefined, false);
    expect(events.listenerCount('SIGINT')).toBe(0);
    expect(events.listenerCount('unhandledRejection')).toBe(1);
  });
});
