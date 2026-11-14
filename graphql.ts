// graphql.ts — a small GraphQL engine for /api/graphql: parser, validator,
// executor and introspection for the documents gh and github-mcp-server send.
// The executor resolves against the same Store as REST, so a mutation's
// result reads back over REST with the same ids.

import { diffFiles } from './rest.ts';
import { type Issue, type Pull, type Repo, type Store } from './store.ts';
import type { Ctx, HandlerResult } from './app.ts';

// ------------------------------------------------------------ lexer
type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      const raw = src.slice(i, j);
      if (raw.includes('.') || raw.includes('e') || raw.includes('E')) tokens.push({ kind: 'float', value: parseFloat(raw) });
      else tokens.push({ kind: 'int', value: parseInt(raw, 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`GraphQL lexer: unexpected character ${ch}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------ AST
interface ValueNode {
  kind: 'variable' | 'string' | 'int' | 'float' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  name?: string;
  value?: unknown;
  values?: ValueNode[];
  fields?: Array<{ name: string; value: ValueNode }>;
}

interface SelectionNode {
  kind: 'field' | 'fragmentSpread' | 'inlineFragment';
  alias?: string;
  name?: string;
  args?: Array<{ name: string; value: ValueNode }>;
  directives?: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }>;
  typeCondition?: string;
  selections?: SelectionNode[];
}

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name?: string;
  variableDefinitions?: Array<{ name: string; defaultValue?: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`GraphQL parser: expected ${value}, got ${JSON.stringify(t)}`);
  }

  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`GraphQL parser: expected name, got ${JSON.stringify(t)}`);
    return t.value;
  }

  parseDocument(): Array<OperationNode | FragmentNode> {
    const defs: Array<OperationNode | FragmentNode> = [];
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        defs.push({ kind: 'operation', operation: 'query', selections: this.parseSelectionSet() });
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const op = this.next().value as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value as string;
        let variableDefinitions: OperationNode['variableDefinitions'];
        if (this.peek().kind === 'punct' && this.peek().value === '(') {
          variableDefinitions = this.parseVariableDefinitions();
        }
        this.parseDirectives();
        defs.push({ kind: 'operation', operation: op, name, variableDefinitions, selections: this.parseSelectionSet() });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('GraphQL parser: expected on in fragment');
        const typeCondition = this.expectName();
        this.parseDirectives();
        defs.push({ kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`GraphQL parser: unexpected token ${JSON.stringify(t)}`);
      }
    }
    return defs;
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue?: ValueNode }> {
    const defs: Array<{ name: string; defaultValue?: ValueNode }> = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): void {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '[') {
      this.parseType();
      this.expectPunct(']');
    } else if (t.kind !== 'name') {
      throw new Error('GraphQL parser: expected type');
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const sels: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        return { kind: 'inlineFragment', typeCondition, directives, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.next().value as string;
        const directives = this.parseDirectives();
        return { kind: 'fragmentSpread', name, directives };
      }
      const directives = this.parseDirectives();
      return { kind: 'inlineFragment', directives, selections: this.parseSelectionSet() };
    }
    const nameOrAlias = this.expectName();
    let alias: string | undefined;
    let name = nameOrAlias;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = nameOrAlias;
      name = this.expectName();
    }
    let args: SelectionNode['args'];
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    const directives = this.parseDirectives();
    let selections: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, directives, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseDirectives(): Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }> {
    const dirs: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }> = [];
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      const name = this.expectName();
      let args: Array<{ name: string; value: ValueNode }> = [];
      if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
      dirs.push({ name, args });
    }
    return dirs;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`GraphQL parser: unexpected value token ${JSON.stringify(t)}`);
  }
}

// ------------------------------------------------------------ values
type GqlValue =
  | { __typename: string; [key: string]: unknown }
  | string
  | number
  | boolean
  | null
  | undefined;

interface GqlContext {
  store: Store;
  host: string;
}

type Resolver = (parent: GqlValue & Record<string, unknown>, args: Record<string, unknown>, ctx: GqlContext) => unknown;

interface FieldDef {
  type: string;
  resolve?: Resolver;
}

const FIELD_NAMES: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'updateIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'description', 'createdAt', 'updatedAt', 'isPrivate'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'avatarUrl', 'url'],
  Actor: ['id', 'login'],
  Ref: ['name', 'target', 'prefix'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileEdge: ['node', 'cursor'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Comment: ['id', 'body', 'author', 'createdAt', 'url'],
  CommentEdge: ['node', 'cursor'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentEdge: ['node', 'cursor'],
  SearchResultItemConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  SearchResultItemEdge: ['node', 'cursor'],
  Label: ['id', 'name', 'color', 'description'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  UpdateIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Schema: ['types', 'queryType', 'mutationType', 'description'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __InputValue: ['name', 'description', 'type'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
};

function fieldDef(type: string, field: string): FieldDef | null {
  if (field === '__typename') return { type: 'String' };
  const names = FIELD_NAMES[type];
  if (!names || !names.includes(field)) return null;
  return { type: 'String' };
}

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function wrapRepo(store: Store, repo: Repo): GqlValue {
  return { __typename: 'Repository', repo, store };
}

function wrapIssue(store: Store, repo: Repo, issue: Issue): GqlValue {
  return { __typename: 'Issue', repo, issue, store };
}

function wrapPull(store: Store, repo: Repo, pull: Pull): GqlValue {
  return { __typename: 'PullRequest', repo, pull, store };
}

function findRepoByOpaqueId(store: Store, id: string): Repo | null {
  const m = /^R_(\d+)$/.exec(id);
  if (!m) return null;
  const repoId = parseInt(m[1], 10);
  for (const repo of store.listRepos()) if (repo.id === repoId) return repo;
  return null;
}

function findIssueByOpaqueId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const m = /^I_(\d+)_(\d+)$/.exec(id);
  if (!m) return null;
  const repo = findRepoByOpaqueId(store, `R_${m[1]}`);
  if (!repo) return null;
  const issue = repo.issues.find((i) => i.number === parseInt(m[2], 10));
  return issue ? { repo, issue } : null;
}

function findPullByOpaqueId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const m = /^PR_(\d+)_(\d+)$/.exec(id);
  if (!m) return null;
  const repo = findRepoByOpaqueId(store, `R_${m[1]}`);
  if (!repo) return null;
  const pull = repo.pulls.find((p) => p.number === parseInt(m[2], 10));
  return pull ? { repo, pull } : null;
}

function issueConnection(store: Store, repo: Repo, args: Record<string, unknown>): GqlValue {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy as { field?: string; direction?: string } | undefined) ?? {};
  const direction = (orderBy.direction ?? 'ASC').toUpperCase();
  const afterNum = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  let list = [...repo.issues];
  if (states) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  if (afterNum !== null) {
    list = list.filter((i) => (direction === 'DESC' ? i.number < afterNum : i.number > afterNum));
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  const startCursor = page.length > 0 ? encodeCursor(page[0].number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((i) => wrapIssue(store, repo, i)),
    edges: page.map((i) => ({ __typename: 'IssueEdge', node: wrapIssue(store, repo, i), cursor: encodeCursor(i.number) })),
    pageInfo: { __typename: 'PageInfo', hasNextPage, hasPreviousPage: false, startCursor, endCursor },
    totalCount: list.length,
  };
}

function pullConnection(store: Store, repo: Repo, args: Record<string, unknown>): GqlValue {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy as { field?: string; direction?: string } | undefined) ?? {};
  const direction = (orderBy.direction ?? 'ASC').toUpperCase();
  const afterNum = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  let list = [...repo.pulls];
  if (states) {
    const wanted = new Set(
      states.map((s) => {
        const v = String(s).toUpperCase();
        return v === 'MERGED' ? 'closed' : v.toLowerCase();
      }),
    );
    list = list.filter((p) => {
      if (p.merged && wanted.has('closed')) return true;
      return wanted.has(p.state);
    });
  }
  list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  if (afterNum !== null) {
    list = list.filter((p) => (direction === 'DESC' ? p.number < afterNum : p.number > afterNum));
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((p) => wrapPull(store, repo, p)),
    edges: page.map((p) => ({ __typename: 'PullRequestEdge', node: wrapPull(store, repo, p), cursor: encodeCursor(p.number) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? encodeCursor(page[0].number) : null,
      endCursor: page.length > 0 ? encodeCursor(page[page.length - 1].number) : null,
    },
    totalCount: list.length,
  };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_p, _a, ctx) => ({ __typename: 'User', login: ctx.store.ownerLogin() || null, id: 1 }),
    repository: (_p, args, ctx) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (ctx.store.learnedOwner !== null && owner !== ctx.store.learnedOwner) return null;
      const repo = ctx.store.getRepo(name);
      if (!repo) return null;
      ctx.store.learnOwner(owner);
      return wrapRepo(ctx.store, repo);
    },
    node: (_p, args, ctx) => {
      const id = String(args.id ?? '');
      const repo = findRepoByOpaqueId(ctx.store, id);
      if (repo) return wrapRepo(ctx.store, repo);
      const issue = findIssueByOpaqueId(ctx.store, id);
      if (issue) return wrapIssue(ctx.store, issue.repo, issue.issue);
      const pull = findPullByOpaqueId(ctx.store, id);
      if (pull) return wrapPull(ctx.store, pull.repo, pull.pull);
      return null;
    },
    search: () => ({ __typename: 'SearchResultItemConnection', nodes: [], edges: [], pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: 0 }),
    __type: (_p, args) => {
      const name = String(args.name ?? '');
      if (FIELD_NAMES[name]) return { __typename: '__Type', name, kind: name.endsWith('Connection') || name.endsWith('Payload') ? 'OBJECT' : 'OBJECT' };
      if (ENUM_VALUES[name]) return { __typename: '__Type', name, kind: 'ENUM' };
      return null;
    },
    __schema: () => ({ __typename: '__Schema', types: Object.keys(FIELD_NAMES).map((n) => ({ __typename: '__Type', name: n, kind: 'OBJECT' })) }),
  },
  Mutation: {
    createIssue: (_p, args, ctx) => {
      const input = (args.input as Record<string, unknown>) ?? {};
      const repo = findRepoByOpaqueId(ctx.store, String(input.repositoryId ?? ''));
      if (!repo) throw new Error('repository not found');
      const issue = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', issue: wrapIssue(ctx.store, repo, issue), clientMutationId: (input.clientMutationId as string | null) ?? null };
    },
    closeIssue: (_p, args, ctx) => {
      const input = (args.input as Record<string, unknown>) ?? {};
      const found = findIssueByOpaqueId(ctx.store, String(input.issueId ?? ''));
      if (!found) throw new Error('issue not found');
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: wrapIssue(ctx.store, found.repo, found.issue), clientMutationId: (input.clientMutationId as string | null) ?? null };
    },
    updateIssue: (_p, args, ctx) => {
      const input = (args.input as Record<string, unknown>) ?? {};
      const found = findIssueByOpaqueId(ctx.store, String(input.issueId ?? input.id ?? ''));
      if (!found) throw new Error('issue not found');
      if (typeof input.title === 'string') found.issue.title = input.title;
      if (typeof input.body === 'string') found.issue.body = input.body;
      if (input.state === 'OPEN') found.issue.state = 'open';
      if (input.state === 'CLOSED') found.issue.state = 'closed';
      return { __typename: 'UpdateIssuePayload', issue: wrapIssue(ctx.store, found.repo, found.issue), clientMutationId: (input.clientMutationId as string | null) ?? null };
    },
    createPullRequest: (_p, args, ctx) => {
      const input = (args.input as Record<string, unknown>) ?? {};
      const repo = findRepoByOpaqueId(ctx.store, String(input.repositoryId ?? ''));
      if (!repo) throw new Error('repository not found');
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headSha || !baseSha) throw new Error('head or base branch not found');
      const pull = ctx.store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), headRef, headSha, baseRef, baseSha);
      pull.mergeable = !ctx.store.prIsConflicted(repo, pull);
      return { __typename: 'CreatePullRequestPayload', pullRequest: wrapPull(ctx.store, repo, pull), clientMutationId: (input.clientMutationId as string | null) ?? null };
    },
    mergePullRequest: (_p, args, ctx) => {
      const input = (args.input as Record<string, unknown>) ?? {};
      const found = findPullByOpaqueId(ctx.store, String(input.pullRequestId ?? ''));
      if (!found) throw new Error('pull request not found');
      const sha = ctx.store.squashMerge(found.repo, found.pull);
      if (sha === null) throw new Error('merge conflict');
      found.pull.merged = true;
      found.pull.state = 'closed';
      found.pull.mergedAt = '2026-01-01T00:00:00Z';
      found.pull.mergeCommitSha = sha;
      return { __typename: 'MergePullRequestPayload', pullRequest: wrapPull(ctx.store, found.repo, found.pull), clientMutationId: (input.clientMutationId as string | null) ?? null };
    },
    addComment: (_p, args, ctx) => {
      const input = (args.input as Record<string, unknown>) ?? {};
      const found = findIssueByOpaqueId(ctx.store, String(input.subjectId ?? ''));
      if (!found) throw new Error('subject not found');
      const comment = {
        id: found.repo.nextCommentId,
        nodeId: `C_${found.repo.id}_${found.issue.number}_${found.repo.nextCommentId}`,
        body: String(input.body ?? ''),
        userLogin: ctx.store.ownerLogin(),
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
      found.repo.nextCommentId += 1;
      const list = found.repo.comments.get(found.issue.number) ?? [];
      list.push(comment);
      found.repo.comments.set(found.issue.number, list);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'CommentEdge',
          node: { __typename: 'Comment', id: comment.nodeId, body: comment.body, author: { __typename: 'User', login: comment.userLogin, id: 1 }, createdAt: comment.createdAt },
          cursor: encodeCursor(comment.id),
        },
        clientMutationId: (input.clientMutationId as string | null) ?? null,
      };
    },
  },
  Repository: {
    id: (p) => `R_${(p.repo as Repo).id}`,
    databaseId: (p) => (p.repo as Repo).id,
    name: (p) => (p.repo as Repo).name,
    nameWithOwner: (p, _a, ctx) => `${ctx.store.ownerLogin()}/${(p.repo as Repo).name}`,
    owner: (_p, _a, ctx) => ({ __typename: 'User', login: ctx.store.ownerLogin(), id: 1 }),
    defaultBranchRef: (p) => ({ __typename: 'Ref', name: (p.repo as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (p, args, ctx) => {
      const repo = p.repo as Repo;
      const issue = repo.issues.find((i) => i.number === (args.number as number));
      return issue ? wrapIssue(ctx.store, repo, issue) : null;
    },
    issues: (p, args, ctx) => issueConnection(ctx.store, p.repo as Repo, args),
    pullRequest: (p, args, ctx) => {
      const repo = p.repo as Repo;
      const pull = repo.pulls.find((x) => x.number === (args.number as number));
      return pull ? wrapPull(ctx.store, repo, pull) : null;
    },
    pullRequests: (p, args, ctx) => pullConnection(ctx.store, p.repo as Repo, args),
    url: (p, _a, ctx) => `http://${ctx.host}/${ctx.store.ownerLogin()}/${(p.repo as Repo).name}`,
    description: (p) => (p.repo as Repo).description,
    createdAt: (p) => (p.repo as Repo).createdAt,
    updatedAt: (p) => (p.repo as Repo).updatedAt,
    isPrivate: (p) => (p.repo as Repo).isPrivate,
  },
  Issue: {
    id: (p) => (p.issue as Issue).nodeId,
    number: (p) => (p.issue as Issue).number,
    title: (p) => (p.issue as Issue).title,
    body: (p) => (p.issue as Issue).body,
    state: (p) => ((p.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    createdAt: (p) => (p.issue as Issue).createdAt,
    updatedAt: (p) => (p.issue as Issue).updatedAt,
    author: (p) => ({ __typename: 'User', login: (p.issue as Issue).userLogin, id: 1 }),
    labels: (p, _a, ctx) => {
      const repo = p.repo as Repo;
      return (p.issue as Issue).labels.map((name) => ({ __typename: 'Label', id: name, name, color: repo.labels.get(name)?.color ?? 'd73a4a', description: '' }));
    },
    comments: (p, _a, ctx) => {
      const repo = p.repo as Repo;
      const issue = p.issue as Issue;
      const list = repo.comments.get(issue.number) ?? [];
      return {
        __typename: 'IssueCommentConnection',
        nodes: list.map((c) => ({ __typename: 'Comment', id: c.nodeId, body: c.body, author: { __typename: 'User', login: c.userLogin, id: 1 }, createdAt: c.createdAt })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: list.length,
      };
    },
    url: (p, _a, ctx) => `http://${ctx.host}/${ctx.store.ownerLogin()}/${(p.repo as Repo).name}/issues/${(p.issue as Issue).number}`,
    repository: (p, _a, ctx) => wrapRepo(ctx.store, p.repo as Repo),
  },
  PullRequest: {
    id: (p) => (p.pull as Pull).nodeId,
    number: (p) => (p.pull as Pull).number,
    title: (p) => (p.pull as Pull).title,
    body: (p) => (p.pull as Pull).body,
    state: (p) => {
      const pull = p.pull as Pull;
      if (pull.merged) return 'MERGED';
      return pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (p) => (p.pull as Pull).merged,
    mergeable: (p) => ((p.pull as Pull).mergeable ? 'MERGEABLE' : 'CONFLICTING'),
    headRefName: (p) => (p.pull as Pull).headRef,
    baseRefName: (p) => (p.pull as Pull).baseRef,
    headRef: (p) => ({ __typename: 'Ref', name: (p.pull as Pull).headRef }),
    baseRef: (p) => ({ __typename: 'Ref', name: (p.pull as Pull).baseRef }),
    files: (p, args, ctx) => {
      const store = ctx.store;
      const files = diffFiles(store, p.pull as Pull);
      const first = typeof args.first === 'number' ? args.first : files.length;
      const nodes = files.slice(0, first).map((f) => ({
        __typename: 'PullRequestFile',
        path: f.filename as string,
        additions: f.additions as number,
        deletions: f.deletions as number,
        changeType: String(f.status).toUpperCase(),
      }));
      return {
        __typename: 'PullRequestFileConnection',
        nodes,
        edges: nodes.map((n, i) => ({ __typename: 'PullRequestFileEdge', node: n, cursor: encodeCursor(i + 1) })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: files.length > nodes.length, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: files.length,
      };
    },
    author: (p) => ({ __typename: 'User', login: (p.pull as Pull).userLogin, id: 1 }),
    createdAt: (p) => (p.pull as Pull).createdAt,
    updatedAt: (p) => (p.pull as Pull).updatedAt,
    url: (p, _a, ctx) => `http://${ctx.host}/${ctx.store.ownerLogin()}/${(p.repo as Repo).name}/pull/${(p.pull as Pull).number}`,
  },
  User: {
    id: (p) => String(p.id ?? 1),
    login: (p) => (p.login as string | null) ?? null,
    name: (p) => (p.login as string | null) ?? null,
    avatarUrl: () => null,
    url: (p, _a, ctx) => `http://${ctx.host}/${p.login as string}`,
  },
  Ref: {
    name: (p) => p.name as string,
    target: (p) => ({ __typename: 'Commit', oid: p.sha ?? null }),
    prefix: () => 'refs/heads/',
  },
  __Type: {
    name: (p) => p.name as string,
    kind: (p) => p.kind as string,
    description: () => null,
    fields: (p, args) => {
      void args;
      const names = FIELD_NAMES[p.name as string] ?? [];
      return names.map((n) => ({ __typename: '__Field', name: n, description: null, args: [], type: { __typename: '__Type', name: 'String', kind: 'SCALAR' } }));
    },
    enumValues: (p, _args) => {
      const values = ENUM_VALUES[p.name as string] ?? [];
      return values.map((v) => ({ __typename: '__EnumValue', name: v, description: null }));
    },
  },
  __Schema: {
    types: (p) => p.types as unknown[],
    queryType: () => ({ __typename: '__Type', name: 'Query', kind: 'OBJECT' }),
    mutationType: () => ({ __typename: '__Type', name: 'Mutation', kind: 'OBJECT' }),
    description: () => null,
  },
  __Field: {
    name: (p) => p.name as string,
    description: () => null,
    args: () => [],
    type: (p) => p.type as unknown,
  },
  __EnumValue: {
    name: (p) => p.name as string,
    description: () => null,
  },
  __InputValue: {
    name: (p) => p.name as string,
    description: () => null,
    type: (p) => p.type as unknown,
  },
};

// Default field resolver: read the property off the parent value.
function defaultResolve(parent: Record<string, unknown>, field: string): unknown {
  return parent[field] ?? null;
}

// ------------------------------------------------------------ execution
interface ExecState {
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentNode>;
  variables: Record<string, unknown>;
  ctx: GqlContext;
}

function evalValue(node: ValueNode, state: ExecState): unknown {
  switch (node.kind) {
    case 'variable':
      return state.variables[node.name as string];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return (node.values ?? []).map((v) => evalValue(v, state));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields ?? []) out[f.name] = evalValue(f.value, state);
      return out;
    }
    default:
      return null;
  }
}

function directiveAllows(node: { directives?: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }> }, state: ExecState): boolean {
  for (const d of node.directives ?? []) {
    const ifArg = d.args.find((a) => a.name === 'if');
    const val = ifArg ? evalValue(ifArg.value, state) : true;
    if (d.name === 'skip' && val === true) return false;
    if (d.name === 'include' && val !== true) return false;
  }
  return true;
}

function executeSelections(
  parentType: string,
  parent: GqlValue,
  selections: SelectionNode[],
  state: ExecState,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (!directiveAllows(sel, state)) continue;
    if (sel.kind === 'fragmentSpread') {
      const frag = state.fragments.get(sel.name as string);
      if (!frag) {
        state.errors.push({ message: `Unknown fragment "${sel.name}".` });
        continue;
      }
      const sub = executeSelections(parentType, parent, frag.selections, state);
      if (sub) Object.assign(out, sub);
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition && sel.typeCondition !== parentType && sel.typeCondition !== 'Node') continue;
      const sub = executeSelections(parentType, parent, sel.selections ?? [], state);
      if (sub) Object.assign(out, sub);
      continue;
    }
    // Field.
    const fieldName = sel.name as string;
    const responseKey = sel.alias ?? fieldName;
    if (fieldName === '__typename') {
      out[responseKey] = parentType;
      continue;
    }
    if (!fieldDef(parentType, fieldName)) {
      state.errors.push({ message: `Cannot query field "${fieldName}" on type "${parentType}".` });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const a of sel.args ?? []) args[a.name] = evalValue(a.value, state);
    const resolver = RESOLVERS[parentType]?.[fieldName];
    let raw: unknown;
    try {
      raw = resolver ? resolver(parent as GqlValue & Record<string, unknown>, args, state.ctx) : defaultResolve(parent as Record<string, unknown>, fieldName);
    } catch (err) {
      state.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[responseKey] = null;
      continue;
    }
    if (sel.selections && sel.selections.length > 0) {
      const fieldType = inferFieldType(parentType, fieldName, raw);
      out[responseKey] = resolveWithSelections(fieldType, raw, sel.selections, state);
    } else {
      out[responseKey] = raw === undefined ? null : raw;
    }
  }
  return out;
}

function inferFieldType(parentType: string, fieldName: string, raw: unknown): string {
  if (raw !== null && typeof raw === 'object' && '__typename' in (raw as Record<string, unknown>)) {
    return String((raw as Record<string, unknown>).__typename);
  }
  void parentType;
  void fieldName;
  return 'String';
}

function resolveWithSelections(
  fieldType: string,
  raw: unknown,
  selections: SelectionNode[],
  state: ExecState,
): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) {
    return raw.map((item) => resolveWithSelections(fieldType, item, selections, state));
  }
  if (typeof raw === 'object') {
    const obj = raw as GqlValue & Record<string, unknown>;
    const typeName = typeof obj.__typename === 'string' ? obj.__typename : fieldType;
    return executeSelections(typeName, obj as GqlValue, selections, state);
  }
  return raw;
}

function executeOperation(op: OperationNode, fragments: Map<string, FragmentNode>, variables: Record<string, unknown>, ctx: GqlContext): Record<string, unknown> {
  const state: ExecState = { errors: [], fragments, variables: { ...variables }, ctx };
  // Apply variable defaults.
  for (const def of op.variableDefinitions ?? []) {
    if (state.variables[def.name] === undefined && def.defaultValue) {
      state.variables[def.name] = evalValue(def.defaultValue, state);
    }
  }
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlValue = { __typename: rootType };
  let data: Record<string, unknown> | null = null;
  try {
    data = executeSelections(rootType, root, op.selections, state);
  } catch (err) {
    state.errors.push({ message: err instanceof Error ? err.message : String(err) });
  }
  if (state.errors.length > 0) return { data: null, errors: state.errors };
  return { data };
}

export function handleGraphql(store: Store, ctx: Ctx): HandlerResult {
  const body = ctx.bodyJson;
  const gqlCtx: GqlContext = { store, host: ctx.host };
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (doc === null || typeof doc !== 'object') return { data: null, errors: [{ message: 'Invalid GraphQL document.' }] };
    const query = (doc as { query?: unknown }).query;
    const variables = ((doc as { variables?: unknown }).variables as Record<string, unknown> | undefined) ?? {};
    if (typeof query !== 'string') return { data: null, errors: [{ message: 'Must provide query string.' }] };
    let defs: Array<OperationNode | FragmentNode>;
    try {
      defs = new Parser(lex(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    const fragments = new Map<string, FragmentNode>();
    for (const d of defs) if (d.kind === 'fragment') fragments.set(d.name, d);
    const op = defs.find((d) => d.kind === 'operation') as OperationNode | undefined;
    if (!op) return { data: null, errors: [{ message: 'No operation provided.' }] };
    return executeOperation(op, fragments, variables, gqlCtx);
  };
  const result = Array.isArray(body) ? body.map(runOne) : runOne(body);
  return {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(result),
  };
}
