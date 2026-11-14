// mcp.ts — Model Context Protocol endpoint (POST /mcp, JSON-RPC 2.0 over
// Streamable HTTP). Speaks revision 2026-07-28 and the older handshake.
// Tools act on the same Store as REST and GraphQL.
// Tool names match as a suffix, case-insensitively, so a server prefix such
// as github__create_issue still resolves to the canonical tool.

import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Repo, Store } from './store.ts';
import type { Ctx, HandlerResult } from './app.ts';

const PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

// The tool list is built once so two tools/list calls answer byte for byte.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user)' },
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
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories of the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user)' },
      },
      required: [],
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
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'integer', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function jsonRpc(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Pick an argument by its canonical name or any accepted alias. */
function pick(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    if (args[n] !== undefined && args[n] !== null) return args[n];
  }
  return undefined;
}

function missingArg(name: string): Record<string, unknown> {
  return jsonRpcError(null, -32602, `Invalid params: missing required argument "${name}"`);
}

function toolResult(structured: unknown): Record<string, unknown> {
  const text = typeof structured === 'string' ? structured : JSON.stringify(structured);
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function resolveRepoForTool(store: Store, owner: unknown, repoName: unknown): { repo: Repo | null; error?: string } {
  const name = typeof repoName === 'string' ? repoName : '';
  if (name === '') return { repo: null, error: 'repository name is required' };
  if (typeof owner === 'string' && owner !== '') {
    if (store.learnedOwner !== null && owner !== store.learnedOwner) return { repo: null, error: 'Not Found' };
    store.learnOwner(owner);
  }
  const repo = store.getRepo(name);
  if (!repo) return { repo: null, error: 'Not Found' };
  return { repo };
}

export function handleMcp(store: Store, ctx: Ctx): HandlerResult {
  const host = ctx.host;
  if (ctx.method === 'DELETE') {
    return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{}' };
  }
  if (ctx.method !== 'POST') {
    return { status: 405, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ message: 'Method Not Allowed' }) };
  }
  const raw = ctx.body.toString('utf8');
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(jsonRpcError(null, -32700, 'Parse error')),
    };
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(jsonRpcError(null, -32700, 'Parse error')),
    };
  }
  const { method, id, params } = msg as { method?: unknown; id?: unknown; params?: unknown };
  const isNotification = id === undefined;
  const paramsObj = (params !== null && typeof params === 'object' && !Array.isArray(params) ? params : {}) as Record<string, unknown>;

  // Notifications (no id) are acknowledged with 202 and no body.
  if (isNotification) {
    return { status: 202, headers: {}, body: '' };
  }

  const respond = (payload: Record<string, unknown>): HandlerResult => ({
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });

  if (method === 'server/discover') {
    return respond(
      jsonRpc(id, {
        protocolVersion: PROTOCOL_VERSION,
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: { name: 'forge', version: '1.0.0' },
        capabilities: { tools: {} },
      }),
    );
  }

  if (method === 'initialize') {
    const requested = typeof paramsObj.protocolVersion === 'string' ? paramsObj.protocolVersion : PROTOCOL_VERSION;
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
    return respond(
      jsonRpc(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      }),
    );
  }

  if (method === 'ping') {
    return respond(jsonRpc(id, {}));
  }

  if (method === 'tools/list') {
    return respond(jsonRpc(id, { tools: TOOLS }));
  }

  if (method === 'tools/call') {
    const nameRaw = typeof paramsObj.name === 'string' ? paramsObj.name : '';
    const args = (paramsObj.arguments !== null && typeof paramsObj.arguments === 'object' && !Array.isArray(paramsObj.arguments)
      ? paramsObj.arguments
      : {}) as Record<string, unknown>;
    // A server prefix is allowed (github__create_issue); match as a suffix, case-insensitively.
    const normalized = nameRaw.toLowerCase().replace(/^.*__/, '');
    const tool = TOOLS.find((t) => t.name === normalized);
    if (!tool) {
      return respond(jsonRpcError(id, -32602, `Unknown tool: ${nameRaw}`));
    }
    try {
      const result = callTool(store, tool.name, args, host);
      if (result && typeof result === 'object' && 'error' in (result as Record<string, unknown>)) {
        return respond(jsonRpcError(id, -32602, String((result as Record<string, unknown>).error)));
      }
      return respond(jsonRpc(id, result));
    } catch (err) {
      return respond(jsonRpcError(id, -32602, err instanceof Error ? err.message : String(err)));
    }
  }

  return respond(jsonRpcError(id, -32601, `Method not found: ${String(method)}`));
}

function callTool(store: Store, name: string, args: Record<string, unknown>, host: string): unknown {
  switch (name) {
    case 'create_repo': {
      const repoName = pick(args, 'name', 'repository', 'repo');
      if (typeof repoName !== 'string' || repoName.trim() === '') return { error: 'missing required argument "name"' };
      const owner = pick(args, 'owner');
      if (typeof owner === 'string' && owner !== '') {
        if (store.learnedOwner !== null && owner !== store.learnedOwner) return { error: 'Not Found' };
        store.learnOwner(owner);
      }
      if (store.getRepo(repoName)) return { error: `Repository ${repoName} already exists` };
      const repo = store.createRepo(repoName, {
        description: typeof pick(args, 'description') === 'string' ? (pick(args, 'description') as string) : '',
        isPrivate: pick(args, 'private', 'isPrivate') === true,
      });
      const out = repoJson(store, repo, host);
      out.full_name = `${store.ownerLogin()}/${repo.name}`;
      return toolResult(out);
    }
    case 'get_repo': {
      const { repo, error } = resolveRepoForTool(store, pick(args, 'owner'), pick(args, 'repo', 'repository', 'name', 'repositoryName'));
      if (!repo) return { error: error ?? 'Not Found' };
      const out = repoJson(store, repo, host);
      out.full_name = `${store.ownerLogin()}/${repo.name}`;
      return toolResult(out);
    }
    case 'list_repos': {
      const owner = pick(args, 'owner');
      if (typeof owner === 'string' && owner !== '') store.learnOwner(owner);
      const list = store.listRepos().map((r) => {
        const out = repoJson(store, r, host);
        out.full_name = `${store.ownerLogin()}/${r.name}`;
        return out;
      });
      return toolResult({ repositories: list });
    }
    case 'create_issue': {
      const { repo, error } = resolveRepoForTool(store, pick(args, 'owner'), pick(args, 'repo', 'repository', 'name', 'repositoryName'));
      if (!repo) return { error: error ?? 'Not Found' };
      const title = pick(args, 'title');
      if (typeof title !== 'string' || title.trim() === '') return { error: 'missing required argument "title"' };
      const body = typeof pick(args, 'body', 'description') === 'string' ? (pick(args, 'body', 'description') as string) : '';
      const issue = store.createIssue(repo, title, body, []);
      return toolResult(issueJson(store, repo, issue, host));
    }
    case 'get_issue': {
      const { repo, error } = resolveRepoForTool(store, pick(args, 'owner'), pick(args, 'repo', 'repository', 'name', 'repositoryName'));
      if (!repo) return { error: error ?? 'Not Found' };
      const num = Number(pick(args, 'issue_number', 'number', 'issueNumber'));
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) return { error: 'Not Found' };
      return toolResult(issueJson(store, repo, issue, host));
    }
    case 'list_issues': {
      const { repo, error } = resolveRepoForTool(store, pick(args, 'owner'), pick(args, 'repo', 'repository', 'name', 'repositoryName'));
      if (!repo) return { error: error ?? 'Not Found' };
      const state = typeof pick(args, 'state', 'status') === 'string' ? String(pick(args, 'state', 'status')) : 'open';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => a.number - b.number);
      return toolResult({ issues: list.map((i) => issueJson(store, repo, i, host)) });
    }
    case 'create_pull_request': {
      const { repo, error } = resolveRepoForTool(store, pick(args, 'owner'), pick(args, 'repo', 'repository', 'name', 'repositoryName'));
      if (!repo) return { error: error ?? 'Not Found' };
      const title = pick(args, 'title');
      const head = pick(args, 'head', 'headRef', 'headBranch', 'source', 'source_branch');
      const base = pick(args, 'base', 'baseRef', 'baseBranch', 'target', 'target_branch');
      if (typeof title !== 'string' || title.trim() === '') return { error: 'missing required argument "title"' };
      if (typeof head !== 'string' || head === '') return { error: 'missing required argument "head"' };
      if (typeof base !== 'string' || base === '') return { error: 'missing required argument "base"' };
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return { error: 'head or base branch not found' };
      if (repo.pulls.some((p) => p.state === 'open' && p.headRef === head && p.baseRef === base)) {
        return { error: 'a pull request already exists for this head and base' };
      }
      const body = typeof pick(args, 'body', 'description') === 'string' ? (pick(args, 'body', 'description') as string) : '';
      const pull = store.createPull(repo, title, body, head, headSha, base, baseSha);
      pull.mergeable = !store.prIsConflicted(repo, pull);
      return toolResult(pullJson(store, repo, pull, host));
    }
    case 'list_pull_requests': {
      const { repo, error } = resolveRepoForTool(store, pick(args, 'owner'), pick(args, 'repo', 'repository', 'name', 'repositoryName'));
      if (!repo) return { error: error ?? 'Not Found' };
      const state = typeof pick(args, 'state', 'status') === 'string' ? String(pick(args, 'state', 'status')) : 'open';
      let list = [...repo.pulls];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.number - a.number);
      return toolResult({ pull_requests: list.map((p) => pullJson(store, repo, p, host)) });
    }
    case 'merge_pull_request': {
      const { repo, error } = resolveRepoForTool(store, pick(args, 'owner'), pick(args, 'repo', 'repository', 'name', 'repositoryName'));
      if (!repo) return { error: error ?? 'Not Found' };
      const num = Number(pick(args, 'pull_number', 'number', 'pullNumber', 'pr_number'));
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return { error: 'Not Found' };
      if (pull.merged || pull.state === 'closed') return { error: 'pull request is already closed' };
      const sha = store.squashMerge(repo, pull);
      if (sha === null) return { error: 'merge conflict' };
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = '2026-01-01T00:00:00Z';
      pull.mergeCommitSha = sha;
      return toolResult({ sha, merged: true, message: 'Pull Request successfully merged', number: pull.number });
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

export { missingArg };
