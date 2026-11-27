import { configFilePath, readConfig, reserveProvidersOf, type PathEnv } from '../config/index.js';
import { BriefstackError } from '../errors.js';
import { checkProvider, type ProviderCheck, type ProviderCheckDeps } from '../providers/check.js';
import { providerView } from '../providers/config.js';
import { sendJson } from './http.js';
import type { RouteTable } from './router.js';

/**
 * Reserve providers on the page (phase 12; docs/api.md): the configured
 * list, read-only, and the status check. Nothing here writes a provider,
 * and no answer carries a key: briefstack holds none, only the path of the
 * file it reads at a round's start.
 */
export function providerRoutes(context: { pathEnv: PathEnv; check?: ProviderCheckDeps }): RouteTable {
  // The last check of each provider, while this server runs.
  const checks = new Map<string, ProviderCheck>();
  const providers = async () => reserveProvidersOf(await readConfig(configFilePath(context.pathEnv)));
  return [
    [
      'GET /api/providers',
      async (_req, res) => {
        const list = await providers();
        sendJson(res, 200, { providers: list.map((provider) => ({ ...providerView(provider), ...(checks.has(provider.name) ? { check: checks.get(provider.name) } : {}) })) });
      },
    ],
    [
      'POST /api/providers/:name/check',
      async (_req, res, params) => {
        const name = params.name ?? '';
        const provider = (await providers()).find((entry) => entry.name === name);
        if (provider === undefined) throw new BriefstackError('provider.notFound', { name });
        const result = await checkProvider(provider, context.check);
        checks.set(name, result);
        sendJson(res, 200, result);
      },
    ],
  ];
}
