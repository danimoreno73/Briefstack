import type { Lang } from '../i18n/index.js';
import { REDACTED_LINE, redactSecretLines } from '../validate/secrets.js';
import type { SessionSummary } from './types.js';

/**
 * A path in double quotes for a shell. Windows paths cannot hold a quote,
 * so they are wrapped as they are; elsewhere the characters that are special
 * inside double quotes get a backslash.
 */
export function quotePath(value: string): string {
  if (/^(?:[A-Za-z]:|\\\\)/.test(value)) return `"${value}"`;
  return `"${value.replace(/[\\"$`]/g, '\\$&')}"`;
}

/** The two lines that open a project in Claude Code, the path quoted. */
export function openCommandLines(cwd: string, command: string): string[] {
  return [`cd ${quotePath(cwd)}`, command];
}

/** `YYYY-MM-DD` stays as it is; a full timestamp is shown in the viewer's time zone. */
export function formatWhen(value: string | undefined, lang: Lang): string {
  if (value === undefined) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** Creations that did not finish well: interrupted ones and the ones the user cancelled. */
export function isUnfinished(session: SessionSummary): boolean {
  return session.status === 'interrupted' || session.outcome === 'cancelled';
}

export const USAGE_LEVELS = ['saver', 'balanced', 'max'] as const;
export type UsageLevel = (typeof USAGE_LEVELS)[number];

/** Slider position of a profile name, or `undefined` for a custom preset. */
export function levelIndex(profile: string): number | undefined {
  const index = (USAGE_LEVELS as readonly string[]).indexOf(profile);
  return index === -1 ? undefined : index;
}

/** The text with every line that looks like a secret hidden, as the server does. */
export function hideSecrets(text: string): string {
  return redactSecretLines(text);
}

/** Whether the text still has lines the server hid. Saving them back would overwrite the hidden text. */
export function hasHiddenLines(text: string): boolean {
  return text.split('\n').some((line) => line === REDACTED_LINE);
}

/** A note that opens with the same heading as the section it is shown under drops it, so it is not said twice. */
export function withoutLeadingHeading(text: string, heading: string): string {
  const match = /^\s*#{1,6}[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(text);
  return match !== null && match[1]?.trim().toLowerCase() === heading.trim().toLowerCase() ? text.slice(match[0].length) : text;
}

/**
 * A path cut after each `/` or `\`, so a long one wraps between folders, never
 * inside a folder's name. Joined again, the pieces are the path.
 */
export function pathPieces(value: string): string[] {
  return value.split(/(?<=[\\/])/).filter((piece) => piece !== '');
}

/** The note without its leading `---` status block, for the preview. */
export function stripFrontmatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match === null ? text : text.slice(match[0].length);
}
