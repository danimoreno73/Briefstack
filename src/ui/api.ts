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

export async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { [TOKEN_HEADER]: token };
  const init: RequestInit = { method, headers, credentials: 'omit' };
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
    throw new ApiError(res.status, failure.code ?? 'web.unknown', failure.params);
  }
  return data as T;
}
