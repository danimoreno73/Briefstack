import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Request checks for the local web server (BRIEF-phase-2 §4). Pure functions
 * over header values, so they are tested without a socket.
 */

/** The only address the server binds to. */
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

/** DNS rebinding: the `Host` header must name the loopback address and our port. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  return allowedHosts(port).includes(host.trim().toLowerCase());
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
): boolean {
  if (origin === undefined || host === undefined) return false;
  if (!isAllowedHost(host, port)) return false;
  if (origin.trim().toLowerCase() !== `http://${host.trim().toLowerCase()}`) return false;
  return secFetchSite === undefined || secFetchSite === 'same-origin';
}

export type Rejection = 'host' | 'token' | 'origin';

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
 * token, and mutating `/api` calls also need the same-origin check.
 */
export function checkRequest(
  headers: RequestHeaders,
  options: { port: number; token: string; api: boolean },
): Rejection | undefined {
  if (!isAllowedHost(headers.host, options.port)) return 'host';
  if (!options.api) return undefined;
  if (!hasValidToken(headers.token, options.token)) return 'token';
  if (!isSafeMethod(headers.method) && !isSameOrigin(headers.origin, headers.secFetchSite, headers.host, options.port)) {
    return 'origin';
  }
  return undefined;
}
