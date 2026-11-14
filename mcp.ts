// mcp.ts — MCP (JSON-RPC 2.0 over Streamable HTTP) for the forge.
// Speaks revision 2026-07-28 (server/discover + initialize), offers
// the six canonical github-mcp-server tools, and acts on the same
// store as REST, so objects created here read back over /api/v3.
//
// Schema rule (r4 fix 2.5): never declare both a snake_case and a
// camelCase variant of the same argument. The suite normalizes
// property names (strip non-alphanumerics, lowercase), so an alias
// can only shadow the canonical name. Every tool below declares
// exactly one spelling per argument.

import type { Store, Repo } from './store.ts';
import {
  Repo as RepoClass,
  createIssueRecord,
  createPullRecord,
  mergePullRecord,
  repoView,
  issueView,
  pullView,
} from './store.ts';

export interface McpResult {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';

// ---------------------------------------------------------------- tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; items?: { type: string } }>;
    required: string[];
  };
}

function strProp(description: string): { type: string; description: string } {
  return { type: 'string', description };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Owner login of the repository.'),
        name: strProp('Name of the repository to create.'),
        description: strProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        full_name: strProp('Full name of the repository as owner/name.'),
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
        owner: strProp('Owner login of the repository.'),
        repo: strProp('Name of the repository.'),
        full_name: strProp('Full name of the repository as owner/name.'),
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
        owner: strProp('Owner login of the repository.'),
        repo: strProp('Name of the repository.'),
        title: strProp('Title of the issue.'),
        body: strProp('Body of the issue.'),
        labels: { type: 'array', description: 'Labels to apply to the issue.', items: { type: 'string' } },
        full_name: strProp('Full name of the repository as owner/name.'),
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
        owner: strProp('Owner login of the repository.'),
        repo: strProp('Name of the repository.'),
        state: strProp('Issue state filter: open, closed, or all.'),
        full_name: strProp('Full name of the repository as owner/name.'),
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
        owner: strProp('Owner login of the repository.'),
        repo: strProp('Name of the repository.'),
        title: strProp('Title of the pull request.'),
        head: strProp('Name of the branch with the changes.'),
        base: strProp('Name of the branch the changes merge into.'),
        body: strProp('Body of the pull request.'),
        full_name: strProp('Full name of the repository as owner/name.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Owner login of the repository.'),
        repo: strProp('Name of the repository.'),
        pull_number: { type: 'number', description: 'Number of the pull request to merge.' },
        full_name: strProp('Full name of the repository as owner/name.'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function findTool(name: string): ToolDef | null {
  const wanted = normalizeName(name);
  for (const tool of TOOLS) {
    if (normalizeName(tool.name) === wanted) return tool;
    // A server prefix is allowed (github__create_issue); match as a
    // suffix, case-insensitively.
    if (wanted.endsWith('__' + normalizeName(tool.name))) return tool;
    if (wanted.endsWith(normalizeName(tool.name))) return tool;
  }
  return null;
}

// The suite's normalizer: strip every non-alphanumeric character and
// lowercase. Used both to match tool names and to map incoming
// argument names onto the schema's canonical property names.
function normalizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

// Map each incoming argument onto the nearest schema property: the
// property whose normalized name matches the argument's normalized
// name. A full_name property is filled with owner/repo when it is
// missing and both parts are known.
function mapArguments(tool: ToolDef, raw: Record<string, unknown>): Record<string, unknown> {
  const byNormalized = new Map<string, string>();
  for (const prop of Object.keys(tool.inputSchema.properties)) {
    byNormalized.set(normalizeName(prop), prop);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const canonical = byNormalized.get(normalizeName(key));
    if (canonical) out[canonical] = value;
    else out[key] = value;
  }
  if (out.full_name === undefined && typeof out.owner === 'string' && typeof out.repo === 'string') {
    out.full_name = out.owner + '/' + out.repo;
  }
  return out;
}

function missingRequired(tool: ToolDef, args: Record<string, unknown>): string | null {
  for (const name of tool.inputSchema.required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

// ---------------------------------------------------------------- JSON-RPC

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolResult(text: string, structured: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function toolError(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], structuredContent: { error: text }, isError: true };
}

function findRepoForCall(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = String(args.owner ?? '');
  const repoName = String(args.repo ?? '');
  if (repoName && !owner && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) return store.findRepo(parts[0], parts[1]);
  }
  if (!owner || !repoName) return null;
  return store.findRepo(owner, repoName);
}

// ---------------------------------------------------------------- tools/call

function callTool(store: Store, name: string, rawArgs: Record<string, unknown>): Record<string, unknown> {
  const tool = findTool(name);
  if (!tool) return { __rpcError: { code: -32602, message: 'Unknown tool: ' + name } };
  const args = mapArguments(tool, rawArgs);
  const missing = missingRequired(tool, args);
  if (missing) {
    return { __rpcError: { code: -32602, message: 'Missing required argument: ' + missing } };
  }

  if (tool.name === 'create_repo') {
    const repoName = String(args.name ?? '');
    const owner = typeof args.owner === 'string' && args.owner ? String(args.owner) : (store.ownerLogin ?? '');
    if (store.repos.has(repoName)) return toolError('Repository "' + repoName + '" already exists');
    const repo = new RepoClass(store.nextRepoId, repoName, owner || null, args.private === true, String(args.description ?? ''));
    store.nextRepoId += 1;
    store.repos.set(repoName, repo);
    const view = repoView(store, repo);
    return toolResult(JSON.stringify(view), view as Record<string, unknown>);
  }

  if (tool.name === 'get_repo') {
    const repo = findRepoForCall(store, args);
    if (!repo) return toolError('Repository not found');
    const view = repoView(store, repo);
    return toolResult(JSON.stringify(view), view as Record<string, unknown>);
  }

  if (tool.name === 'create_issue') {
    const repo = findRepoForCall(store, args);
    if (!repo) return toolError('Repository not found');
    const labelNames = Array.isArray(args.labels) ? (args.labels as unknown[]).map((l) => String(l)) : [];
    const created = createIssueRecord(store, repo, String(args.title ?? ''), String(args.body ?? ''), labelNames);
    if (!created.issue) return toolError(created.error ?? 'Could not create issue');
    const view = issueView(store, repo, created.issue);
    return toolResult(JSON.stringify(view), view as Record<string, unknown>);
  }

  if (tool.name === 'list_issues') {
    const repo = findRepoForCall(store, args);
    if (!repo) return toolError('Repository not found');
    const state = String(args.state ?? 'open').toLowerCase();
    const list = repo.issues.filter((issue) => (state === 'all' ? true : state === 'closed' ? issue.state === 'closed' : issue.state === 'open'));
    const views = list.map((issue) => issueView(store, repo, issue));
    return toolResult(JSON.stringify(views), { issues: views });
  }

  if (tool.name === 'create_pull_request') {
    const repo = findRepoForCall(store, args);
    if (!repo) return toolError('Repository not found');
    const created = createPullRecord(
      store,
      repo,
      String(args.title ?? ''),
      String(args.head ?? ''),
      String(args.base ?? ''),
      String(args.body ?? ''),
    );
    if (!created.pr) return toolError(created.error ?? 'Could not create pull request');
    const view = pullView(store, repo, created.pr);
    return toolResult(JSON.stringify(view), view as Record<string, unknown>);
  }

  if (tool.name === 'merge_pull_request') {
    const repo = findRepoForCall(store, args);
    if (!repo) return toolError('Repository not found');
    const number = Number(args.pull_number);
    const pr = repo.pullsByNumber.get(number);
    if (!pr) return toolError('Pull request not found');
    const result = mergePullRecord(repo, pr, 'squash');
    if (result.status !== 200) return toolError(result.message);
    const view = pullView(store, repo, pr) as Record<string, unknown>;
    view.sha = result.sha;
    view.message = result.message;
    return toolResult(JSON.stringify(view), view);
  }

  return { __rpcError: { code: -32602, message: 'Unknown tool: ' + name } };
}

// ---------------------------------------------------------------- entry

export function handleMcp(store: Store, method: string, raw: Buffer): McpResult {
  const m = method.toUpperCase();
  if (m === 'DELETE') {
    return { status: 200, headers: {}, body: null };
  }
  if (m === 'GET') {
    return {
      status: 405,
      headers: {},
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method not allowed' } }),
    };
  }
  if (m !== 'POST') {
    return {
      status: 405,
      headers: {},
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method not allowed' } }),
    };
  }

  let msg: Record<string, unknown>;
  try {
    if (raw.length === 0) throw new Error('empty body');
    msg = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('not an object');
  } catch {
    return {
      status: 400,
      headers: {},
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }

  const id = msg.id ?? null;
  const hasId = msg.id !== undefined && msg.id !== null;
  const rpcMethod = String(msg.method ?? '');

  // Notifications (no id) are acknowledged with 202 and no body.
  if (!hasId) {
    return { status: 202, headers: {}, body: null };
  }

  if (rpcMethod === 'server/discover') {
    return {
      status: 200,
      headers: {},
      body: rpcResult(id, {
        protocolVersion: '2026-07-28',
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
      }),
    };
  }

  if (rpcMethod === 'initialize') {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const requested = String(params.protocolVersion ?? '');
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    return {
      status: 200,
      headers: { 'mcp-session-id': 'session-1' },
      body: rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }

  if (rpcMethod === 'ping') {
    return { status: 200, headers: {}, body: rpcResult(id, {}) };
  }

  if (rpcMethod === 'tools/list') {
    // Built from the same constant table every time, so two calls
    // answer byte for byte identically.
    return { status: 200, headers: {}, body: rpcResult(id, { tools: TOOLS }) };
  }

  if (rpcMethod === 'tools/call') {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const name = String(params.name ?? '');
    const args = ((params.arguments ?? {}) as Record<string, unknown>) ?? {};
    const outcome = callTool(store, name, args);
    const rpcErr = (outcome as Record<string, unknown>).__rpcError as { code: number; message: string } | undefined;
    if (rpcErr) {
      return { status: 200, headers: {}, body: rpcError(id, rpcErr.code, rpcErr.message) };
    }
    return { status: 200, headers: {}, body: rpcResult(id, outcome) };
  }

  return { status: 200, headers: {}, body: rpcError(id, -32601, 'Method not found: ' + rpcMethod) };
}
