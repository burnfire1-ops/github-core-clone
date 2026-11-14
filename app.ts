import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

// app.ts — one HTTP server, four surfaces: REST v3, GraphQL, MCP and git
// smart HTTP, all over the same in-memory store.

export function createForgeServer(token: string) {
  const store = new Store();
  const server = createServer((req, res) => {
    handle(req, res, store, token).catch((err) => {
      try {
        res.writeHead(500, { 'content-type': 'application/json', 'x-github-request-id': store.nextRequestId() });
        res.end(JSON.stringify({ message: err instanceof Error ? err.message : 'Internal Server Error' }));
      } catch {
        // response already gone
      }
    });
  });
  // OPT-9: no Nagle delay on accepted sockets, long keep-alive so the
  // read workload's single connection stays open, headers timeout just
  // above the keep-alive timeout.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });
  return server;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, store: Store, status: number, body: string | null, headers: Record<string, string> = {}): void {
  const out: Record<string, string> = { 'content-type': 'application/json', 'x-github-request-id': store.nextRequestId(), ...headers };
  if (body === null) {
    res.writeHead(status, out);
    res.end();
    return;
  }
  out['content-length'] = String(Buffer.byteLength(body));
  res.writeHead(status, out);
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse, store: Store, token: string): Promise<void> {
  const rawUrl = req.url ?? '/';
  const url = new URL(rawUrl, 'http://localhost');
  const method = (req.method ?? 'GET').toUpperCase();
  const segments = url.pathname.split('/').filter((s) => s.length > 0).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const host = req.headers.host ?? 'localhost';
  store.baseUrl = 'http://' + host;

  // Health check: no auth.
  if (method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, store, 200, JSON.stringify({ ok: true }));
    return;
  }

  // Git smart HTTP: no auth (the git CLI carries no bearer token).
  if (segments.length >= 2 && segments[1].endsWith('.git')) {
    const owner = segments[0];
    const repoName = segments[1].slice(0, -'.git'.length);
    const rest = segments.slice(2);
    const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    const result = handleGit(store, method, owner, repoName, rest, url.searchParams, headers, body);
    const out: Record<string, string> = { ...result.headers };
    if (!out['content-type']) out['content-type'] = 'application/octet-stream';
    res.writeHead(result.status, out);
    res.end(result.body);
    return;
  }

  // Authenticated surfaces.
  const needsAuth = segments[0] === 'api' || segments[0] === 'mcp';
  if (needsAuth) {
    const auth = req.headers.authorization ?? '';
    if (auth !== 'Bearer ' + token) {
      sendJson(res, store, 401, JSON.stringify({ message: 'Requires authentication' }));
      return;
    }
  }

  if (segments[0] === 'api' && segments[1] === 'graphql') {
    if (method !== 'POST') {
      sendJson(res, store, 404, JSON.stringify({ message: 'Not Found' }));
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown = null;
    try {
      parsed = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : null;
    } catch {
      sendJson(res, store, 400, JSON.stringify({ message: 'Invalid JSON' }));
      return;
    }
    const result = handleGraphql(store, parsed);
    sendJson(res, store, result.status, result.body);
    return;
  }

  if (segments[0] === 'mcp') {
    const raw = await readBody(req);
    const result = handleMcp(store, method, raw);
    if (result.body === null) {
      res.writeHead(result.status, result.headers);
      res.end();
      return;
    }
    sendJson(res, store, result.status, result.body, result.headers);
    return;
  }

  if (segments[0] === 'api' && segments[1] === 'v3') {
    const restSegments = segments.slice(2);
    let parsedBody: Record<string, unknown> | null = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          const parsed: unknown = JSON.parse(raw.toString('utf8'));
          parsedBody = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
        } catch {
          sendJson(res, store, 400, JSON.stringify({ message: 'Invalid JSON' }));
          return;
        }
      }
    }
    const result = handleRest(store, {
      method,
      segments: restSegments,
      path: url.pathname,
      query: url.searchParams,
      body: parsedBody,
      baseUrl: store.baseUrl,
    });
    sendJson(res, store, result.status, result.body, result.headers);
    return;
  }

  sendJson(res, store, 404, JSON.stringify({ message: 'Not Found' }));
}
