/** Talks to the local server. The launch token comes in the URL fragment once. */

import { ApiError } from './apiError.js';

export { ApiError };

export const TOKEN_HEADER = 'x-briefstack-token';
const STORAGE_KEY = 'briefstack-token';

/** Reads `#token=…` once, keeps it for this tab and removes it from the address bar. */
export function takeToken(): string | undefined {
  const match = /(?:^#|&)token=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (match?.[1] !== undefined) {
    try {
      sessionStorage.setItem(STORAGE_KEY, match[1]);
    } catch {
      // Storage may be unavailable; the token still works for this page load.
    }
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return match[1];
  }
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Sent on `window` when the server refuses this tab's token: briefstack was restarted with a new one. */
export const TOKEN_REJECTED_EVENT = 'briefstack:token-rejected';

/** Sent on `window` when a creation page sees its creation change status, so the menu's count is read again. */
export const CREATIONS_CHANGED_EVENT = 'briefstack:creations-changed';

/** Sent on `window` when the server, in server mode, no longer knows this device's session (signed out or revoked). */
export const SESSION_REJECTED_EVENT = 'briefstack:session-rejected';

// Server mode (phase 12): the session cookie goes with every request. In local mode no cookie ever does, as before.
let serverMode = false;

/** Called once the server said it runs in server mode. */
export function enterServerMode(): void {
  serverMode = true;
}

/** What `fetch` sends of the browser's cookies: none in local mode, this origin's in server mode. */
export function requestCredentials(): RequestCredentials {
  return serverMode ? 'same-origin' : 'omit';
}

/**
 * Asks the server how the page signs in, without any credential but this
 * origin's cookie: `server` with `signedIn`, or `undefined` when it answers
 * otherwise (local mode refuses it without the token).
 */
export async function probeServer(): Promise<{ signedIn: boolean } | 'unreachable' | undefined> {
  let res: Response;
  try {
    res = await fetch('/api/server/state', { credentials: 'same-origin' });
  } catch {
    return 'unreachable';
  }
  if (!res.ok) return undefined;
  const body = (await res.json().catch(() => undefined)) as { mode?: string; signedIn?: boolean } | undefined;
  return body?.mode === 'server' ? { signedIn: body.signedIn === true } : undefined;
}

/** Server mode's sign-in: the access secret, sent once in the body, never in the address. */
export async function signIn(secret: string): Promise<void> {
  const res = await fetch('/api/server/sign-in', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret }) });
  if (res.ok) return;
  const failure = (await res.json().catch(() => ({}))) as { code?: string; params?: Record<string, unknown> };
  throw new ApiError(res.status, failure.code ?? 'web.unknown', failure.params);
}

/** Tells the page when an error means the token is no longer valid, so it shows the restart message instead of a retry. */
export function noteRejection(error: unknown): void {
  if (error instanceof ApiError && error.code === 'web.rejected.session') window.dispatchEvent(new Event(SESSION_REJECTED_EVENT));
  if (error instanceof ApiError && error.code === 'web.rejected.token') window.dispatchEvent(new Event(TOKEN_REJECTED_EVENT));
}

export async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { [TOKEN_HEADER]: token };
  const init: RequestInit = { method, headers, credentials: requestCredentials() };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(res.status, 'web.unknown');
  }
  if (!res.ok) {
    const failure = data as { code?: string; params?: Record<string, unknown> };
    const error = new ApiError(res.status, failure.code ?? 'web.unknown', failure.params);
    noteRejection(error);
    throw error;
  }
  return data as T;
}
