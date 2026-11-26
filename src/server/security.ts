import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Request checks for the local web server (BRIEF-phase-2 §4). Pure functions
 * over header values, so they are tested without a socket.
 */

/** The address the server binds to, always in local mode and by default in server mode. */
export const LOOPBACK = '127.0.0.1';

/** Header that carries the per-launch token on every `/api` request. */
export const TOKEN_HEADER = 'x-briefstack-token';

/** A fresh per-launch token: 32 random bytes, base64url. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The hosts a browser may use to reach the server on `port`. */
export function allowedHosts(port: number): string[] {
  return [`${LOOPBACK}:${port}`, `localhost:${port}`];
}

/**
 * DNS rebinding: the `Host` header must name the loopback address and our
 * port, or, in server mode only, one of the configured names (phase 12).
 */
export function isAllowedHost(host: string | undefined, port: number, names: readonly string[] = []): boolean {
  if (host === undefined) return false;
  const value = host.trim().toLowerCase();
  return allowedHosts(port).includes(value) || names.includes(value);
}

/**
 * The origin a page reached at `host` sends: `http://` for the loopback
 * names, `https://` for a configured name, which Tailscale serves over HTTPS
 * (decisions.md, "Phase 12: H0", 1).
 */
export function expectedOrigin(host: string, port: number, names: readonly string[] = []): string {
  const value = host.trim().toLowerCase();
  return !allowedHosts(port).includes(value) && names.includes(value) ? `https://${value}` : `http://${value}`;
}

/** A name for `--allowed-hosts`: a DNS name and a port, lowercase, nothing else. */
const ALLOWED_NAME = /^(?=.{1,253}:)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*:(\d{1,5})$/;

/** `name:port` lowercased, or `undefined` when it is not one (a scheme, a path, a wildcard, a bad port). */
export function parseAllowedName(value: string): string | undefined {
  const name = value.trim().toLowerCase();
  const match = ALLOWED_NAME.exec(name);
  if (match === null) return undefined;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535 ? name : undefined;
}

/** Constant-time comparison of the token header with the launch token. */
export function hasValidToken(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== 'string') return false;
  const given = Buffer.from(header, 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Methods that never change state. Everything else is a mutating request. */
export function isSafeMethod(method: string | undefined): boolean {
  return method === 'GET' || method === 'HEAD';
}

/**
 * CSRF: a mutating request must come from our own origin. `Origin` is
 * required and must match the host the request was sent to; when the browser
 * sends `Sec-Fetch-Site`, it must say `same-origin`.
 */
export function isSameOrigin(
  origin: string | undefined,
  secFetchSite: string | undefined,
  host: string | undefined,
  port: number,
  names: readonly string[] = [],
): boolean {
  if (origin === undefined || host === undefined) return false;
  if (!isAllowedHost(host, port, names)) return false;
  if (origin.trim().toLowerCase() !== expectedOrigin(host, port, names)) return false;
  return secFetchSite === undefined || secFetchSite === 'same-origin';
}

export type Rejection = 'host' | 'token' | 'origin' | 'session';

/**
 * Server mode's part of a request's checks (phase 12): the configured
 * names, whether the request carries a known device session, and whether
 * its route needs none (health, state, sign-in).
 */
export interface ServerCheck {
  names: readonly string[];
  signedIn: boolean;
  open: boolean;
}

export interface RequestHeaders {
  method: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  token: string | string[] | undefined;
}

/**
 * Every check for one request, in order. Static files need only the host
 * check (the page must load before it can read its token); `/api` needs the
 * token, and mutating `/api` calls also need the same-origin check. In
 * server mode a device session stands for the token, which is never
 * accepted there, and a few routes need none (phase 12).
 */
export function checkRequest(
  headers: RequestHeaders,
  options: { port: number; token: string; api: boolean; server?: ServerCheck },
): Rejection | undefined {
  const names = options.server?.names ?? [];
  if (!isAllowedHost(headers.host, options.port, names)) return 'host';
  if (!options.api) return undefined;
  if (options.server === undefined) {
    if (!hasValidToken(headers.token, options.token)) return 'token';
  } else if (!options.server.open && !options.server.signedIn) {
    return 'session';
  }
  if (!isSafeMethod(headers.method) && !isSameOrigin(headers.origin, headers.secFetchSite, headers.host, options.port, names)) {
    return 'origin';
  }
  return undefined;
}
