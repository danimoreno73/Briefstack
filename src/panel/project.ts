import { MAX_TARGET_LENGTH, TARGET_ROOTS, type SessionEvent } from '../events/index.js';
import { redactSecretLines } from '../validate/text.js';
import type { PanelEventInput, PanelTarget } from './state.js';

/**
 * What of a session's lines may leave the server for the panel
 * (BRIEF-phase-3 §5). Only known fields are kept; targets and reasons go
 * through the same secret redaction as the rest of the UI; a path that is
 * absolute (a hand-edited line, a reason quoting a path) is never shown in
 * full.
 */

/** Longest reason shown. */
export const MAX_REASON_LENGTH = 300;
export const OUTSIDE_TEXT = '[outside allowed folders]';

const KEPT_FIELDS = [
  'v',
  'ts',
  'session',
  'source',
  'type',
  'step',
  'outcome',
  'agentId',
  'agentType',
  'tool',
  'toolUseId',
  'effort',
  'model',
  'by',
  'profile',
  'fiveHour',
  'sevenDay',
] as const;

/** A projected line, with its position (1-based) among the file's valid lines as `id`. */
export type PanelEvent = PanelEventInput & { id: number };

/** The rest of a path once its start is found: anything but spaces, quotes and brackets. */
const TAIL = '[^\\s"\'`<>|()\\[\\]{}]*';
/** Top folders that make even a one-segment POSIX path absolute: `/tmp`, `/home`… */
const POSIX_ROOTS = 'tmp|var|Users|home|mnt|opt|etc|usr|root|private|Volumes|srv|media|run|proc|dev|bin|sbin|lib|boot|nix|snap|data|workspace';
const ABSOLUTE_PATH_RE = new RegExp(
  [
    // `file:` URLs are paths (hidden); other URLs come next, so they are skipped as a whole (group 1).
    `[Ff][Ii][Ll][Ee]:${TAIL}`,
    '([A-Za-z][A-Za-z0-9+.-]*://[^\\s<>"\'`]*)',
    // Windows drive paths, with `\`, `/` or JSON-escaped `\\`: `C:\x`, `C:/x`.
    `(?<![\\p{L}\\p{N}_])[A-Za-z]:[\\\\/]${TAIL}`,
    // UNC paths, with either slash: `\\server\share`, `//server/share`.
    `(?<![\\p{L}\\p{N}_:/\\\\])(?:\\\\\\\\|//)[\\p{L}\\p{N}._$-]+[\\\\/]${TAIL}`,
    // POSIX paths with two segments or more (`/a/b`), or one of the usual top folders (`/tmp`).
    // A slash command such as `/add-dir` is one segment and stays.
    `(?<![\\p{L}\\p{N}_.~:/\\\\-])/[\\p{L}\\p{N}._$@+-]+/${TAIL}`,
    `(?<![\\p{L}\\p{N}_.~:/\\\\-])/(?:${POSIX_ROOTS})(?![\\p{L}\\p{N}_.-])`,
  ].join('|'),
  'gu',
);

/**
 * Replaces every absolute path in a text with `OUTSIDE_TEXT`: POSIX paths
 * (`/tmp/x`, `/home/me`, `/Users/me/x`), Windows paths with either slash
 * (`C:\x`, `C:/x`) and UNC paths (`\\server\share`). URLs are left alone,
 * and so is a slash command (`/add-dir`). A sentence's final punctuation
 * stays out of the path.
 */
export function hideAbsolutePaths(text: string): string {
  return text.replace(ABSOLUTE_PATH_RE, (match: string, url: string | undefined) => {
    if (url !== undefined) return match;
    const trailing = /[.,;:!?]+$/.exec(match)?.[0] ?? '';
    return `${OUTSIDE_TEXT}${trailing}`;
  });
}

function clip(text: string, max: number, keepEnd: boolean): string {
  if (text.length <= max) return text;
  return keepEnd ? `…${text.slice(text.length - max + 1)}` : `${text.slice(0, max - 1)}…`;
}

/** A target as the panel may show it: a known root, a redacted relative path, nothing for `outside`. */
export function projectTarget(value: unknown): PanelTarget | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { root, path: rawPath } = value as { root?: unknown; path?: unknown };
  if (typeof root !== 'string' || !(TARGET_ROOTS as readonly string[]).includes(root)) return undefined;
  if (root === 'outside' || typeof rawPath !== 'string' || rawPath === '') return { root: root === 'outside' ? 'outside' : root };
  const redacted = redactSecretLines(rawPath.replace(/[\r\n]+/g, ' '));
  // A relative path never looks absolute; one that does was not written by the hook.
  if (hideAbsolutePaths(redacted) !== redacted || redacted.startsWith('/') || redacted.startsWith('\\')) return { root: 'outside' };
  return { root, path: clip(redacted, MAX_TARGET_LENGTH, true) };
}

/** A guard's reason as the panel may show it. */
export function projectReason(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return clip(hideAbsolutePaths(redactSecretLines(value)), MAX_REASON_LENGTH, false);
}

/** One line of `events.jsonl` as it may leave the server. */
export function projectEvent(event: SessionEvent, id: number): PanelEvent {
  const source = event as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { id };
  for (const field of KEPT_FIELDS) {
    const value = source[field];
    if (typeof value === 'string') out[field] = clip(value, 200, false);
    else if (typeof value === 'number' || value === null) {
      if (field === 'fiveHour' || field === 'sevenDay' || field === 'v') out[field] = value;
    }
  }
  const target = projectTarget(source.target);
  if (target !== undefined) out.target = target;
  // `reason` is a guard's message on `tool.denied`, a short word on `session.end`.
  const reason = event.type === 'tool.denied' ? projectReason(source.reason) : typeof source.reason === 'string' ? clip(source.reason, 32, false) : undefined;
  if (reason !== undefined) out.reason = reason;
  return out as unknown as PanelEvent;
}
