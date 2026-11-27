import type { ReserveProvider } from './config.js';
import { keyFileState } from './env.js';

/**
 * A reserve provider's status check (phase 12; PLAN-phase-12 §1, 9;
 * decisions.md, "Phase 12: H0", 3). It reads no key: whether the key file
 * is there and not empty (by its size), and whether the base URL's host
 * answers a request sent without any credential. Neither provider documents
 * a no-cost call under its Anthropic base URL, so the key's validity is
 * "not checked". It runs only when the user clicks.
 */

export const PROVIDER_CHECK_TIMEOUT_MS = 10_000;

export interface ProviderCheck {
  name: string;
  keyFile: 'present' | 'missing' | 'empty' | 'tooLarge';
  /** Any HTTP answer counts as reachable; a network error or no answer in time as unreachable. */
  endpoint: 'reachable' | 'unreachable';
  /** The HTTP status of the answer, when there was one. */
  status?: number;
  key: 'notChecked';
  checkedAt: string;
}

export interface ProviderCheckDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export async function checkProvider(provider: ReserveProvider, deps: ProviderCheckDeps = {}): Promise<ProviderCheck> {
  const keyFile = await keyFileState(provider.keyFile);
  let status: number | undefined;
  try {
    // No header but the defaults: no key, no cookie. Redirects are not followed (an answer is an answer).
    const res = await (deps.fetch ?? fetch)(provider.baseUrl, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(deps.timeoutMs ?? PROVIDER_CHECK_TIMEOUT_MS) });
    status = res.status;
    await res.body?.cancel().catch(() => undefined);
  } catch {
    status = undefined;
  }
  return {
    name: provider.name,
    keyFile,
    endpoint: status === undefined ? 'unreachable' : 'reachable',
    ...(status === undefined ? {} : { status }),
    key: 'notChecked',
    checkedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
}
