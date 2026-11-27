import path from 'node:path';

/**
 * Reserve providers (phase 12; PLAN-phase-12 §1, 8): Anthropic-compatible
 * endpoints a build may go on with when the Claude plan's usage is over
 * its threshold. They are configured in `config.json` only: the page shows
 * them and never writes them, since a base URL or a key file set from the
 * page could send a key, or any file the server can read, to another host.
 * The key itself is never in the config: only the path of the file that
 * holds it.
 */

export interface ReserveProvider {
  /** Lowercase letters, digits and `-`; unique. */
  name: string;
  /** `https://` only, no credentials in it. */
  baseUrl: string;
  /** The model a round asks for (and the opus, sonnet and fable aliases). */
  model: string;
  /** The haiku alias and the subagents' model; `model` when absent. */
  smallModel?: string;
  /** Absolute path of the file that holds the key. */
  keyFile: string;
  /** A short note for the page (for example where its data goes). */
  note?: string;
}

export const MAX_RESERVE_PROVIDERS = 8;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;
const MAX_NOTE = 200;
const KNOWN_FIELDS = new Set(['name', 'baseUrl', 'model', 'smallModel', 'keyFile', 'note']);

/** An `https://` address with no user, password, query or fragment, or `undefined`. */
export function providerBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 300) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.hostname === '') return undefined;
  return value.replace(/\/+$/, '');
}

/**
 * The `reserveProviders` field, or `undefined` when it is not a valid
 * list: every entry an object with only the known fields, a valid name
 * (unique), an `https://` base URL, model names, an absolute key file path
 * (on this platform or on Linux, where the server runs), and a short note.
 */
export function parseReserveProviders(value: unknown): ReserveProvider[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_RESERVE_PROVIDERS) return undefined;
  const out: ReserveProvider[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
    const raw = entry as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !KNOWN_FIELDS.has(key))) return undefined;
    const { name, model, smallModel, keyFile, note } = raw;
    const baseUrl = providerBaseUrl(raw.baseUrl);
    if (typeof name !== 'string' || !NAME_RE.test(name) || out.some((other) => other.name === name)) return undefined;
    if (baseUrl === undefined) return undefined;
    if (typeof model !== 'string' || !MODEL_RE.test(model)) return undefined;
    if (smallModel !== undefined && (typeof smallModel !== 'string' || !MODEL_RE.test(smallModel))) return undefined;
    if (typeof keyFile !== 'string' || keyFile.length > 1024 || !(path.isAbsolute(keyFile) || path.posix.isAbsolute(keyFile))) return undefined;
    if (note !== undefined && (typeof note !== 'string' || note.length > MAX_NOTE)) return undefined;
    out.push({ name, baseUrl, model, keyFile, ...(smallModel === undefined ? {} : { smallModel }), ...(note === undefined ? {} : { note }) });
  }
  return out;
}

/** What the page and the API show of a provider: everything but the key, which briefstack never holds. */
export interface ProviderView {
  name: string;
  baseUrl: string;
  model: string;
  smallModel?: string;
  keyFile: string;
  note?: string;
}

export const providerView = (provider: ReserveProvider): ProviderView => ({ ...provider });
