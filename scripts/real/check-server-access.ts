// Real check (phase 12): server mode as the container runs it. No model, no
// session: only HTTP calls to the briefstack already running in server mode,
// as a browser makes them, with devices of its own that it signs out. Run it
// where the tailnet name reaches the server (the documented run), or inside
// the container against its own port:
//
//   npx tsx scripts/real/check-server-access.ts --yes \
//     --host <your-server>.<your-tailnet>.ts.net:<port> \
//     --secret-file /home/<user>/secrets/briefstack-access \
//     [--url https://<your-server>.<your-tailnet>.ts.net:<port>] [--lockout]
//
// --url: where to send the requests. With the tailnet name over HTTPS (the
// documented run) they go through Tailscale's HTTPS and `tailscale serve`, as
// a phone's do. Without it, they go to the container's own
// http://127.0.0.1:4870 with --host as the Host header (server mode accepts a
// configured name there). Either way the requests go straight to that
// address, never through HTTP(S)_PROXY: an agent of their own, whatever
// NODE_USE_ENV_PROXY says.
//
// What it checks (PASS or FAIL each, then a summary):
//   1. health answers; the state says server mode and not signed in;
//   2. without a session /api is refused (also with a per-start token
//      header, refused as having no session: server mode has no token),
//      another Host is refused, and Codex is reported off;
//   3. a wrong secret is refused without repeating it; a sign-in from another
//      origin is refused;
//   4. the right secret gives a cookie `__Host-briefstack-session` with
//      HttpOnly, Secure, SameSite=Strict, Path=/ and no Domain, and the answer
//      holds no token;
//   5. with the cookie /api answers, the state says signed in, and this device
//      is in the devices list as the current one;
//   6. a stream (the chat's server-sent events) opens with the cookie and its
//      first bytes arrive (through `tailscale serve` with --url https://...);
//      revoking this device from the devices list ends that stream at once
//      and its cookie is refused afterwards;
//   7. a second sign-in, then signing out clears the cookie and the next call
//      is refused;
//   8. with --lockout only: five wrong secrets lock sign-in, the right one
//      included (429). This locks every sign-in for 15 minutes: devices
//      already signed in keep working.
// The secret and the session tokens are never printed. It writes no file and
// touches no other device: every device it signed in is signed out at the
// end, whatever failed. Spends: nothing (no model). It does not read the
// plan's usage (a reading costs a session).

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Agent as HttpAgent, request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { report, requireConfirmation, startCheck } from './common.js';

requireConfirmation(
  'Phase 12 real check: server mode through HTTP, as a browser uses it: refusals, sign-in, the cookie, the devices list, a stream ended by revoking its own device, and a sign-out. With --lockout it also locks sign-in for 15 minutes.',
  'No model and no Claude session: it spends nothing.',
);

const CALL_MS = 30_000;
const STREAM_END_MS = 10_000;
const COOKIE = '__Host-briefstack-session';

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

const check = startCheck();
let ok = true;
const table: { name: string; verdict: 'PASS' | 'FAIL'; detail: string }[] = [];
const verdict = (name: string, passed: boolean, detail: string): void => {
  table.push({ name, verdict: passed ? 'PASS' : 'FAIL', detail });
  ok = report(name, passed, detail) && ok;
};

try {
  const host = option('--host');
  const secretFile = option('--secret-file');
  if (host === undefined || secretFile === undefined) throw new Error('Give --host <name:port> (one of --allowed-hosts) and --secret-file <path> (the server\'s --access-secret-file).');
  const base = new URL(option('--url') ?? 'http://127.0.0.1:4870');
  const viaHttps = base.protocol === 'https:';
  // Straight to the server: an agent of its own never uses the environment's proxy (NODE_USE_ENV_PROXY sets it on the
  // global agents only).
  const agent = viaHttps ? new HttpsAgent() : new HttpAgent();
  // The server's own rule: the file's text without a byte-order mark and its trailing line end.
  const raw = await readFile(secretFile, 'utf8');
  const secret = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r?\n$/, '');
  const wrong = randomBytes(24).toString('base64url');
  const origin = `https://${host}`;
  /** Everything the server answered, bodies at even places and Set-Cookie headers at odd ones, to look for the secret and the tokens at the end. */
  const seen: string[] = [];
  /** Every session token the server issued to this check, signed out at the end whatever happened. */
  const issued: string[] = [];

  const open = (method: string, route: string, headers: Record<string, string>, body: string | undefined, onAnswer: (res: IncomingMessage) => void): ClientRequest => {
    const send = viaHttps ? httpsRequest : httpRequest;
    const req = send({ protocol: base.protocol, hostname: base.hostname, port: base.port === '' ? undefined : Number(base.port), path: route, method, headers: { host, 'user-agent': 'briefstack check-server-access', ...headers }, agent, ...(viaHttps ? { servername: host.split(':')[0] } : {}) }, (res) => {
      for (const cookie of res.headers['set-cookie'] ?? []) {
        const value = cookie.split(';')[0]?.replace(`${COOKIE}=`, '') ?? '';
        if (cookie.startsWith(`${COOKIE}=`) && value !== '' && !issued.includes(value)) issued.push(value);
      }
      onAnswer(res);
    });
    req.end(body);
    return req;
  };
  const call = (method: string, route: string, options: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...options.headers };
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      if (body !== undefined) headers['content-type'] = 'application/json';
      const req = open(method, route, headers, body, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          seen.push(text, JSON.stringify(res.headers['set-cookie'] ?? []));
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text });
        });
      });
      req.setTimeout(CALL_MS, () => req.destroy(new Error(`${method} ${route}: no answer within ${CALL_MS / 1000} s`)));
      req.on('error', reject);
    });
  const json = (answer: Answer): Record<string, unknown> => {
    try {
      return JSON.parse(answer.body) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const page = { origin, 'sec-fetch-site': 'same-origin' };
  const withCookie = (token: string) => ({ cookie: `${COOKIE}=${token}` });
  const tokenOf = (answer: Answer): string => ((answer.headers['set-cookie'] ?? [])[0] ?? '').split(';')[0]?.replace(new RegExp(`^${COOKIE}=`), '') ?? '';
  check.add(async () => {
    // Whatever happened, no device of this check stays signed in.
    for (const token of issued) await call('POST', '/api/server/sign-out', { headers: { ...page, ...withCookie(token) } }).catch(() => undefined);
  });

  // 1. Open routes.
  const health = await call('GET', '/api/health');
  verdict('1. health answers', health.status === 200, `${health.status}`);
  const state = json(await call('GET', '/api/server/state'));
  verdict('1. the state says server mode, not signed in', state.mode === 'server' && state.signedIn === false, JSON.stringify(state));

  // 2. Refusals.
  const noSession = await call('GET', '/api/settings');
  verdict('2. /api without a session is refused (401 web.rejected.session)', noSession.status === 401 && json(noSession).code === 'web.rejected.session', `${noSession.status} ${noSession.body.slice(0, 100)}`);
  const token = await call('GET', '/api/settings', { headers: { 'x-briefstack-token': randomBytes(32).toString('base64url') } });
  verdict('2. a per-start token header changes nothing: refused as having no session (401 web.rejected.session)', token.status === 401 && json(token).code === 'web.rejected.session', `${token.status} ${token.body.slice(0, 100)}`);
  const otherHost = await call('GET', '/', { headers: { host: 'evil.example:8445' } });
  verdict('2. another Host is refused (403)', otherHost.status === 403, `${otherHost.status}`);

  // 3. Wrong secret, other origin.
  const failed = await call('POST', '/api/server/sign-in', { headers: page, body: { secret: wrong } });
  verdict('3. a wrong secret is refused (401 server.signInFailed), without being repeated', failed.status === 401 && json(failed).code === 'server.signInFailed' && !failed.body.includes(wrong), `${failed.status}`);
  const crossSite = await call('POST', '/api/server/sign-in', { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, body: { secret } });
  verdict('3. a sign-in from another origin is refused (403)', crossSite.status === 403 && (crossSite.headers['set-cookie'] ?? []).length === 0, `${crossSite.status}`);

  // 4. The right secret.
  const signed = await call('POST', '/api/server/sign-in', { headers: page, body: { secret } });
  const cookie = (signed.headers['set-cookie'] ?? [])[0] ?? '';
  const parts = cookie.split(';').map((part) => part.trim());
  const first = tokenOf(signed);
  const flags = parts.slice(1).map((part) => part.toLowerCase());
  verdict('4. the right secret signs this device in', signed.status === 200 && first !== '' && first !== parts[0], `${signed.status}`);
  verdict(
    '4. the cookie is __Host-, HttpOnly, Secure, SameSite=Strict, Path=/, with no Domain',
    (parts[0] ?? '').startsWith(`${COOKIE}=`) && flags.includes('httponly') && flags.includes('secure') && flags.includes('samesite=strict') && flags.includes('path=/') && !flags.some((flag) => flag.startsWith('domain=')),
    flags.join('; '),
  );
  verdict('4. the answer\'s body holds no token', first !== '' && !signed.body.includes(first), '');

  // 5. Signed in.
  const settings = await call('GET', '/api/settings', { headers: withCookie(first) });
  verdict('5. with the cookie, /api answers', settings.status === 200, `${settings.status}`);
  const signedState = json(await call('GET', '/api/server/state', { headers: withCookie(first) }));
  verdict('5. the state says signed in', signedState.signedIn === true, JSON.stringify(signedState));
  const devices = (json(await call('GET', '/api/server/devices', { headers: withCookie(first) })).devices ?? []) as { id: string; label: string; current: boolean }[];
  const mine = devices.find((device) => device.current);
  verdict('5. this device is in the list, as the current one', mine !== undefined && mine.label === 'briefstack check-server-access', `${devices.length} device(s); current: ${mine?.label ?? 'none'}`);
  const codex = json(await call('GET', '/api/codex', { headers: withCookie(first) }));
  verdict('2. Codex is off in server mode', codex.available === false && codex.reason === 'serverMode', JSON.stringify({ available: codex.available, reason: codex.reason }));

  // 6. A stream, ended by revoking this device.
  const stream = await new Promise<{ status: number; type: string; firstBytes: boolean; ended: Promise<boolean>; req: ClientRequest }>((resolve, reject) => {
    let settled = false;
    const req = open('GET', '/api/chat/stream', { accept: 'text/event-stream', ...withCookie(first) }, undefined, (res) => {
      const ended = new Promise<boolean>((done) => {
        res.once('end', () => done(true));
        res.once('close', () => done(true));
        res.once('error', () => done(true));
      });
      res.setEncoding('utf8');
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), firstBytes: false, ended, req });
      }, CALL_MS);
      res.once('data', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), firstBytes: true, ended, req });
      });
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
  check.add(() => stream.req.destroy());
  verdict('6. a stream opens with the cookie and its first bytes arrive', stream.status === 200 && stream.type.startsWith('text/event-stream') && stream.firstBytes, `${stream.status} ${stream.type}${stream.firstBytes ? '' : ', no bytes within 30 s (buffered?)'}`);
  const revoked = mine === undefined ? undefined : await call('POST', `/api/server/devices/${encodeURIComponent(mine.id)}/revoke`, { headers: { ...page, ...withCookie(first) } });
  verdict('6. revoking this device from the list answers and clears its cookie', revoked?.status === 200 && ((revoked.headers['set-cookie'] ?? [])[0] ?? '').toLowerCase().includes('max-age=0'), `${revoked?.status ?? 'not sent: no current device'}`);
  const endedInTime = await Promise.race([stream.ended, new Promise<boolean>((done) => setTimeout(() => done(false), STREAM_END_MS))]);
  verdict(`6. the revoked device's stream ends within ${STREAM_END_MS / 1000} s`, endedInTime, '');
  const afterRevoke = await call('GET', '/api/settings', { headers: withCookie(first) });
  verdict('6. the revoked cookie is refused afterwards', afterRevoke.status === 401, `${afterRevoke.status}`);

  // 7. A second sign-in, signed out.
  const again = await call('POST', '/api/server/sign-in', { headers: page, body: { secret } });
  const second = tokenOf(again);
  verdict('7. a second sign-in works', again.status === 200 && second !== '', `${again.status}`);
  const out = await call('POST', '/api/server/sign-out', { headers: { ...page, ...withCookie(second) } });
  const cleared = ((out.headers['set-cookie'] ?? [])[0] ?? '').toLowerCase();
  verdict('7. signing out clears the cookie', out.status === 200 && cleared.includes('max-age=0'), `${out.status}`);
  const after = await call('GET', '/api/settings', { headers: withCookie(second) });
  verdict('7. the old cookie is refused afterwards', after.status === 401, `${after.status}`);

  // 8. The attempt limit, only when asked.
  if (process.argv.includes('--lockout')) {
    for (let i = 0; i < 5; i += 1) await call('POST', '/api/server/sign-in', { headers: page, body: { secret: randomBytes(24).toString('base64url') } });
    const locked = await call('POST', '/api/server/sign-in', { headers: page, body: { secret } });
    verdict('8. after five wrong secrets, sign-in is locked for everybody, the right secret included (429)', locked.status === 429 && json(locked).code === 'server.signInLocked' && (locked.headers['set-cookie'] ?? []).length === 0, `${locked.status} ${locked.body.slice(0, 120)}`);
    console.log('   Sign-in stays locked for 15 minutes; devices already signed in keep working.');
  } else console.log('NOT RUN: 8. the attempt limit (add --lockout; it locks sign-in for 15 minutes).');

  const bodies = seen.filter((_, i) => i % 2 === 0).join('\n');
  verdict('no answer of the server holds the secret', !seen.join('\n').includes(secret), '');
  verdict('no answer body holds a session token (only their Set-Cookie headers do)', issued.length > 0 && issued.every((value) => !bodies.includes(value)), `${issued.length} token(s) issued`);
  console.log('   Also look at the container\'s log (docker logs): it must hold neither the secret nor any token.');
} catch (error) {
  check.fail(error);
} finally {
  await check.close();
}
console.log('\nSummary');
for (const row of table) console.log(`${row.verdict.padEnd(6)} ${row.name}${row.detail === '' ? '' : `: ${row.detail}`}`);
process.exit(check.exitCode(ok));
