import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import { BriefstackError, type ErrorCode } from '../errors.js';
import type { Lang } from '../i18n/index.js';
import { formatError } from '../i18n/errors.js';

/** Headers on every response. */
export const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
} as const;

/** Largest JSON body an `/api` route accepts. */
export const MAX_BODY_BYTES = 64 * 1024;

export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** HTTP status per error code; any other coded error is a 400. */
const ERROR_STATUS: Partial<Record<ErrorCode, number>> = {
  'web.bodyTooLarge': 413,
  'web.unsupportedMediaType': 415,
  'library.noteNotFound': 404,
  'library.commitNotFound': 404,
  'library.dirtyTree': 409,
  'library.revertConflict': 409,
  'events.sessionNotFound': 404,
  'creation.unavailable': 503,
  'creation.busy': 409,
  'creation.notFound': 404,
  'creation.noPending': 409,
  'creation.wrongPending': 409,
  'creation.noSpec': 404,
};

/** Error body of every `/api` route: `{ code, params, message }`, the message in the server's language. */
export function sendError(res: ServerResponse, error: BriefstackError, lang: Lang): void {
  sendJson(res, ERROR_STATUS[error.code] ?? 400, { code: error.code, params: error.params, message: formatError(error, lang) });
}

/**
 * Reads a JSON body (`Content-Type: application/json`, at most
 * `MAX_BODY_BYTES`) and checks it with `schema`. The whole body is read
 * even when too large, so the client always gets the 413.
 */
export async function readJsonBody<T>(req: IncomingMessage, schema: z.ZodType<T>, limit = MAX_BODY_BYTES): Promise<T> {
  const contentType = header(req, 'content-type') ?? '';
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    req.resume();
    throw new BriefstackError('web.unsupportedMediaType', { contentType });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw new BriefstackError('web.bodyTooLarge', { limit });

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new BriefstackError('web.invalidJson', { detail: (error as Error).message });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    );
    throw new BriefstackError('web.invalidBody', { issues });
  }
  return parsed.data;
}
