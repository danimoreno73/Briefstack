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
  /** With no checks: the user confirmed that every task with no denied command is then applied (step 33). */
  noChecks: z.literal(true).optional(),
  /** How many cards run at once (phase 11); one when absent. */
  slots: z.number().optional(),
  /** At the usage threshold, a reserve provider's name (phase 12); absent: pause. */
  reserve: z.string().max(40).optional(),
});

/** The page's confirmation of an action that stays (discard, cancel, revert). */
const confirmBody = z.strictObject({ confirm: z.literal(true) });
/** Apply also names the integration head the page showed (`GET /api/builds/:id/diff`). */
const applyBody = z.strictObject({ confirm: z.literal(true), head: z.string().regex(/^[0-9a-f]{40,64}$/) });

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
        sendJson(res, 200, { builds: all.filter((build) => build.project === slug(params)), plan: await m.planInfo(slug(params)), thresholds: await m.defaultThresholds(), slotsCap: await m.slotsCapNow() });
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
        sendJson(res, 200, await need().start(id(params), { tasks: body.tasks as never, limit: body.limit, commands: body.commands, checks: body.checks, fixRounds: body.fixRounds, thresholds: body.thresholds, ...(body.noChecks === true ? { noChecks: true } : {}), ...(body.slots === undefined ? {} : { slots: body.slots }), ...(body.reserve === undefined ? {} : { reserve: body.reserve }) }));
      },
    ],
    // Actions the page confirms first say so in the body; without it nothing changes, as for tasks (review of M5, I3).
    [
      'POST /api/builds/:id/discard',
      async (req, res, params) => {
        await readJsonBody(req, confirmBody);
        sendJson(res, 200, await need().discard(id(params)));
      },
    ],
    ['POST /api/builds/:id/pause', async (_req, res, params) => sendJson(res, 200, await need().pause(id(params)))],
    ['POST /api/builds/:id/resume', async (_req, res, params) => sendJson(res, 200, await need().resume(id(params)))],
    [
      'POST /api/builds/:id/cancel',
      async (req, res, params) => {
        await readJsonBody(req, confirmBody);
        sendJson(res, 200, await need().cancel(id(params)));
      },
    ],
    [
      'POST /api/builds/:id/apply',
      async (req, res, params) => {
        const { head } = await readJsonBody(req, applyBody);
        sendJson(res, 200, await need().apply(id(params), head));
      },
    ],
    [
      'POST /api/builds/:id/revert',
      async (req, res, params) => {
        await readJsonBody(req, confirmBody);
        sendJson(res, 200, await need().revert(id(params)));
      },
    ],
    ['GET /api/builds/:id/diff', async (_req, res, params) => sendJson(res, 200, await need().diff(id(params)))],
  ];
}
