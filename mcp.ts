// mcp.ts — Model Context Protocol over Streamable HTTP (POST /mcp,
// JSON-RPC 2.0). Speaks revision 2026-07-28 and answers server/discover,
// initialize, tools/list and tools/call on the same store as REST.
import { randomUUID } from 'node:crypto';
import type { Store, Repo } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

export interface McpResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// Tool names may carry a server prefix (e.g. github__create_issue); match
// on the suffix, case-insensitively, per the MCP contract.
function matchTool(name: string): ToolDef | null {
  const lower = name.toLowerCase();
  for (const t of TOOLS) {
    if (lower === t.name || lower.endsWith(`__${t.name}`)) return t;
  }
  return null;
}

function textResult(text: string, structured: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function errorResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

function strArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    if (typeof args[k] === 'string' && args[k] !== '') return args[k] as string;
  }
  return '';
}

function resolveRepoArgs(
  store: Store,
  args: Record<string, unknown>,
): { repo: Repo; owner: string } | { error: string } {
  let owner = strArg(args, 'owner') || null;
  let repoName = strArg(args, 'repo', 'repository', 'repo_name') || null;
  const fullName = strArg(args, 'full_name', 'fullName') || null;
  if ((!owner || !repoName) && fullName) {
    const parts = fullName.split('/');
    if (parts.length === 2) {
      if (!owner) owner = parts[0];
      if (!repoName) repoName = parts[1];
    }
  }
  if (!owner) owner = store.ownerLogin() || null;
  if (!owner || !repoName) return { error: 'Missing required argument: owner/repo' };
  if (!store.ownerMatches(owner)) return { error: 'Repository not found' };
  const repo = store.getRepo(repoName);
  if (!repo) return { error: 'Repository not found' };
  return { repo, owner };
}

function callTool(store: Store, toolName: string, args: Record<string, unknown>, host: string): Record<string, unknown> {
  if (toolName === 'create_repo') {
    const fullName = strArg(args, 'full_name', 'fullName') || null;
    let name = strArg(args, 'name') || null;
    let owner = strArg(args, 'owner') || null;
    if (!name && fullName) {
      const parts = fullName.split('/');
      if (parts.length === 2) {
        name = parts[1];
        if (!owner) owner = parts[0];
      }
    }
    if (!name) return errorResult('Missing required argument: name');
    if (owner) store.learnOwner(owner);
    if (store.getRepo(name)) return errorResult(`Repository '${name}' already exists`);
    const repo = store.createRepo(name, {
      isPrivate: args.private === true,
      description: typeof args.description === 'string' ? args.description : '',
    });
    const out = repoJson(store, repo, host);
    return textResult(JSON.stringify(out), out);
  }

  if (toolName === 'get_repo') {
    const resolved = resolveRepoArgs(store, args);
    if ('error' in resolved) return errorResult(resolved.error);
    const out = repoJson(store, resolved.repo, host);
    return textResult(JSON.stringify(out), out);
  }

  if (toolName === 'create_issue') {
    const resolved = resolveRepoArgs(store, args);
    if ('error' in resolved) return errorResult(resolved.error);
    const title = strArg(args, 'title');
    if (!title) return errorResult('Missing required argument: title');
    const issue = store.createIssue(resolved.repo, title, strArg(args, 'body'), []);
    const out = issueJson(store, resolved.repo, issue);
    return textResult(JSON.stringify(out), out);
  }

  if (toolName === 'list_issues') {
    const resolved = resolveRepoArgs(store, args);
    if ('error' in resolved) return errorResult(resolved.error);
    const state = strArg(args, 'state') || 'open';
    let list = [...resolved.repo.issues];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => b.number - a.number);
    const out = list.map((i) => issueJson(store, resolved.repo, i));
    return textResult(JSON.stringify(out), { issues: out, total_count: out.length });
  }

  if (toolName === 'create_pull_request') {
    const resolved = resolveRepoArgs(store, args);
    if ('error' in resolved) return errorResult(resolved.error);
    const title = strArg(args, 'title');
    const head = strArg(args, 'head', 'head_branch', 'head_ref').split(':').pop() ?? '';
    const base = strArg(args, 'base', 'base_branch', 'base_ref').split(':').pop() ?? '';
    if (!title) return errorResult('Missing required argument: title');
    if (!head || !base) return errorResult('Missing required argument: head/base');
    const headSha = store.branchTip(resolved.repo, head);
    const baseSha = store.branchTip(resolved.repo, base);
    if (headSha === null || baseSha === null) return errorResult('head or base branch does not exist');
    const dup = resolved.repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
    if (dup) return errorResult('A pull request already exists for this head and base');
    const pr = store.createPull(resolved.repo, title, strArg(args, 'body'), head, headSha, base, baseSha);
    const out = pullJson(store, resolved.repo, pr);
    return textResult(JSON.stringify(out), out);
  }

  if (toolName === 'merge_pull_request') {
    const resolved = resolveRepoArgs(store, args);
    if ('error' in resolved) return errorResult(resolved.error);
    const rawNum = args.pull_number ?? args.number ?? args.pullNumber;
    const num = typeof rawNum === 'number' ? rawNum : parseInt(String(rawNum ?? ''), 10);
    if (Number.isNaN(num)) return errorResult('Missing required argument: pull_number');
    const pr = resolved.repo.pullByNumber.get(num);
    if (!pr) return errorResult('Pull request not found');
    if (pr.merged) return errorResult('Pull request is already merged');
    if (pr.state === 'closed') return errorResult('Pull request is closed');
    const res = store.squashMerge(resolved.repo, pr);
    if ('conflict' in res) return errorResult('Merge conflict');
    const out = { sha: res.sha, merged: true, message: 'Pull request successfully merged', number: pr.number };
    return textResult(JSON.stringify(out), out);
  }

  return errorResult(`Unknown tool: ${toolName}`);
}

export function handleMcp(store: Store, rawBody: string | null, host: string): McpResponse {
  let body: unknown;
  try {
    body = JSON.parse(rawBody ?? '');
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const req = body as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';

  // Notifications (no id) are acknowledged with 202 and no body.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (id === null) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: missing id' } } };
  }

  const result = (r: unknown, headers?: Record<string, string>): McpResponse => ({
    status: 200,
    headers,
    body: { jsonrpc: '2.0', id, result: r },
  });
  const failure = (code: number, message: string): McpResponse => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
  });

  if (method === 'server/discover') {
    return result({
      protocolVersion: '2026-07-28',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
      serverInfo: { name: 'forge', version: '1.0.0' },
      capabilities: { tools: {} },
    });
  }
  if (method === 'initialize') {
    const params = req.params ?? {};
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    return result(
      {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      },
      { 'mcp-session-id': randomUUID() },
    );
  }
  if (method === 'ping') return result({});
  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const params = req.params ?? {};
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = matchTool(name);
    if (!tool) return failure(-32602, `Unknown tool: ${name}`);
    const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
    return result(callTool(store, tool.name, args, host));
  }
  return failure(-32601, `Method not found: ${method}`);
}
