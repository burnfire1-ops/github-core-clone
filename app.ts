// app.ts — the HTTP server: routing, auth, JSON body parsing, request ids.
// Routes: /healthz (no auth), /{owner}/{repo}.git (git smart HTTP, no auth),
// /api/v3 (REST), /api/graphql, /mcp. Everything else is a JSON 404.
// The server keeps one Store for the process lifetime; all four surfaces read
// and write that same store, so a repo created over MCP reads back over REST.

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import {
  handleReceivePack,
  handleUploadPackV0,
  handleUploadPackV2,
  v0ReceiveAdvertisement,
  v0UploadAdvertisement,
  v2Advertisement,
} from './git.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

export interface Ctx {
  method: string;
  pathname: string;
  segments: string[];
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  bodyJson: unknown;
  host: string;
  requestId: string;
  token: string;
}

export interface HandlerResult {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function jsonError(status: number, message: string, requestId: string): HandlerResult {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId },
    body: JSON.stringify({ message }),
  };
}

export function createApp(): http.Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = http.createServer((req, res) => {
    const requestId = randomUUID();
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      void handleRequest().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        send(jsonError(500, message, requestId));
      });
    });
    req.on('error', () => {
      try {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Bad Request' }));
      } catch {
        // Socket already gone.
      }
    });

    function send(result: HandlerResult): void {
      const headers: Record<string, string> = { ...(result.headers ?? {}) };
      if (!('x-github-request-id' in headers)) headers['x-github-request-id'] = requestId;
      const body = result.body ?? '';
      if (typeof body === 'string') headers['content-length'] = String(Buffer.byteLength(body));
      else headers['content-length'] = String(body.length);
      res.writeHead(result.status, headers);
      res.end(body);
    }

    async function handleRequest(): Promise<void> {
      if (tooLarge) {
        send(jsonError(413, 'Request body too large', requestId));
        return;
      }
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const pathname = url.pathname;
      const segments = pathname.split('/').filter((s) => s.length > 0);
      const method = (req.method ?? 'GET').toUpperCase();
      const host = req.headers.host ?? '127.0.0.1';

      // JSON body parsing (REST + GraphQL + MCP). A malformed body is a 400
      // here; MCP overrides it with its own -32700 response below.
      let bodyJson: unknown = undefined;
      let bodyMalformed = false;
      const contentType = String(req.headers['content-type'] ?? '');
      if (body.length > 0 && (contentType.includes('application/json') || method === 'POST')) {
        try {
          bodyJson = JSON.parse(body.toString('utf8'));
        } catch {
          bodyMalformed = true;
        }
      }

      const ctx: Ctx = {
        method,
        pathname,
        segments,
        query: url.searchParams,
        headers: req.headers,
        body,
        bodyJson,
        host,
        requestId,
        token,
      };

      // /healthz: no auth, always up.
      if (pathname === '/healthz') {
        send({ status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"ok":true}' });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      if (segments.length >= 2 && segments[1].endsWith('.git')) {
        const owner = decodeURIComponentSafe(segments[0]);
        const repoName = decodeURIComponentSafe(segments[1].slice(0, -4));
        const tail = segments.slice(2);
        handleGit(store, ctx, owner, repoName, tail, body, send);
        return;
      }

      // Auth for the API surfaces.
      const authHeader = String(req.headers.authorization ?? '');
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (token !== '' && bearer !== token) {
        send(jsonError(401, 'Requires authentication', requestId));
        return;
      }

      if (pathname === '/api/graphql') {
        if (method !== 'POST') {
          send(jsonError(405, 'Method Not Allowed', requestId));
          return;
        }
        if (bodyMalformed) {
          send(jsonError(400, 'Invalid JSON', requestId));
          return;
        }
        send(handleGraphql(store, ctx));
        return;
      }

      if (pathname === '/mcp') {
        send(handleMcp(store, ctx));
        return;
      }

      if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
        if (bodyMalformed && method !== 'GET') {
          send(jsonError(400, 'Invalid JSON', requestId));
          return;
        }
        send(handleRest(store, ctx));
        return;
      }

      send(jsonError(404, 'Not Found', requestId));
    }
  });
  return server;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function handleGit(
  store: Store,
  ctx: Ctx,
  owner: string,
  repoName: string,
  tail: string[],
  body: Buffer,
  send: (r: HandlerResult) => void,
): void {
  const requestId = ctx.requestId;
  // Learn the owner only when the repo exists; a foreign owner never 403s.
  const repo = store.getRepo(repoName);
  if (!repo) {
    send(jsonError(404, 'Not Found', requestId));
    return;
  }
  if (store.learnedOwner !== null && owner !== store.learnedOwner) {
    send(jsonError(404, 'Not Found', requestId));
    return;
  }
  store.learnOwner(owner);
  const refs = repo.refs;
  const defaultBranch = repo.defaultBranch;

  if (ctx.method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = ctx.query.get('service') ?? '';
    const v2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
    if (service === 'git-upload-pack') {
      if (v2) {
        send({ status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' }, body: v2Advertisement() });
      } else {
        send({ status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' }, body: v0UploadAdvertisement(refs, defaultBranch) });
      }
      return;
    }
    if (service === 'git-receive-pack') {
      send({ status: 200, headers: { 'content-type': 'application/x-git-receive-pack-advertisement' }, body: v0ReceiveAdvertisement(refs, defaultBranch) });
      return;
    }
    send(jsonError(404, 'Not Found', requestId));
    return;
  }

  if (ctx.method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    const v2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
    try {
      const out = v2 ? handleUploadPackV2(store, refs, body) : handleUploadPackV0(store, refs, body, defaultBranch);
      send({ status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: out });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({ status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: Buffer.concat([Buffer.from(`ERR ${message}\n`, 'utf8')]) });
    }
    return;
  }

  if (ctx.method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    try {
      const out = handleReceivePack(store, refs, body);
      send({ status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body: out });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({ status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body: Buffer.from(`ERR ${message}\n`, 'utf8') });
    }
    return;
  }

  send(jsonError(404, 'Not Found', requestId));
}
