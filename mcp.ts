import {
  Store, Repo,
  createIssueRecord, createPullRecord, mergePullRecord,
  repoView, issueView, pullView,
} from './store.ts';

// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0).
// Speaks revision 2026-07-28; tools act on the same store as REST.

export interface McpResult {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Built once: two tools/list calls answer the same list byte for byte.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        owner: { type: 'string', description: 'Repository owner login' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        repository: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        repository: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        repository: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        repository: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        repository: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
        pullNumber: { type: 'integer', description: 'Pull request number' },
        number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function pickArg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function toolResult(id: unknown, structured: unknown, text: string, isError = false): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result: {
      content: [{ type: 'text', text }],
      structuredContent: structured,
      isError,
    },
  };
}

function toolError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function callTool(store: Store, id: unknown, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = name.toLowerCase().split('__').pop() as string;
  const owner = String(pickArg(args, 'owner') ?? store.ownerLogin ?? '');
  const repoName = String(pickArg(args, 'repo', 'repository') ?? '');

  if (normalized === 'create_repo') {
    const repoTitle = pickArg(args, 'name');
    if (typeof repoTitle !== 'string' || !repoTitle) return toolResult(id, {}, 'Missing required argument: name', true);
    if (store.repos.has(repoTitle)) return toolResult(id, {}, 'Repository already exists', true);
    const repo = new Repo(store.nextRepoId, repoTitle, owner || null, pickArg(args, 'private') === true, String(pickArg(args, 'description') ?? ''));
    store.nextRepoId += 1;
    store.repos.set(repoTitle, repo);
    if (owner) store.learnOwner(owner);
    const view = repoView(store, repo);
    return toolResult(id, view, JSON.stringify(view));
  }

  if (normalized === 'get_repo') {
    if (!owner || !repoName) return toolResult(id, {}, 'Missing required argument: owner or repo', true);
    const repo = store.findRepo(owner, repoName);
    if (!repo) return toolResult(id, {}, 'Repository not found', true);
    const view = repoView(store, repo);
    return toolResult(id, view, JSON.stringify(view));
  }

  if (normalized === 'create_issue') {
    const title = pickArg(args, 'title');
    if (!owner || !repoName || typeof title !== 'string' || !title) return toolResult(id, {}, 'Missing required argument: owner, repo or title', true);
    const repo = store.findRepo(owner, repoName);
    if (!repo) return toolResult(id, {}, 'Repository not found', true);
    const made = createIssueRecord(store, repo, title, String(pickArg(args, 'body') ?? ''), []);
    if (!made.issue) return toolResult(id, {}, made.error as string, true);
    const view = issueView(store, repo, made.issue);
    return toolResult(id, view, JSON.stringify(view));
  }

  if (normalized === 'list_issues') {
    if (!owner || !repoName) return toolResult(id, {}, 'Missing required argument: owner or repo', true);
    const repo = store.findRepo(owner, repoName);
    if (!repo) return toolResult(id, {}, 'Repository not found', true);
    const state = String(pickArg(args, 'state') ?? 'open').toLowerCase();
    let list = repo.issues.slice();
    if (state !== 'all') list = list.filter((i) => i.state === state);
    const views = list.map((i) => issueView(store, repo, i));
    const structured = { issues: views };
    const text = views.length > 0 ? views.map((v) => '#' + (v.number as number) + ' ' + (v.title as string)).join('\n') : 'No issues';
    return toolResult(id, structured, text);
  }

  if (normalized === 'create_pull_request') {
    const title = pickArg(args, 'title');
    const head = pickArg(args, 'head');
    const base = pickArg(args, 'base');
    if (!owner || !repoName || typeof title !== 'string' || !title || typeof head !== 'string' || !head || typeof base !== 'string' || !base) {
      return toolResult(id, {}, 'Missing required argument: owner, repo, title, head or base', true);
    }
    const repo = store.findRepo(owner, repoName);
    if (!repo) return toolResult(id, {}, 'Repository not found', true);
    const made = createPullRecord(store, repo, title, head, base, String(pickArg(args, 'body') ?? ''));
    if (!made.pr) return toolResult(id, {}, made.error as string, true);
    const view = pullView(store, repo, made.pr);
    return toolResult(id, view, JSON.stringify(view));
  }

  if (normalized === 'merge_pull_request') {
    const pullNumber = pickArg(args, 'pull_number', 'pullNumber', 'number');
    if (!owner || !repoName || pullNumber === undefined) return toolResult(id, {}, 'Missing required argument: owner, repo or pull_number', true);
    const repo = store.findRepo(owner, repoName);
    if (!repo) return toolResult(id, {}, 'Repository not found', true);
    const pr = repo.pullsByNumber.get(Number(pullNumber));
    if (!pr) return toolResult(id, {}, 'Pull request not found', true);
    const result = mergePullRecord(repo, pr, 'squash');
    if (result.status !== 200) return toolResult(id, {}, result.message, true);
    const structured = { number: pr.number, merged: true, sha: result.sha, state: 'closed' };
    return toolResult(id, structured, JSON.stringify(structured));
  }

  return toolError(id, -32602, 'Unknown tool: ' + name);
}

export function handleMcp(store: Store, method: string, rawBody: Buffer): McpResult {
  if (method === 'DELETE') return { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' };
  if (method !== 'POST') return { status: 405, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Method Not Allowed' }) };

  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  const msg = body as Record<string, unknown>;
  const id = msg.id ?? null;
  const rpcMethod = typeof msg.method === 'string' ? msg.method : '';
  const params = (msg.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) are acknowledged with 202 and no body.
  if (id === null && !rpcMethod) {
    return { status: 202, headers: {}, body: null };
  }
  if (rpcMethod.startsWith('notifications/')) {
    return { status: 202, headers: {}, body: null };
  }

  const json = (value: unknown): McpResult => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

  if (rpcMethod === 'server/discover') {
    return json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2026-07-28',
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {}, resources: {}, prompts: {} },
      },
    });
  }

  if (rpcMethod === 'initialize') {
    const requested = String((params as Record<string, unknown>).protocolVersion ?? '2026-07-28');
    return json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested,
        capabilities: { tools: {}, logging: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
  }

  if (rpcMethod === 'ping') {
    return json({ jsonrpc: '2.0', id, result: {} });
  }

  if (rpcMethod === 'tools/list') {
    return json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }

  if (rpcMethod === 'tools/call') {
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!name) return json(toolError(id, -32602, 'Missing tool name'));
    return json(callTool(store, id, name, args));
  }

  return json(toolError(id, -32601, 'Method not found: ' + rpcMethod));
}
