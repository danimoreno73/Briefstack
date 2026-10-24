import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gitBlobSha } from '../src/skills/github.js';

/**
 * A local stand-in for the two GitHub hosts a skill fetch uses (the REST
 * API and raw.githubusercontent.com), so no test touches the network. It
 * serves only what `src/skills/github.ts` asks for, from repos built in
 * memory, and can misbehave on purpose (rate limit, redirect, wrong bytes,
 * a slow answer, a truncated listing).
 */

export interface FakeFile {
  /** Text or bytes. */
  content: string | Buffer;
  /** `100644` (default), `100755`, `120000` (symlink) or `160000` (submodule). */
  mode?: '100644' | '100755' | '120000' | '160000';
}

export interface FakeCommit {
  /** Every file of the repo at this commit, by path with `/`. */
  files: Record<string, FakeFile | string>;
}

export interface FakeRepo {
  /** Branch and tag names, and `HEAD`, to commit SHAs. */
  refs: Record<string, string>;
  commits: Record<string, FakeCommit>;
}

export interface FakeGitHubOptions {
  /** Answer every API call with a rate-limit 403. */
  rateLimited?: boolean;
  /** Answer the raw host with a redirect. */
  redirectRaw?: boolean;
  /** Serve other bytes for these raw paths (`<path in repo>`). */
  tamper?: Set<string>;
  /** Mark recursive listings as truncated. */
  truncate?: boolean;
  /** Wait this long before answering the raw host. */
  rawDelayMs?: number;
}

export interface FakeGitHub {
  apiBase: string;
  rawBase: string;
  repos: Map<string, FakeRepo>;
  options: FakeGitHubOptions;
  /** Every request path, in order. */
  requests: string[];
  close(): Promise<void>;
}

/** A 40-hex id for a fake commit. */
export const fakeSha = (seed: string): string => createHash('sha1').update(seed).digest('hex');

const treeShaOf = (commit: string, dir: string): string => fakeSha(`tree:${commit}:${dir}`);

interface Entry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

function normalise(file: FakeFile | string): { bytes: Buffer; mode: string } {
  const value = typeof file === 'string' ? { content: file } : file;
  return { bytes: typeof value.content === 'string' ? Buffer.from(value.content, 'utf8') : value.content, mode: value.mode ?? '100644' };
}

/** The entries directly under `dir` (or all under it, `recursive`), relative to `dir`. */
function listing(commit: string, files: Record<string, FakeFile | string>, dir: string, recursive: boolean): Entry[] | undefined {
  const prefix = dir === '' ? '' : `${dir}/`;
  const under = Object.keys(files).filter((path) => path.startsWith(prefix));
  if (dir !== '' && under.length === 0) return undefined;
  const entries = new Map<string, Entry>();
  for (const full of under) {
    const rel = full.slice(prefix.length);
    const parts = rel.split('/');
    const folders = recursive ? parts.length - 1 : Math.min(1, parts.length - 1);
    for (let i = 1; i <= folders; i += 1) {
      const folder = parts.slice(0, i).join('/');
      if (!entries.has(folder)) entries.set(folder, { path: folder, mode: '040000', type: 'tree', sha: treeShaOf(commit, `${prefix}${folder}`) });
    }
    if (!recursive && parts.length > 1) continue;
    const { bytes, mode } = normalise(files[full] as FakeFile | string);
    const type = mode === '160000' ? 'commit' : 'blob';
    entries.set(rel, { path: rel, mode, type, sha: type === 'commit' ? fakeSha(`sub:${full}`) : gitBlobSha(bytes), ...(type === 'blob' ? { size: bytes.length } : {}) });
  }
  return [...entries.values()];
}

export async function startFakeGitHub(repos: Record<string, FakeRepo>, options: FakeGitHubOptions = {}): Promise<FakeGitHub> {
  const state = new Map(Object.entries(repos));
  const requests: string[] = [];

  const send = (res: ServerResponse, status: number, body: string | Buffer, type = 'application/json', headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': type, ...headers });
    res.end(body);
  };

  const findTree = (repo: FakeRepo, sha: string): { commit: string; dir: string } | undefined => {
    for (const [commit, data] of Object.entries(repo.commits)) {
      if (commit === sha) return { commit, dir: '' };
      const dirs = new Set<string>();
      for (const path of Object.keys(data.files)) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
      }
      for (const dir of dirs) if (treeShaOf(commit, dir) === sha) return { commit, dir };
    }
    return undefined;
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(url.pathname + url.search);
    const parts = url.pathname.split('/').filter((p) => p !== '').map(decodeURIComponent);
    if (parts[0] === 'api') {
      if (options.rateLimited) {
        send(res, 403, JSON.stringify({ message: 'API rate limit exceeded' }), 'application/json', {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1792866475',
        });
        return;
      }
      const [, reposWord, owner, name, kind, ...rest] = parts;
      const repo = state.get(`${owner}/${name}`);
      if (reposWord !== 'repos' || repo === undefined) return send(res, 404, '{"message":"Not Found"}');
      if (kind === 'commits') {
        const sha = repo.refs[rest.join('/')] ?? (/^[0-9a-f]{7,40}$/.test(rest.join('/')) ? Object.keys(repo.commits).find((c) => c.startsWith(rest.join('/'))) : undefined);
        if (sha === undefined) return send(res, 422, '{"message":"No commit found"}');
        return send(res, 200, sha, 'application/vnd.github.sha');
      }
      if (kind === 'git' && rest[0] === 'trees' && rest[1] !== undefined) {
        const found = findTree(repo, rest[1]);
        if (found === undefined) return send(res, 404, '{"message":"Not Found"}');
        const entries = listing(found.commit, (repo.commits[found.commit] as FakeCommit).files, found.dir, url.searchParams.has('recursive'));
        if (entries === undefined) return send(res, 404, '{"message":"Not Found"}');
        return send(res, 200, JSON.stringify({ sha: rest[1], tree: entries, truncated: options.truncate === true && url.searchParams.has('recursive') }));
      }
      return send(res, 404, '{"message":"Not Found"}');
    }
    if (parts[0] === 'raw') {
      if (options.redirectRaw) return send(res, 302, '', 'text/plain', { location: 'http://127.0.0.1:1/elsewhere' });
      const [, owner, name, commit, ...rest] = parts;
      const repo = state.get(`${owner}/${name}`);
      const files = commit === undefined ? undefined : repo?.commits[commit]?.files;
      const file = files?.[rest.join('/')];
      if (file === undefined) return send(res, 404, '404: Not Found', 'text/plain');
      const { bytes } = normalise(file);
      const body = options.tamper?.has(rest.join('/')) ? Buffer.concat([bytes, Buffer.from('x')]).subarray(1) : bytes;
      const reply = () => send(res, 200, body, 'text/plain; charset=utf-8');
      if (options.rawDelayMs !== undefined) setTimeout(reply, options.rawDelayMs);
      else reply();
      return;
    }
    send(res, 404, 'Not Found', 'text/plain');
  };

  const server: Server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    apiBase: `${base}/api`,
    rawBase: `${base}/raw`,
    repos: state,
    options,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A small public skills repo: `skills/hello` (markdown only) and `skills/tool` (a script), MIT at the root. */
export function sampleRepo(extra: Record<string, FakeFile | string> = {}): { repo: FakeRepo; commit: string } {
  const commit = fakeSha('sample-1');
  const files: Record<string, FakeFile | string> = {
    LICENSE: 'MIT License\n\nCopyright (c) 2026 Example\n\nPermission is hereby granted, free of charge, to any person obtaining a copy',
    'README.md': '# Skills\n',
    'skills/hello/SKILL.md': '---\nname: hello\ndescription: Says hello in the house style. Use when greeting.\n---\n\n# Hello\n\nGreet warmly.\n',
    'skills/hello/reference.md': '# Reference\n\nMore detail.\n',
    'skills/tool/SKILL.md': '---\nname: tool\ndescription: Runs the helper script.\n---\n\nRun `scripts/run.sh`.\n',
    'skills/tool/scripts/run.sh': { content: '#!/bin/sh\necho hi\n', mode: '100755' },
    ...extra,
  };
  return { repo: { refs: { HEAD: commit, main: commit, 'v1.0': commit, 'feature/x': commit }, commits: { [commit]: { files } } }, commit };
}
