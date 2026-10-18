import { z } from 'zod';
import { BriefstackError } from '../errors.js';
import type { ImprovementManager } from '../improve/manager.js';
import { REAL_CHECKS } from '../improve/realCheck.js';
import { MAX_EVIDENCE_SESSIONS } from '../improve/evidence.js';
import { readJsonBody, sendJson } from './http.js';
import type { RouteParams, RouteTable } from './router.js';

/**
 * Improvement routes (docs/api.md). Without an improvement manager every
 * one answers 503 `improve.unavailable`. Approve, discard, revert and the
 * real check exist only here, for the proposal page: the chat can prepare
 * an improvement, never apply one (BRIEF-phase-5 §3.6).
 */

export const MAX_IMPROVE_REQUEST_CHARS = 10_000;

const prepareBody = z.strictObject({
  request: z.string().trim().min(1).max(MAX_IMPROVE_REQUEST_CHARS),
  sessions: z.array(z.string().min(1).max(100)).max(MAX_EVIDENCE_SESSIONS).optional(),
  lessons: z.boolean().optional(),
  suggestionId: z.string().min(1).max(100).optional(),
});
const changesBody = z.strictObject({ text: z.string().trim().min(1).max(MAX_IMPROVE_REQUEST_CHARS) });

export function improveRoutes(improve: ImprovementManager | undefined): RouteTable {
  const need = (): ImprovementManager => {
    if (improve === undefined) throw new BriefstackError('improve.unavailable', {});
    return improve;
  };
  const id = (params: RouteParams): string => params.id ?? '';

  return [
    [
      'GET /api/improve',
      async (_req, res) => {
        const m = need();
        const active = m.activeId();
        sendJson(res, 200, {
          ...(active === undefined ? {} : { active }),
          proposals: await m.list(),
          suggestions: await m.suggestions(),
          blockers: await m.blockers(),
        });
      },
    ],
    [
      'GET /api/improve/proposals/:id',
      async (_req, res, params) => {
        const m = need();
        const view = await m.get(id(params));
        sendJson(res, 200, {
          proposal: view,
          blockers: await m.blockers(),
          ...(view.offeredCheck === undefined ? {} : { check: REAL_CHECKS[view.offeredCheck] }),
        });
      },
    ],
    [
      'POST /api/improve/proposals',
      async (req, res) => {
        const m = need();
        const body = await readJsonBody(req, prepareBody);
        const view = await m.prepare(body.request, {
          ...(body.sessions === undefined ? {} : { sessions: body.sessions }),
          ...(body.lessons === undefined ? {} : { lessons: body.lessons }),
          ...(body.suggestionId === undefined ? {} : { suggestionId: body.suggestionId }),
        });
        sendJson(res, 202, { proposal: view });
      },
    ],
    [
      'POST /api/improve/proposals/:id/changes',
      async (req, res, params) => {
        const m = need();
        const { text } = await readJsonBody(req, changesBody);
        sendJson(res, 202, { proposal: await m.askChanges(id(params), text) });
      },
    ],
    ['POST /api/improve/proposals/:id/approve', async (_req, res, params) => sendJson(res, 200, { proposal: await need().approve(id(params)) })],
    ['POST /api/improve/proposals/:id/discard', async (_req, res, params) => sendJson(res, 200, { proposal: await need().discard(id(params)) })],
    ['POST /api/improve/proposals/:id/revert', async (_req, res, params) => sendJson(res, 200, { proposal: await need().revert(id(params)) })],
    ['POST /api/improve/proposals/:id/check', async (_req, res, params) => sendJson(res, 202, { proposal: await need().startCheck(id(params)) })],
  ];
}
