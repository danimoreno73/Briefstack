import { describe, expect, it } from 'vitest';
import {
  checkRequest,
  hasValidToken,
  isAllowedHost,
  isSameOrigin,
  newToken,
  type RequestHeaders,
} from '../../src/server/security.js';

const PORT = 4870;
const TOKEN = 'a'.repeat(43);

const headers = (overrides: Partial<RequestHeaders> = {}): RequestHeaders => ({
  method: 'GET',
  host: `127.0.0.1:${PORT}`,
  origin: undefined,
  secFetchSite: undefined,
  token: TOKEN,
  ...overrides,
});

describe('server security', () => {
  it('accepts only the loopback host and our port', () => {
    expect(isAllowedHost('127.0.0.1:4870', PORT)).toBe(true);
    expect(isAllowedHost('LOCALHOST:4870', PORT)).toBe(true);
    expect(isAllowedHost('127.0.0.1:4871', PORT)).toBe(false);
    expect(isAllowedHost('127.0.0.1', PORT)).toBe(false);
    expect(isAllowedHost('evil.example:4870', PORT)).toBe(false);
    expect(isAllowedHost('localhost.evil.example:4870', PORT)).toBe(false);
    expect(isAllowedHost(undefined, PORT)).toBe(false);
  });

  it('compares the token exactly', () => {
    expect(hasValidToken(TOKEN, TOKEN)).toBe(true);
    expect(hasValidToken(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(hasValidToken('b'.repeat(43), TOKEN)).toBe(false);
    expect(hasValidToken(undefined, TOKEN)).toBe(false);
    expect(hasValidToken([TOKEN, TOKEN], TOKEN)).toBe(false);
  });

  it('makes a different long token each launch', () => {
    const a = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(a);
  });

  it('requires our own origin for mutating requests', () => {
    const host = `127.0.0.1:${PORT}`;
    expect(isSameOrigin(`http://${host}`, 'same-origin', host, PORT)).toBe(true);
    expect(isSameOrigin(`http://${host}`, undefined, host, PORT)).toBe(true);
    expect(isSameOrigin(`http://localhost:${PORT}`, undefined, host, PORT)).toBe(false);
    expect(isSameOrigin('https://evil.example', undefined, host, PORT)).toBe(false);
    expect(isSameOrigin('null', undefined, host, PORT)).toBe(false);
    expect(isSameOrigin(undefined, 'same-origin', host, PORT)).toBe(false);
    expect(isSameOrigin(`http://${host}`, 'cross-site', host, PORT)).toBe(false);
    expect(isSameOrigin(`http://${host}`, 'same-site', host, PORT)).toBe(false);
  });

  it('checks host, then token, then origin', () => {
    const api = { port: PORT, token: TOKEN, api: true };
    expect(checkRequest(headers({ host: 'evil.example:4870' }), { ...api, api: false })).toBe('host');
    expect(checkRequest(headers({ token: undefined }), { ...api, api: false })).toBeUndefined();
    expect(checkRequest(headers({ token: undefined }), api)).toBe('token');
    expect(checkRequest(headers(), api)).toBeUndefined();
    expect(checkRequest(headers({ method: 'POST' }), api)).toBe('origin');
    expect(checkRequest(headers({ method: 'POST', origin: `http://127.0.0.1:${PORT}` }), api)).toBeUndefined();
    expect(checkRequest(headers({ method: 'DELETE', origin: 'http://evil.example' }), api)).toBe('origin');
  });
});
