import { writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/index.js';
import { checkProvider } from '../../src/providers/check.js';
import { parseReserveProviders, providerBaseUrl, type ReserveProvider } from '../../src/providers/config.js';
import { isAnthropicCredential, keyFileState, providerEnvironment, readProviderKey } from '../../src/providers/env.js';
import { startWebServer, TOKEN_HEADER, type WebServer } from '../../src/server/index.js';
import { tempDir, writeTree } from '../helpers.js';

// Phase 12, M4: reserve providers (PLAN-phase-12 §1, 8 to 10).

// Built at run time: no file in the repo holds a secret-looking value.
const KEY = ['prov', 'key', 'z'.repeat(28)].join('-');
const entry = (overrides: Record<string, unknown> = {}) => ({ name: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-v4-pro', keyFile: path.resolve('/keys/deepseek'), ...overrides });

describe('reserve providers in config.json', () => {
  it('reads valid entries', () => {
    const parsed = parseReserveProviders([entry({ smallModel: 'deepseek-flash', note: 'Data in its own region.' }), entry({ name: 'kimi', baseUrl: 'https://api.moonshot.ai/anthropic/', model: 'kimi-k3' })]);
    expect(parsed).toEqual([
      { name: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-v4-pro', smallModel: 'deepseek-flash', keyFile: path.resolve('/keys/deepseek'), note: 'Data in its own region.' },
      { name: 'kimi', baseUrl: 'https://api.moonshot.ai/anthropic', model: 'kimi-k3', keyFile: path.resolve('/keys/deepseek') },
    ]);
  });

  it('refuses what could send a key elsewhere or hold one', () => {
    const bad: Record<string, unknown>[] = [
      entry({ baseUrl: 'http://api.deepseek.com/anthropic' }),
      entry({ baseUrl: 'https://user:pass@api.deepseek.com/anthropic' }),
      entry({ baseUrl: 'https://api.deepseek.com/anthropic?x=1' }),
      entry({ baseUrl: 'not a url' }),
      entry({ name: 'Deep Seek' }),
      entry({ name: '-x' }),
      entry({ keyFile: 'keys/deepseek' }),
      entry({ model: 'a b' }),
      entry({ key: KEY }),
      entry({ note: 'x'.repeat(201) }),
    ];
    for (const item of bad) expect(parseReserveProviders([item]), JSON.stringify(item)).toBeUndefined();
    expect(parseReserveProviders([entry(), entry()])).toBeUndefined();
    expect(parseReserveProviders('deepseek')).toBeUndefined();
    expect(providerBaseUrl('https://api.example.com/anthropic#frag')).toBeUndefined();
  });

  it('is a config error with the field named, and nothing when absent', () => {
    expect(() => parseConfig(JSON.stringify({ reserveProviders: [entry({ baseUrl: 'http://x' })] }), 'config.json')).toThrow(expect.objectContaining({ code: 'config.invalidField', params: expect.objectContaining({ field: 'reserveProviders' }) }));
    expect(parseConfig(JSON.stringify({ reserveProviders: [entry()] }), 'config.json').reserveProviders).toHaveLength(1);
    expect(parseConfig('{}', 'config.json').reserveProviders).toBeUndefined();
  });
});

describe('a provider round\'s environment', () => {
  const provider: ReserveProvider = { name: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'big', keyFile: '/k' };

  it('takes every Anthropic credential out and puts the provider\'s in', () => {
    const env = providerEnvironment(
      {
        PATH: 'p',
        HTTPS_PROXY: 'http://proxy:3128',
        ANTHROPIC_API_KEY: 'a',
        ANTHROPIC_AUTH_TOKEN: 'b',
        ANTHROPIC_BASE_URL: 'https://elsewhere.example',
        ANTHROPIC_CUSTOM_HEADERS: 'x: y',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
        CLAUDE_CODE_OAUTH_TOKEN: 'c',
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'd',
        CLAUDE_CODE_CLIENT_CERT: '/certs/me.pem',
        CLAUDE_CODE_CLIENT_KEY: '/certs/me.key',
        CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: 'p',
        CLAUDE_CODE_CERT_STORE: 'system',
        CLAUDE_CODE_DISABLE_CRON: '1',
      },
      provider,
      KEY,
    );
    expect(env).toEqual({
      PATH: 'p',
      HTTPS_PROXY: 'http://proxy:3128',
      // The trust store is not a credential: a proxy's own authority may be in it.
      CLAUDE_CODE_CERT_STORE: 'system',
      CLAUDE_CODE_DISABLE_CRON: '1',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'big',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'big',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'big',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'big',
      CLAUDE_CODE_SUBAGENT_MODEL: 'big',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // Credentials out of the commands', hooks' and MCP servers' environment (review of M4, I1).
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    });
    expect(isAnthropicCredential('CLAUDE_CODE_DISABLE_CRON')).toBe(false);
  });
});

describe('a provider\'s key and its status check', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await tempDir('providers')));
  afterEach(() => cleanup());
  const provider = (keyFile: string): ReserveProvider => ({ name: 'deepseek', baseUrl: 'https://api.deepseek.invalid/anthropic', model: 'm', keyFile });

  it('reads the key without a mark or line end, and refuses an empty, multi-line, large or missing file without saying what it holds', async () => {
    const file = path.join(dir, 'key');
    await writeFile(file, `${String.fromCharCode(0xfeff)}  ${KEY}\r\n`, 'utf8');
    expect(await readProviderKey(provider(file))).toBe(KEY);
    for (const text of ['', '\n', `${KEY}\n${KEY}`, 'x'.repeat(5000)]) {
      await writeFile(file, text, 'utf8');
      const error = await readProviderKey(provider(file)).catch((e: unknown) => e);
      expect(error, text.slice(0, 10)).toMatchObject({ code: 'provider.keyUnreadable', params: { name: 'deepseek', file } });
      expect(JSON.stringify(error)).not.toContain(KEY);
    }
    await expect(readProviderKey(provider(path.join(dir, 'none')))).rejects.toMatchObject({ code: 'provider.keyUnreadable' });
  });

  it('tells a present, empty or missing key file apart by its size only', async () => {
    await writeTree(dir, { full: KEY, empty: '', large: 'x'.repeat(5000) });
    expect(await keyFileState(path.join(dir, 'full'))).toBe('present');
    expect(await keyFileState(path.join(dir, 'large'))).toBe('tooLarge');
    expect(await keyFileState(path.join(dir, 'empty'))).toBe('empty');
    expect(await keyFileState(path.join(dir, 'none'))).toBe('missing');
    expect(await keyFileState(dir)).toBe('missing');
  });

  it('checks the endpoint with no credential and never reads or sends the key', async () => {
    await writeTree(dir, { key: KEY });
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const reachable = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"error":"no key"}', { status: 401 });
    }) as typeof fetch;
    const result = await checkProvider(provider(path.join(dir, 'key')), { fetch: reachable, now: () => new Date('2026-11-27T10:00:00Z') });
    expect(result).toEqual({ name: 'deepseek', keyFile: 'present', endpoint: 'reachable', status: 401, key: 'notChecked', checkedAt: '2026-11-27T10:00:00.000Z' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.deepseek.invalid/anthropic');
    expect(calls[0]?.init?.headers).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain(KEY);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await checkProvider(provider(path.join(dir, 'none')), { fetch: down })).toMatchObject({ keyFile: 'missing', endpoint: 'unreachable', key: 'notChecked' });
    expect((await checkProvider(provider(path.join(dir, 'none')), { fetch: down })).status).toBeUndefined();
  });
});

interface Reply {
  status: number;
  body: string;
}

describe('the providers API', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let server: WebServer | undefined;
  let logLines: string[];
  const TOKEN = 't'.repeat(43);
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir('providers-api'));
    await writeTree(dir, { 'ui/index.html': '<html></html>', 'keys/deepseek': KEY });
    await writeTree(path.join(dir, 'home'), { 'config.json': JSON.stringify({ reserveProviders: [entry({ keyFile: path.join(dir, 'keys', 'deepseek') })] }) });
    logLines = [];
    server = await startWebServer({
      port: 0,
      uiDir: path.join(dir, 'ui'),
      token: TOKEN,
      log: (line) => logLines.push(line),
      pathEnv: { env: { BRIEFSTACK_HOME: path.join(dir, 'home') }, homedir: path.join(dir, 'user'), pathApi: path, caseInsensitive: false },
      providerCheck: { fetch: (async () => new Response('', { status: 404 })) as typeof fetch },
    });
  });
  afterEach(async () => {
    await server?.close();
    await cleanup();
  });

  const send = (urlPath: string, method = 'GET'): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const s = server as WebServer;
      const req = request(
        { host: '127.0.0.1', port: s.port, path: urlPath, method, headers: { host: `127.0.0.1:${s.port}`, [TOKEN_HEADER]: TOKEN, ...(method === 'GET' ? {} : { origin: `http://127.0.0.1:${s.port}` }) } },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });

  it('lists the providers without any key, checks one, and refuses an unknown one', async () => {
    const listed = await send('/api/providers');
    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.body)).toEqual({ providers: [{ name: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-v4-pro', keyFile: path.join(dir, 'keys', 'deepseek') }] });
    const checked = await send('/api/providers/deepseek/check', 'POST');
    expect(JSON.parse(checked.body)).toMatchObject({ name: 'deepseek', keyFile: 'present', endpoint: 'reachable', status: 404, key: 'notChecked' });
    expect(JSON.parse((await send('/api/providers')).body).providers[0].check).toMatchObject({ endpoint: 'reachable' });
    const unknown = await send('/api/providers/other/check', 'POST');
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body)).toMatchObject({ code: 'provider.notFound' });
    expect([listed.body, checked.body, unknown.body, ...logLines].join('\n')).not.toContain(KEY);
  });

  it('has no route that writes a provider', async () => {
    for (const method of ['PUT', 'POST', 'DELETE']) expect((await send('/api/providers', method)).status).toBe(404);
  });
});
