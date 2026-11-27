import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatManager } from '../chat/manager.js';
import type { ClaudeStatus } from '../creation/claudeAccount.js';
import type { CreationManager } from '../creation/manager.js';
import type { ImprovementManager } from '../improve/manager.js';
import path from 'node:path';
import { configFilePath, readConfig, resolveHome, resolvePaths, systemPathEnv, type PathEnv } from '../config/index.js';
import { PACKAGE_ROOT } from '../packageRoot.js';
import type { TaskManager } from '../tasks/manager.js';
import type { BuildManager } from '../builds/manager.js';
import type { CodexService } from '../codex/service.js';
import { buildRoutes } from './builds.js';
import { codexRoutes } from './codex.js';
import { taskRoutes } from './tasks.js';
import { BriefstackError, isBriefstackError } from '../errors.js';
import { DEFAULT_LANG, type Lang } from '../i18n/index.js';
import { VERSION } from '../version.js';
import { chatRoutes } from './chat.js';
import { creationRoutes } from './creations.js';
import { improveRoutes } from './improve.js';
import { skillRoutes } from './skills.js';
import type { SkillService } from '../skills/service.js';
import type { UsageCheck } from '../usage/warning.js';
import { BASE_HEADERS, header, sendError, sendJson } from './http.js';
import { readRoutes } from './read.js';
import { writeRoutes } from './write.js';
import { createRouter, type RouteTable } from './router.js';
import { LOOPBACK, TOKEN_HEADER, checkRequest, isAllowedHost, newToken, type Rejection } from './security.js';
import { loadStaticSite } from './static.js';
import type { ServerMode } from './access.js';
import { DeviceSessions, SignInLimiter, sessionToken, type DeviceRecord } from './sessions.js';
import { signInRoutes } from './signin.js';
import { providerRoutes } from './providers.js';
import type { ProviderCheckDeps } from '../providers/check.js';

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
  /** Improvements (phase 5). Without one, the improvement routes answer 503 `improve.unavailable`. The caller owns it. */
  improvements?: ImprovementManager;
  /** Third-party skills (phase 6). Without one, the skill routes answer 503 `skills.unavailable`. */
  skills?: SkillService;
  /** Tasks in existing projects (phase 7). Without one, the task routes answer 503 `task.unavailable`. The caller owns it. */
  tasks?: TaskManager;
  /** Codex in Settings (phase 8). Without one, the Codex routes answer 503 `codex.unavailable`. */
  codex?: CodexService;
  /** Builds (phase 9). Without one, the build routes answer 503 `build.unavailable`. The caller owns it. */
  builds?: BuildManager;
  /** The plan-usage warning before a creation or an improvement starts (phase 6). Without it, no warning. */
  usageCheck?: UsageCheck;
  /** Where the user's files live; the real machine by default. Tests pass a temp home. */
  pathEnv?: PathEnv;
  /** The briefstack repo the usage and paths routes report on; the package by default. */
  repoDir?: string;
  /** Time between heartbeat comments on a creation stream (tests shorten it). */
  heartbeatMs?: number;
  /**
   * The user's Claude Code: installed or not, its version, and how it signs
   * in (`src/creation/claudeAccount.ts`). `refresh` reads it again. Without
   * it, `GET /api/claude` answers 503 `claude.unavailable`.
   */
  claudeStatus?: (refresh: boolean) => Promise<ClaudeStatus>;
  /**
   * Server mode (phase 12): listen on its address, accept its names, and
   * never accept the per-start token. Absent: local mode, exactly as before.
   */
  server?: ServerMode;
  /** The clock of the sign-in limit and the devices' times (tests move it). */
  now?: () => Date;
  /** How a reserve provider's status check reaches the network (tests give a fake `fetch`). */
  providerCheck?: ProviderCheckDeps;
}

export interface WebServer {
  /**
   * The address to open: `http://127.0.0.1:<port>/#token=<token>` in local
   * mode; in server mode `https://<first allowed name>/`, with no token.
   */
  url: string;
  origin: string;
  /** The address the server listens on: 127.0.0.1 in local mode, `--listen` in server mode. */
  address: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const REJECTION_STATUS: Record<Rejection, number> = { host: 403, token: 401, origin: 403, session: 401 };

/** The `/api` routes server mode serves without a device session (phase 12). */
const OPEN_SERVER_ROUTES: readonly string[] = ['GET /api/health', 'GET /api/server/state', 'POST /api/server/sign-in'];

/** Server mode's device sessions, for the routes that need them (phase 12). */
interface ServerAuth {
  deviceOf: (req: IncomingMessage) => DeviceRecord | undefined;
  routes: RouteTable;
}

/** Read-only and mutating `/api` routes, as `METHOD /path` (`:name` segments are parameters). */
function apiRoutes(options: WebServerOptions, auth: ServerAuth | undefined): RouteTable {
  const pathEnv = options.pathEnv ?? systemPathEnv();
  return [
    ['GET /api/health', (_req, res) => sendJson(res, 200, { ok: true, version: VERSION })],
    // Phase 12: how the page signs in. Only the mode and whether this request is signed in, never anything else.
    ['GET /api/server/state', (req, res) => sendJson(res, 200, auth === undefined ? { mode: 'local' } : { mode: 'server', signedIn: auth.deviceOf(req) !== undefined })],
    ...(auth?.routes ?? []),
    [
      'GET /api/claude',
      async (req, res) => {
        if (options.claudeStatus === undefined) {
          sendJson(res, 503, { code: 'claude.unavailable' });
          return;
        }
        const refresh = new URL(req.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1';
        sendJson(res, 200, await options.claudeStatus(refresh));
      },
    ],
    ...readRoutes({
      pathEnv,
      repoDir: options.repoDir,
      lang: options.lang,
      activity: async () => ({
        creations: options.creations?.activeIds().length ?? 0,
        builds: ((await options.builds?.list()) ?? []).filter((build) => build.state === 'running' || build.state === 'planning').length,
      }),
    }),
    ...writeRoutes({ pathEnv, repoDir: options.repoDir, ...(options.server === undefined ? {} : { serverMode: true }) }),
    ...creationRoutes(options.creations, { ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }), usage: options.usageCheck }),
    ...chatRoutes(options.chat, options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...improveRoutes(options.improvements, { usage: options.usageCheck }),
    ...skillRoutes(options.skills),
    ...providerRoutes({ pathEnv, ...(options.providerCheck === undefined ? {} : { check: options.providerCheck }) }),
    ...codexRoutes(options.codex),
    ...buildRoutes(options.builds, { usage: options.usageCheck }),
    ...taskRoutes(options.tasks, {
      pathEnv,
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
      usage: options.usageCheck,
      paths: async () => {
        const paths = resolvePaths(await readConfig(configFilePath(pathEnv)), pathEnv);
        return { libraryDir: paths.libraryDir, home: paths.home, repoDir: options.repoDir ?? PACKAGE_ROOT };
      },
    }),
  ];
}

/**
 * Starts the web server: in local mode on 127.0.0.1 only, with the launch
 * token on `/api` (BRIEF-phase-2 §4); in server mode on its `--listen`
 * address, with its allowed names and device sessions instead of the token
 * (phase 12). Every request passes the host check, and mutating `/api`
 * calls the same-origin check.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const site = await loadStaticSite(options.uiDir);
  const token = options.token ?? newToken();
  const mode = options.server;
  // Server mode (phase 12): the signed-in devices, kept in the home; the device of each request that carried a session.
  const devices = new WeakMap<IncomingMessage, DeviceRecord>();
  const log = options.log ?? (() => undefined);
  // The answers still open per device (the streams), so signing a device out ends them at once (review of M2, 1).
  // Only answers already under way are ended: the sign-out's own answer has not started yet and goes out whole.
  const openAnswers = new Map<string, Set<ServerResponse>>();
  const endAnswers = (ids: readonly string[]) => {
    for (const id of ids) {
      for (const answer of openAnswers.get(id) ?? []) if (answer.headersSent && !answer.writableEnded) answer.end();
    }
  };
  const sessions =
    mode === undefined
      ? undefined
      : await DeviceSessions.open({
          file: path.join(resolveHome(options.pathEnv ?? systemPathEnv()), 'server', 'sessions.json'),
          ...(options.now === undefined ? {} : { now: options.now }),
          onRevoked: endAnswers,
          // Never its content: only that every device has to sign in again.
          onUnreadable: () => log('server/sessions.json does not read back: every device has to sign in again'),
        });
  const auth: ServerAuth | undefined =
    mode === undefined || sessions === undefined
      ? undefined
      : {
          deviceOf: (req) => devices.get(req),
          routes: signInRoutes({ sessions, limiter: new SignInLimiter(options.now), secretDigest: mode.secretDigest, deviceOf: (req) => devices.get(req) }),
        };
  const route = createRouter(apiRoutes(options, auth));
  const lang = options.lang ?? DEFAULT_LANG;
  let port = options.port;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const api = pathname === '/api' || pathname.startsWith('/api/');
    // The session is looked up only for a request to an allowed host, so a refused one never touches the file.
    if (sessions !== undefined && mode !== undefined && api && isAllowedHost(header(req, 'host'), port, mode.names)) {
      const device = await sessions.find(sessionToken(header(req, 'cookie')));
      if (device !== undefined) {
        devices.set(req, device);
        const set = openAnswers.get(device.id) ?? new Set<ServerResponse>();
        openAnswers.set(device.id, set);
        set.add(res);
        res.once('close', () => {
          set.delete(res);
          if (set.size === 0 && openAnswers.get(device.id) === set) openAnswers.delete(device.id);
        });
      }
    }
    const rejection = checkRequest(
      {
        method: req.method,
        host: header(req, 'host'),
        origin: header(req, 'origin'),
        secFetchSite: header(req, 'sec-fetch-site'),
        token: req.headers[TOKEN_HEADER],
      },
      {
        port,
        token,
        api,
        ...(mode === undefined ? {} : { server: { names: mode.names, signedIn: devices.has(req), open: OPEN_SERVER_ROUTES.includes(`${req.method ?? ''} ${pathname}`) } }),
      },
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
    server.listen(options.port, options.server?.listen ?? LOOPBACK, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const bound = server.address() as AddressInfo;
  port = bound.port;
  const origin = options.server === undefined ? `http://${LOOPBACK}:${port}` : `https://${options.server.names[0] ?? `${LOOPBACK}:${port}`}`;

  return {
    // Server mode prints no token: the page asks for the access secret (decisions.md, "Phase 12: H0, the real container", E).
    url: options.server === undefined ? `${origin}/#token=${token}` : `${origin}/`,
    origin,
    address: bound.address,
    port,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
