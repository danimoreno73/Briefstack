// Types for the pure functions exported by hook-event.mjs (used by tests).
import type path from 'node:path';
import type { HookEvent } from '../src/events/index.js';

export function isFullyAbsolute(value: string, pathApi?: path.PlatformPath): boolean;
export function briefstackHome(
  env: Readonly<Record<string, string | undefined>>,
  homedir?: string,
  pathApi?: path.PlatformPath,
): string | undefined;
export function toEvent(payload: unknown, now?: Date): HookEvent | undefined;
