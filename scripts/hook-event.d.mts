// Types for the pure functions exported by hook-event.mjs (used by tests).
import type path from 'node:path';
import type { EventTarget, HookEvent } from '../src/events/index.js';

export const MAX_TARGET_LENGTH: number;
export function isFullyAbsolute(value: string, pathApi?: path.PlatformPath): boolean;
export function toAbsolute(value: string, homedir?: string, pathApi?: path.PlatformPath): string | undefined;
export function briefstackHome(
  env: Readonly<Record<string, string | undefined>>,
  homedir?: string,
  pathApi?: path.PlatformPath,
): string | undefined;
export function projectsDirOf(config: unknown, homedir?: string, pathApi?: path.PlatformPath): string | undefined;
export type TargetRoots = Partial<Record<'session' | 'projects' | 'repo', string | undefined>>;
export function pathTarget(
  file: unknown,
  roots: TargetRoots,
  pathApi?: path.PlatformPath,
  caseInsensitive?: boolean,
): EventTarget | undefined;
export function cliTarget(command: unknown): EventTarget | undefined;
export function targetOf(
  toolName: unknown,
  toolInput: unknown,
  roots: TargetRoots,
  pathApi?: path.PlatformPath,
  caseInsensitive?: boolean,
): EventTarget | undefined;
export function agentModel(
  repoDir: string | undefined,
  agentType: string | undefined,
  readText?: (file: string) => string,
  pathApi?: path.PlatformPath,
): string | undefined;
export interface HookContext {
  roots?: TargetRoots;
  pathApi?: path.PlatformPath;
  caseInsensitive?: boolean;
  model?: (agentType: string | undefined) => string | undefined;
}
export function toEvent(payload: unknown, now?: Date, context?: HookContext): HookEvent | undefined;
