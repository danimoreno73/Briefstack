import { z } from 'zod';
import type { BuildManager } from '../builds/manager.js';
import { BriefstackError } from '../errors.js';
import type { UsageCheck } from '../usage/warning.js';
import { readJsonBody, sendJson } from './http.js';
import type { RouteTable } from './router.js';

/**
 * Build routes (docs/api.md, "Builds"; BRIEF-phase-9 §3). Only the pages
 * use them: the chat has no tool to plan, start, apply or discard a build.
 * Without a manager every build route answers 503 `build.unavailable`.
 */

/** `force`: the user chose "plan anyway" after the plan-usage warning. */
const planBody = z.strictObject({ force: z.boolean().optional() });
/** What the start page approved; the manager checks every rule and names each problem. */
const startBody = z.strictObject({
  tasks: z.array(z.unknown()).max(50),
  limit: z.number(),
  commands: z.array(z.string().max(2000)).max(50),
  checks: z.array(z.string().max(2000)).max(50),
  fixRounds: z.number(),
  thresholds: z.strictObject({ fiveHour: z.number(), week: z.number() }),
  /** The page showed the warning that a build runs code before anyone reads it. */
  confirm: z.literal(true),
});

export interface BuildRouteOptions {
  usage?: UsageCheck | undefined;
}

export function buildRoutes(manager: BuildManager | undefined, options: BuildRouteOptions = {}): RouteTable {
  const need = (): BuildManager => {
    if (manager === undefined) throw new BriefstackError('build.unavailable', {});
    return manager;
  };
  const id = (params: Readonly<Record<string, string>>): string => params.id ?? '';
  const slug = (params: Readonly<Record<string, string>>): string => params.slug ?? '';

  return [
    ['GET /api/builds/:id', async (_req, res, params) => sendJson(res, 200, await need().get(id(params)))],
    [
      'GET /api/projects/:slug/builds',
      async (_req, res, params) => {
        const m = need();
        const all = await m.list();
        sendJson(res, 200, { builds: all.filter((build) => build.project === slug(params)), plan: await m.planInfo(slug(params)), thresholds: await m.defaultThresholds() });
      },
    ],
    [
      'POST /api/projects/:slug/builds',
      async (req, res, params) => {
        const m = need();
        const { force } = await readJsonBody(req, planBody);
        // Before the planner runs: high plan usage asks the page to confirm, as for a task.
        if (force !== true) {
          const warning = await options.usage?.check();
          if (warning !== undefined) throw new BriefstackError('usage.high', warning);
        }
        const build = await m.plan(slug(params));
        sendJson(res, 201, { id: build.id });
      },
    ],
    [
      'POST /api/builds/:id/start',
      async (req, res, params) => {
        const body = await readJsonBody(req, startBody);
        sendJson(res, 200, await need().start(id(params), { tasks: body.tasks as never, limit: body.limit, commands: body.commands, checks: body.checks, fixRounds: body.fixRounds, thresholds: body.thresholds }));
      },
    ],
    ['POST /api/builds/:id/discard', async (_req, res, params) => sendJson(res, 200, await need().discard(id(params)))],
  ];
}
