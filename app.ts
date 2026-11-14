// app.ts — one HTTP server: git smart HTTP at /{owner}/{repo}.git, REST v3
// under /api/v3, GraphQL at /api/graphql, MCP at /mcp, and a no-auth
// /healthz. Every REST/GraphQL/MCP reply is JSON with a non-empty
// X-GitHub-Request-Id header; git replies are pkt-line framed.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { gitInfoRefs, gitReceivePack, gitUploadPack } from './git.ts';

const MAX_BODY = 512 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY) {
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': randomUUID(),
    ...(extraHeaders ?? {}),
  };
  if (status === 204 || body === null || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  headers['content-length'] = String(payload.length);
  res.writeHead(status, headers);
  res.end(payload);
}

async function handleRequest(store: Store, expectedToken: string | null, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const method = req.method ?? 'GET';
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP carries no bearer token (the git CLI sends none), so the
  // forge's git endpoints are unauthenticated by design; the repository is
  // still resolved against the learned owner login.
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const rest = gitMatch[3] ?? '';
    const gitProtocol = req.headers['git-protocol'] ?? '';
    if (method === 'GET' && rest === '/info/refs') {
      const r = gitInfoRefs(store, owner, repoName, url.searchParams.get('service') ?? '', gitProtocol);
      if (r.contentType === 'application/json') {
        sendJson(res, r.status, JSON.parse(r.body.toString('utf8')));
        return;
      }
      res.writeHead(r.status, {
        'content-type': r.contentType,
        'content-length': String(r.body.length),
        'cache-control': 'no-cache, max-age=0, must-revalidate',
        pragma: 'no-cache',
        expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
      });
      res.end(r.body);
      return;
    }
    if (method === 'POST' && rest === '/git-upload-pack') {
      const body = await readBody(req);
      const r = gitUploadPack(store, owner, repoName, body, gitProtocol);
      if (r.contentType === 'application/json') {
        sendJson(res, r.status, JSON.parse(r.body.toString('utf8')));
        return;
      }
      res.writeHead(r.status, { 'content-type': r.contentType, 'content-length': String(r.body.length) });
      res.end(r.body);
      return;
    }
    if (method === 'POST' && rest === '/git-receive-pack') {
      const body = await readBody(req);
      const r = gitReceivePack(store, owner, repoName, body);
      if (r.contentType === 'application/json') {
        sendJson(res, r.status, JSON.parse(r.body.toString('utf8')));
        return;
      }
      res.writeHead(r.status, { 'content-type': r.contentType, 'content-length': String(r.body.length) });
      res.end(r.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // MCP: DELETE answers 200 without auth; POST needs the token.
  if (pathname === '/mcp') {
    if (method === 'DELETE') {
      sendJson(res, 200, {});
      return;
    }
    if (method === 'POST') {
      if (expectedToken !== null && req.headers.authorization !== `Bearer ${expectedToken}`) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
      const body = await readBody(req);
      const r = handleMcp(store, body.length === 0 ? null : body.toString('utf8'), host);
      if (r.status === 202 || r.body === null) {
        res.writeHead(r.status, { 'x-github-request-id': randomUUID(), ...(r.headers ?? {}) });
        res.end();
        return;
      }
      sendJson(res, r.status, r.body, r.headers);
      return;
    }
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  // GraphQL
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (expectedToken !== null && req.headers.authorization !== `Bearer ${expectedToken}`) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const body = await readBody(req);
    const r = handleGraphql(store, body.length === 0 ? null : body.toString('utf8'), host);
    sendJson(res, r.status, r.body);
    return;
  }

  // REST v3
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (expectedToken !== null && req.headers.authorization !== `Bearer ${expectedToken}`) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    const body = hasBody ? await readBody(req) : null;
    const r = handleRest(store, method, pathname, url, body && body.length > 0 ? body.toString('utf8') : null, host);
    if (r.status === 204 || r.body === null) {
      res.writeHead(204, { 'x-github-request-id': randomUUID(), ...(r.headers ?? {}) });
      res.end();
      return;
    }
    sendJson(res, r.status, r.body, r.headers);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

export function createApp(store: Store, expectedToken: string | null): http.Server {
  const server = http.createServer((req, res) => {
    handleRequest(store, expectedToken, req, res).catch((e: Error) => {
      console.error('request error:', e.message);
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal error' });
      } else {
        res.end();
      }
    });
  });
  return server;
}
