import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import type { CreationManager, StreamEvent } from '../creation/manager.js';
import { BriefstackError } from '../errors.js';
import { BASE_HEADERS, header, readJsonBody, sendJson } from './http.js';
import type { RouteTable } from './router.js';

/** Default time between SSE heartbeat comments. */
export const HEARTBEAT_MS = 15_000;

const createBody = z.strictObject({ idea: z.string().trim().min(1).max(20_000) });
const answerBody = z.strictObject({ pendingId: z.string().min(1), answer: z.unknown() });

/** One stream event in SSE format: `id` is the seq, `event` the kind, `data` the whole event as JSON. */
export function formatSse(event: StreamEvent): string {
  return `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** `?from=<seq>`, else the `Last-Event-ID` header, else 0. */
function fromSeq(url: URL, lastEventId: string | undefined): number {
  const value = url.searchParams.get('from') ?? lastEventId ?? '0';
  if (!/^\d{1,9}$/.test(value)) throw new BriefstackError('web.invalidQuery', { name: 'from', value });
  return Number(value);
}

/**
 * Creation routes (docs/api.md). Without a manager (no runner available)
 * every one answers 503 `creation.unavailable`.
 */
export function creationRoutes(manager: CreationManager | undefined, options: { heartbeatMs?: number } = {}): RouteTable {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const need = (): CreationManager => {
    if (manager === undefined) throw new BriefstackError('creation.unavailable', {});
    return manager;
  };
  const id = (params: Readonly<Record<string, string>>): string => params.id ?? '';

  const stream = async (res: ServerResponse, m: CreationManager, creationId: string, from: number): Promise<void> => {
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
        creationId,
        from,
        (event) => {
          if (!closed) res.write(formatSse(event));
        },
        () => {
          // Everything was written above; end after flushing.
          res.end();
          close();
        },
      );
      if (closed) subscription.off();
    });
  };

  return [
    [
      'POST /api/creations',
      async (req, res) => {
        const m = need();
        const { idea } = await readJsonBody(req, createBody);
        const state = await m.create(idea);
        sendJson(res, 201, { id: state.id });
      },
    ],
    ['GET /api/creations', (_req, res) => sendJson(res, 200, { creations: need().list() })],
    ['GET /api/creations/:id', (_req, res, params) => sendJson(res, 200, need().get(id(params)))],
    [
      'POST /api/creations/:id/answer',
      async (req, res, params) => {
        const m = need();
        const body = await readJsonBody(req, answerBody);
        sendJson(res, 200, m.answer(id(params), body.pendingId, body.answer));
      },
    ],
    ['GET /api/creations/:id/spec', async (_req, res, params) => sendJson(res, 200, await need().readSpec(id(params)))],
    ['POST /api/creations/:id/cancel', (_req, res, params) => sendJson(res, 200, need().cancel(id(params)))],
    [
      'GET /api/creations/:id/stream',
      async (req, res, params) => {
        const m = need();
        m.get(id(params));
        const url = new URL(req.url ?? '/', 'http://localhost');
        await stream(res, m, id(params), fromSeq(url, header(req, 'last-event-id')));
      },
    ],
  ];
}
