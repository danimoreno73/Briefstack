import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import type { PathEnv } from '../config/index.js';
import { BriefstackError } from '../errors.js';
import { projectChecks, setProjectChecks } from '../tasks/checks.js';
import type { TaskManager, TaskStreamEvent } from '../tasks/manager.js';
import { initProjectRepo } from '../tasks/preconditions.js';
import type { UsageCheck } from '../usage/warning.js';
import { BASE_HEADERS, header, readJsonBody, sendJson } from './http.js';
import type { RouteTable } from './router.js';
import { HEARTBEAT_MS, MAX_REPLY_CHARS } from './creations.js';

/** `force`: the user chose "start anyway" after the plan-usage warning. */
const startBody = z.strictObject({ project: z.string().min(1).max(200), description: z.string().trim().min(1).max(20_000), force: z.boolean().optional() });
const answerBody = z.strictObject({ pendingId: z.string().min(1), answer: z.unknown() });
const textBody = z.strictObject({ text: z.string().trim().min(1).max(MAX_REPLY_CHARS) });
/** Actions the page confirms first say so in the body: a request without it changes nothing. */
const confirmBody = z.strictObject({ confirm: z.literal(true) });
const checksBody = z.strictObject({ commands: z.array(z.string()).max(50), confirm: z.literal(true) });

export function formatTaskSse(event: TaskStreamEvent): string {
  return `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

function fromSeq(url: URL, lastEventId: string | undefined): number {
  const value = url.searchParams.get('from') ?? lastEventId ?? '0';
  if (!/^\d{1,9}$/.test(value)) throw new BriefstackError('web.invalidQuery', { name: 'from', value });
  return Number(value);
}

export interface TaskRouteOptions {
  heartbeatMs?: number;
  usage?: UsageCheck | undefined;
  /** The library, the home and the repo now (Settings can move the library). */
  paths: () => Promise<{ libraryDir: string; home: string; repoDir: string }>;
  /** The server's environment and home, so the protected folders are the server's own. */
  pathEnv: PathEnv;
}

/**
 * Task routes (docs/api.md, "Tasks"). Approve, ask for changes, discard and
 * revert are here only, for the proposal page; the chat has no tool for
 * them (BRIEF-phase-7 §3.6). Without a manager every task route answers 503
 * `task.unavailable`.
 */
export function taskRoutes(manager: TaskManager | undefined, options: TaskRouteOptions): RouteTable {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const need = (): TaskManager => {
    if (manager === undefined) throw new BriefstackError('task.unavailable', {});
    return manager;
  };
  const id = (params: Readonly<Record<string, string>>): string => params.id ?? '';
  const slug = (params: Readonly<Record<string, string>>): string => params.slug ?? '';

  const stream = async (res: ServerResponse, m: TaskManager, taskId: string, from: number): Promise<void> => {
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' });
    res.write(': stream\n\n');
    await new Promise<void>((resolve) => {
      let closed = false;
      const subscription: { off?: () => void } = {};
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), heartbeatMs);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        subscription.off?.();
        resolve();
      };
      res.on('close', close);
      subscription.off = m.subscribe(
        taskId,
        from,
        (event) => {
          if (!closed) res.write(formatTaskSse(event));
        },
        () => {
          res.end();
          close();
        },
      );
      if (closed) subscription.off();
    });
  };

  return [
    ['GET /api/tasks', async (_req, res) => sendJson(res, 200, { tasks: await need().list() })],
    [
      'POST /api/tasks',
      async (req, res) => {
        const m = need();
        const { project, description, force } = await readJsonBody(req, startBody);
        // Before anything starts: high plan usage asks the page to confirm (BRIEF-phase-6 §3.6).
        if (force !== true) {
          const warning = await options.usage?.check();
          if (warning !== undefined) throw new BriefstackError('usage.high', warning);
        }
        const task = await m.start(project, description);
        sendJson(res, 201, { id: task.id });
      },
    ],
    ['GET /api/tasks/:id', async (_req, res, params) => sendJson(res, 200, await need().get(id(params)))],
    [
      'GET /api/tasks/:id/stream',
      async (req, res, params) => {
        const m = need();
        await m.get(id(params));
        const url = new URL(req.url ?? '/', 'http://localhost');
        await stream(res, m, id(params), fromSeq(url, header(req, 'last-event-id')));
      },
    ],
    [
      'POST /api/tasks/:id/answer',
      async (req, res, params) => {
        const body = await readJsonBody(req, answerBody);
        sendJson(res, 200, need().answer(id(params), body.pendingId, body.answer));
      },
    ],
    [
      'POST /api/tasks/:id/reply',
      async (req, res, params) => {
        const { text } = await readJsonBody(req, textBody);
        sendJson(res, 200, need().reply(id(params), text));
      },
    ],
    ['POST /api/tasks/:id/finish', (_req, res, params) => sendJson(res, 200, need().finishRound(id(params)))],
    ['POST /api/tasks/:id/cancel', (_req, res, params) => sendJson(res, 200, need().cancel(id(params)))],
    ['GET /api/tasks/:id/proposal', async (_req, res, params) => sendJson(res, 200, await need().proposal(id(params)))],
    [
      'POST /api/tasks/:id/approve',
      async (req, res, params) => {
        await readJsonBody(req, confirmBody);
        sendJson(res, 200, await need().approve(id(params)));
      },
    ],
    [
      'POST /api/tasks/:id/changes',
      async (req, res, params) => {
        const m = need();
        const { text } = await readJsonBody(req, textBody);
        sendJson(res, 200, await m.newRound(id(params), text));
      },
    ],
    [
      'POST /api/tasks/:id/discard',
      async (req, res, params) => {
        await readJsonBody(req, confirmBody);
        sendJson(res, 200, await need().discard(id(params)));
      },
    ],
    [
      'POST /api/tasks/:id/revert',
      async (req, res, params) => {
        await readJsonBody(req, confirmBody);
        sendJson(res, 200, await need().revert(id(params)));
      },
    ],
    [
      'GET /api/projects/:slug/tasks',
      async (_req, res, params) => {
        const m = need();
        const { libraryDir, home } = await options.paths();
        const all = await m.list();
        sendJson(res, 200, {
          tasks: all.filter((task) => task.project === slug(params)),
          checks: await projectChecks({ libraryDir, home, slug: slug(params) }),
          start: await m.startInfo(slug(params)),
        });
      },
    ],
    [
      'PUT /api/projects/:slug/checks',
      async (req, res, params) => {
        need();
        const { commands } = await readJsonBody(req, checksBody);
        const { libraryDir, home } = await options.paths();
        sendJson(res, 200, { checks: await setProjectChecks({ libraryDir, home, slug: slug(params), commands }) });
      },
    ],
    [
      'POST /api/projects/:slug/git-init',
      async (req, res, params) => {
        need();
        await readJsonBody(req, confirmBody);
        const { libraryDir, repoDir } = await options.paths();
        sendJson(res, 200, await initProjectRepo({ libraryDir, repoDir, pathEnv: options.pathEnv }, slug(params)));
      },
    ],
  ];
}
