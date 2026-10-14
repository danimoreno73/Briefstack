import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BriefstackError } from '../errors.js';
import { VERSION } from '../version.js';
import { LOOPBACK, TOKEN_HEADER, checkRequest, newToken, type Rejection } from './security.js';
import { loadStaticSite } from './static.js';

/** Default port of `briefstack web`; `0` asks the OS for any free port. */
export const DEFAULT_WEB_PORT = 4870;

export interface WebServerOptions {
  port: number;
  /** Built UI folder; defaults to `dist/web` in the package. */
  uiDir?: string;
  /** Fixed token for tests; a fresh random one otherwise. */
  token?: string;
  /** One line per request: method, route and status. Never bodies. */
  log?: (line: string) => void;
}

export interface WebServer {
  /** `http://127.0.0.1:<port>/#token=<token>`: the address to open. */
  url: string;
  origin: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

const REJECTION_STATUS: Record<Rejection, number> = { host: 403, token: 401, origin: 403 };

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
} as const;

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Read-only and mutating `/api` routes, keyed by `METHOD /path`. Filled in by later milestones. */
function apiRoutes(): Map<string, Handler> {
  return new Map<string, Handler>([['GET /api/health', (_req, res) => sendJson(res, 200, { ok: true, version: VERSION })]]);
}

/**
 * Starts the local web server on 127.0.0.1 only. Every request passes the
 * host check; `/api` also needs the launch token, and mutating `/api` calls
 * the same-origin check (BRIEF-phase-2 §4).
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const site = await loadStaticSite(options.uiDir);
  const token = options.token ?? newToken();
  const routes = apiRoutes();
  const log = options.log ?? (() => undefined);
  let port = options.port;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const api = pathname === '/api' || pathname.startsWith('/api/');
    const rejection = checkRequest(
      {
        method: req.method,
        host: header(req, 'host'),
        origin: header(req, 'origin'),
        secFetchSite: header(req, 'sec-fetch-site'),
        token: req.headers[TOKEN_HEADER],
      },
      { port, token, api },
    );
    if (rejection !== undefined) {
      sendJson(res, REJECTION_STATUS[rejection], { code: `web.rejected.${rejection}` });
      return;
    }
    if (api) {
      const route = routes.get(`${req.method ?? ''} ${pathname}`);
      if (route === undefined) {
        sendJson(res, 404, { code: 'web.notFound' });
        return;
      }
      await route(req, res);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { code: 'web.methodNotAllowed' });
      return;
    }
    const file = await site.get(pathname);
    if (file === undefined) {
      sendJson(res, 404, { code: 'web.notFound' });
      return;
    }
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': file.contentType, 'content-security-policy': site.csp });
    res.end(req.method === 'HEAD' ? undefined : file.body);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res)
      .catch(() => {
        if (!res.headersSent) sendJson(res, 500, { code: 'web.internal' });
        else res.end();
      })
      .finally(() => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        log(`${req.method ?? '?'} ${pathname} ${res.statusCode}`);
      });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(error.code === 'EADDRINUSE' ? new BriefstackError('web.portInUse', { port: options.port }) : error);
    };
    server.once('error', onError);
    server.listen(options.port, LOOPBACK, () => {
      server.off('error', onError);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  const origin = `http://${LOOPBACK}:${port}`;

  return {
    url: `${origin}/#token=${token}`,
    origin,
    port,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
