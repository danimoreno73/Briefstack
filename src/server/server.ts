import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatManager } from '../chat/manager.js';
import type { CreationManager } from '../creation/manager.js';
import { systemPathEnv, type PathEnv } from '../config/index.js';
import { BriefstackError, isBriefstackError } from '../errors.js';
import { DEFAULT_LANG, type Lang } from '../i18n/index.js';
import { VERSION } from '../version.js';
import { chatRoutes } from './chat.js';
import { creationRoutes } from './creations.js';
import { BASE_HEADERS, header, sendError, sendJson } from './http.js';
import { readRoutes } from './read.js';
import { writeRoutes } from './write.js';
import { createRouter, type RouteTable } from './router.js';
import { LOOPBACK, TOKEN_HEADER, checkRequest, newToken, type Rejection } from './security.js';
import { loadStaticSite } from './static.js';

export { sendJson } from './http.js';

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
  /** Language of error messages in API responses. Default English. */
  lang?: Lang;
  /**
   * Creation sessions. Without one, the creation routes answer 503
   * `creation.unavailable`. The caller owns it and calls its `shutdown()`.
   */
  creations?: CreationManager;
  /** The global chat. Without one, the chat routes answer 503 `chat.unavailable`. The caller owns it. */
  chat?: ChatManager;
  /** Where the user's files live; the real machine by default. Tests pass a temp home. */
  pathEnv?: PathEnv;
  /** The briefstack repo the usage and paths routes report on; the package by default. */
  repoDir?: string;
  /** Time between heartbeat comments on a creation stream (tests shorten it). */
  heartbeatMs?: number;
}

export interface WebServer {
  /** `http://127.0.0.1:<port>/#token=<token>`: the address to open. */
  url: string;
  origin: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const REJECTION_STATUS: Record<Rejection, number> = { host: 403, token: 401, origin: 403 };

/** Read-only and mutating `/api` routes, as `METHOD /path` (`:name` segments are parameters). */
function apiRoutes(options: WebServerOptions): RouteTable {
  const pathEnv = options.pathEnv ?? systemPathEnv();
  return [
    ['GET /api/health', (_req, res) => sendJson(res, 200, { ok: true, version: VERSION })],
    ...readRoutes({ pathEnv, repoDir: options.repoDir, lang: options.lang }),
    ...writeRoutes({ pathEnv, repoDir: options.repoDir }),
    ...creationRoutes(options.creations, options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...chatRoutes(options.chat, options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
  ];
}

/**
 * Starts the local web server on 127.0.0.1 only. Every request passes the
 * host check; `/api` also needs the launch token, and mutating `/api` calls
 * the same-origin check (BRIEF-phase-2 §4).
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const site = await loadStaticSite(options.uiDir);
  const token = options.token ?? newToken();
  const route = createRouter(apiRoutes(options));
  const lang = options.lang ?? DEFAULT_LANG;
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
      const match = route(req.method ?? '', pathname);
      if (match === undefined) {
        sendJson(res, 404, { code: 'web.notFound' });
        return;
      }
      try {
        await match.handler(req, res, match.params);
      } catch (error) {
        if (!isBriefstackError(error) || res.headersSent) throw error;
        sendError(res, error, lang);
      }
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
