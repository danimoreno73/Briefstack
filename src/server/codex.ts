import type { ServerResponse } from 'node:http';
import type { CodexService } from '../codex/service.js';
import { sendJson } from './http.js';
import type { RouteTable } from './router.js';

/**
 * Codex in Settings (phase 8, docs/api.md): the settings with the last
 * status check, and the check itself, run only when the user asks. The
 * switch, the mode and the calls per round are saved with `PUT
 * /api/settings`. Without a service both answer 503 `codex.unavailable`.
 */
export function codexRoutes(codex: CodexService | undefined): RouteTable {
  const unavailable = (res: ServerResponse) => sendJson(res, 503, { code: 'codex.unavailable' });
  return [
    [
      'GET /api/codex',
      async (_req, res) => {
        if (codex === undefined) return unavailable(res);
        sendJson(res, 200, await codex.view());
      },
    ],
    [
      'POST /api/codex/check',
      async (_req, res) => {
        if (codex === undefined) return unavailable(res);
        sendJson(res, 200, await codex.check());
      },
    ],
  ];
}
