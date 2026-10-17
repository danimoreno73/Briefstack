import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import type { ChatManager } from '../chat/manager.js';
import type { ChatStreamEvent } from '../chat/types.js';
import { BriefstackError } from '../errors.js';
import { BASE_HEADERS, header, readJsonBody, sendJson } from './http.js';
import type { RouteTable } from './router.js';
import { HEARTBEAT_MS } from './creations.js';

/** The same limit as a free-text reply to a creation. */
export const MAX_CHAT_MESSAGE_CHARS = 10_000;

const messageBody = z.strictObject({ text: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_CHARS) });
const confirmBody = z.strictObject({ decision: z.enum(['confirm', 'decline']) });

function formatSse(event: ChatStreamEvent): string {
  return `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

function fromSeq(url: URL, lastEventId: string | undefined): number {
  const value = url.searchParams.get('from') ?? lastEventId ?? '0';
  if (!/^\d{1,9}$/.test(value)) throw new BriefstackError('web.invalidQuery', { name: 'from', value });
  return Number(value);
}

/**
 * Chat routes (docs/api.md). Without a chat every one answers 503
 * `chat.unavailable`. The only way to run a chat action is
 * `POST /api/chat/confirmations/:id` with `confirm`, behind the token and the
 * same-origin check like every mutating route.
 */
export function chatRoutes(chat: ChatManager | undefined, options: { heartbeatMs?: number } = {}): RouteTable {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const need = (): ChatManager => {
    if (chat === undefined) throw new BriefstackError('chat.unavailable', {});
    return chat;
  };

  const stream = async (res: ServerResponse, c: ChatManager, from: number): Promise<void> => {
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' });
    res.write(': stream\n\n');
    await new Promise<void>((resolve) => {
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), heartbeatMs);
      const off = c.subscribe(from, (event) => res.write(formatSse(event)));
      res.on('close', () => {
        clearInterval(heartbeat);
        off();
        resolve();
      });
    });
  };

  return [
    ['GET /api/chat', async (_req, res) => sendJson(res, 200, await need().view())],
    [
      'POST /api/chat/messages',
      async (req, res) => {
        const c = need();
        const { text } = await readJsonBody(req, messageBody);
        await c.send(text);
        sendJson(res, 202, await c.view());
      },
    ],
    [
      'POST /api/chat/confirmations/:id',
      async (req, res, params) => {
        const c = need();
        const { decision } = await readJsonBody(req, confirmBody);
        c.confirm(params.id ?? '', decision);
        sendJson(res, 200, { decision });
      },
    ],
    [
      'POST /api/chat/new',
      async (_req, res) => {
        const c = need();
        await c.newChat();
        sendJson(res, 200, await c.view());
      },
    ],
    ['GET /api/chat/threads', (_req, res) => sendJson(res, 200, { threads: need().threads() })],
    ['GET /api/chat/threads/:id', async (_req, res, params) => sendJson(res, 200, await need().readThread(params.id ?? ''))],
    [
      'GET /api/chat/stream',
      async (req, res) => {
        const c = need();
        const url = new URL(req.url ?? '/', 'http://localhost');
        await stream(res, c, fromSeq(url, header(req, 'last-event-id')));
      },
    ],
  ];
}
