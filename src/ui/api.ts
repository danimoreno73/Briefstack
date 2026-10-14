/** Talks to the local server. The launch token comes in the URL fragment once. */

const TOKEN_HEADER = 'x-briefstack-token';
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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
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
  const data = (await res.json()) as T & { code?: string };
  if (!res.ok) throw new ApiError(res.status, data.code ?? 'web.unknown');
  return data;
}
