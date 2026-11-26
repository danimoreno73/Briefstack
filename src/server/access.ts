import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { BriefstackError } from '../errors.js';
import { LOOPBACK, parseAllowedName } from './security.js';

/**
 * Server mode (phase 12; PLAN-phase-12 §1, 1 to 3): the address to listen
 * on, the extra host names, and the access secret, read from a file. The
 * secret itself is kept only as its SHA-256 digest; it is never logged,
 * never put in an error, an answer or the page.
 */

/** The shortest access secret a server starts with. */
export const MIN_SECRET_LENGTH = 32;

export interface ServerMode {
  /** The address to listen on: an IP literal. */
  listen: string;
  /** The configured names, `name:port`, lowercase, at least one. */
  names: readonly string[];
  /** SHA-256 of the access secret. */
  secretDigest: Buffer;
  /** The secret file can be read by group or others (Linux and macOS only). */
  secretFileOpen: boolean;
}

export interface ServerModeInput {
  listen?: string;
  /** Comma-separated `name:port` values. */
  allowedHosts?: string;
  secretFile?: string;
}

const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

/** The listening address of `--listen`: an IP literal; the loopback address when absent. */
export function parseListen(value: string | undefined): string {
  if (value === undefined) return LOOPBACK;
  const address = value.trim();
  if (isIP(address) === 0) throw new BriefstackError('server.invalidListen', { value });
  return address;
}

/** The names of `--allowed-hosts`, deduplicated; at least one. */
export function parseAllowedNames(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') throw new BriefstackError('server.noAllowedHosts', {});
  const names: string[] = [];
  for (const part of value.split(',')) {
    const name = parseAllowedName(part);
    if (name === undefined) throw new BriefstackError('server.invalidAllowedHost', { value: part.trim() });
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Reads the access secret: the file's text without its trailing line end,
 * at least `MIN_SECRET_LENGTH` characters. Errors name the file, never what
 * it holds.
 */
export async function readAccessSecret(file: string, platform: NodeJS.Platform = process.platform): Promise<{ digest: Buffer; open: boolean }> {
  let text: string;
  let mode: number;
  try {
    text = await readFile(file, 'utf8');
    mode = (await stat(file)).mode;
  } catch {
    throw new BriefstackError('server.secretUnreadable', { file });
  }
  const secret = text.replace(/\r?\n$/, '');
  if (secret.length < MIN_SECRET_LENGTH || /[\r\n]/.test(secret)) throw new BriefstackError('server.secretTooShort', { file, min: MIN_SECRET_LENGTH });
  return { digest: digest(secret), open: platform !== 'win32' && (mode & 0o077) !== 0 };
}

/** Everything `--server` needs, checked before anything is served. */
export async function serverModeOf(input: ServerModeInput, platform: NodeJS.Platform = process.platform): Promise<ServerMode> {
  const listen = parseListen(input.listen);
  const names = parseAllowedNames(input.allowedHosts);
  if (input.secretFile === undefined) throw new BriefstackError('server.noSecretFile', {});
  const secret = await readAccessSecret(input.secretFile, platform);
  return { listen, names, secretDigest: secret.digest, secretFileOpen: secret.open };
}

/** Constant-time check of a given secret against the digest: both sides are 32-byte digests, whatever the input's length. */
export function matchesSecret(given: string, secretDigest: Buffer): boolean {
  return timingSafeEqual(digest(given), secretDigest);
}
