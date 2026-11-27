import type { IncomingMessage, ServerResponse } from 'node:http';
import { BriefstackError } from '../errors.js';
import { matchesSecret } from './access.js';
import { BASE_HEADERS, header, sendJson } from './http.js';
import type { RouteTable } from './router.js';
import { clearedCookie, sessionCookie, type DeviceRecord, type DeviceSessions, type SignInLimiter } from './sessions.js';

/**
 * Server mode's sign-in, sign-out and devices routes (phase 12; docs/api.md).
 * Only in server mode. The secret and the session token never reach a log
 * line, an error's text or an answer body.
 */

/** The largest sign-in body: a secret is short. */
const MAX_SIGN_IN_BYTES = 4096;
/** A refused body up to this size is read and dropped rather than cut off. */
const DRAIN_BYTES = 64 * 1024;

function sendWithCookie(res: ServerResponse, status: number, body: unknown, cookie: string): void {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', 'set-cookie': cookie });
  res.end(JSON.stringify(body));
}

/**
 * The secret in a sign-in body, read without `readJsonBody`, whose errors
 * repeat what the JSON parser saw: a malformed body must never echo the
 * secret back.
 */
async function readSecret(req: IncomingMessage, res: ServerResponse): Promise<string> {
  const mediaType = (header(req, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    req.resume();
    throw new BriefstackError('web.unsupportedMediaType', { contentType: header(req, 'content-type') ?? '' });
  }
  // An open route: a large body over the limit is not read to its end (review of M2, 6). A declared length says so
  // before any byte is read: up to `DRAIN_BYTES` the rest is read and dropped, so the client gets its 413 (closing
  // a socket with unread data resets it); above that, the connection is closed once the 413 is out. A body without
  // a declared length stops being read at the limit.
  const tooLarge = () => new BriefstackError('web.bodyTooLarge', { limit: MAX_SIGN_IN_BYTES });
  const declared = Number(header(req, 'content-length') ?? '0');
  if (declared > MAX_SIGN_IN_BYTES) {
    if (declared <= DRAIN_BYTES) req.resume();
    else res.once('finish', () => req.destroy());
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_SIGN_IN_BYTES) throw tooLarge();
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    value = undefined;
  }
  const secret = typeof value === 'object' && value !== null ? (value as { secret?: unknown }).secret : undefined;
  if (typeof secret !== 'string' || secret === '') throw new BriefstackError('web.invalidBody', { issues: ['secret: required'] });
  return secret;
}

export interface SignInDeps {
  sessions: DeviceSessions;
  limiter: SignInLimiter;
  secretDigest: Buffer;
  /** The device of a request that carried a known session. */
  deviceOf: (req: IncomingMessage) => DeviceRecord | undefined;
}

export function signInRoutes(deps: SignInDeps): RouteTable {
  const { sessions, limiter } = deps;
  return [
    [
      'POST /api/server/sign-in',
      async (req, res) => {
        const secret = await readSecret(req, res);
        const seconds = limiter.locked();
        if (seconds !== undefined) throw new BriefstackError('server.signInLocked', { seconds });
        // The digest compare runs whatever the input, so a wrong secret answers as fast as a right one.
        if (!matchesSecret(secret, deps.secretDigest)) {
          limiter.fail();
          throw new BriefstackError('server.signInFailed', {});
        }
        limiter.succeed();
        const { token, device } = await sessions.signIn(header(req, 'user-agent'));
        sendWithCookie(res, 200, { ok: true, device: { id: device.id, label: device.label } }, sessionCookie(token));
      },
    ],
    [
      'POST /api/server/sign-out',
      async (req, res) => {
        const device = deps.deviceOf(req);
        if (device !== undefined) await sessions.revoke(device.id);
        sendWithCookie(res, 200, { ok: true }, clearedCookie());
      },
    ],
    ['GET /api/server/devices', (req, res) => sendJson(res, 200, { devices: sessions.list(deps.deviceOf(req)?.id) })],
    [
      'POST /api/server/devices/revoke-all',
      async (_req, res) => {
        await sessions.revokeAll();
        sendWithCookie(res, 200, { ok: true }, clearedCookie());
      },
    ],
    [
      'POST /api/server/devices/:id/revoke',
      async (req, res, params) => {
        const id = params.id ?? '';
        if (!(await sessions.revoke(id))) throw new BriefstackError('server.deviceNotFound', { id });
        // Revoking this very device signs it out here too.
        if (deps.deviceOf(req)?.id === id) sendWithCookie(res, 200, { ok: true }, clearedCookie());
        else sendJson(res, 200, { ok: true });
      },
    ],
  ];
}
