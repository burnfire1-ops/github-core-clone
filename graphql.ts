// graphql.ts — a small GraphQL engine over the forge store: a
// tokenizer + recursive-descent parser for queries, mutations,
// fragments, variables and aliases; a field resolver per object
// type; and the introspection surface gh and github-mcp-server
// expect. No external dependency, stdlib only.

import type { Store, Repo, Issue, Pull } from './store.ts';
import {
  decodeId,
  encodeId,
  createIssueRecord,
  addCommentRecord,
  createPullRecord,
  mergePullRecord,
  prFiles,
  FIXED_TS,
} from './store.ts';

export interface GraphqlResult {
  status: number;
  body: string;
}

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldSelection {
  kind: 'field';
  name: string;
  alias: string | null;
  args: { name: string; value: Value }[];
  selections: Selection[];
}

interface InlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  selections: Selection[];
}

interface Spread {
  kind: 'spread';
  name: string;
}

type Selection = FieldSelection | InlineFragment | Spread;

interface Operation {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; value: Value | null }[];
  selections: Selection[];
}

interface FragmentDef {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: Selection[];
}

type Definition = Operation | FragmentDef;

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'ellipsis';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === ';') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ kind: 'ellipsis', value: '...' });
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
      if (src[j] === '"' && src[j + 1] === '"') {
        j += 2;
        while (j < src.length && !(src[j] === '"' && src[j + 1] === '"' && src[j + 2] === '"')) {
          out += src[j];
          j += 1;
        }
        j += 3;
      } else {
        while (j < src.length && src[j] !== '"') {
          if (src[j] === '\\' && j + 1 < src.length) {
            const esc = src[j + 1];
            if (esc === 'n') out += '\n';
            else if (esc === 't') out += '\t';
            else if (esc === 'r') out += '\r';
            else out += esc;
            j += 2;
          } else {
            out += src[j];
            j += 1;
          }
        }
        j += 1;
      }
      tokens.push({ kind: 'string', value: out });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let text = '';
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) {
        text += src[j];
        j += 1;
      }
      tokens.push({ kind: 'number', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      let text = '';
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) {
        text += src[j];
        j += 1;
      }
      tokens.push({ kind: 'name', value: text });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  tokens: Token[];
  pos: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }

  next(): Token | null {
    const t = this.tokens[this.pos] ?? null;
    if (t) this.pos += 1;
    return t;
  }

  expectPunct(value: string): void {
    const t = this.next();
    if (!t || t.kind !== 'punct' || t.value !== value) throw new Error('expected ' + value);
  }

  peekPunct(value: string): boolean {
    const t = this.peek();
    return !!t && t.kind === 'punct' && t.value === value;
  }

  expectName(): string {
    const t = this.next();
    if (!t || t.kind !== 'name') throw new Error('expected name');
    return t.value;
  }

  parseDocument(): Definition[] {
    const defs: Definition[] = [];
    while (this.peek()) defs.push(this.parseDefinition());
    return defs;
  }

  parseDefinition(): Definition {
    const t = this.peek();
    if (t && t.kind === 'name' && t.value === 'fragment') {
      this.next();
      const name = this.expectName();
      const on = this.expectName();
      if (on !== 'on') throw new Error('expected on');
      const typeCondition = this.expectName();
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', name, typeCondition, selections };
    }
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (t && t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      operation = t.value as 'query' | 'mutation';
      this.next();
      const n = this.peek();
      if (n && n.kind === 'name') name = this.next()?.value ?? null;
    }
    const variables: { name: string; value: Value | null }[] = [];
    if (this.peekPunct('(')) variables.push(...this.parseVariableDefinitions());
    const selections = this.parseSelectionSet();
    return { kind: 'operation', operation, name, variables, selections };
  }

  parseVariableDefinitions(): { name: string; value: Value | null }[] {
    const out: { name: string; value: Value | null }[] = [];
    this.expectPunct('(');
    while (!this.peekPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      // Skip the type annotation (names, brackets, !) and an optional
      // default value.
      let depth = 0;
      for (;;) {
        const t = this.peek();
        if (!t) break;
        if (t.kind === 'punct' && t.value === '[') depth += 1;
        if (t.kind === 'punct' && t.value === ']') depth -= 1;
        if (depth === 0 && t.kind === 'punct' && (t.value === '=' || t.value === ')' || t.value === ',')) break;
        this.next();
      }
      let def: Value | null = null;
      if (this.peekPunct('=')) {
        this.next();
        def = this.parseValue();
      }
      out.push({ name, value: def });
      if (this.peekPunct(',')) this.next();
    }
    this.expectPunct(')');
    return out;
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.peekPunct('}')) {
      if (!this.peek()) throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): Selection {
    const t = this.peek();
    if (t && t.kind === 'ellipsis') {
      this.next();
      const n = this.peek();
      if (n && n.kind === 'name' && n.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (n && n.kind === 'name') {
        return { kind: 'spread', name: this.next()?.value ?? '' };
      }
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peekPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: { name: string; value: Value }[] = [];
    if (this.peekPunct('(')) {
      this.next();
      while (!this.peekPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
        if (this.peekPunct(',')) this.next();
      }
      this.expectPunct(')');
    }
    // Directives (@skip/@include/...) are accepted and ignored.
    while (this.peekPunct('@')) {
      this.next();
      this.expectName();
      if (this.peekPunct('(')) {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const tok = this.next();
          if (!tok) break;
          if (tok.kind === 'punct' && tok.value === '(') depth += 1;
          if (tok.kind === 'punct' && tok.value === ')') depth -= 1;
        }
      }
    }
    let selections: Selection[] = [];
    if (this.peekPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  parseValue(): Value {
    const t = this.next();
    if (!t) throw new Error('expected value');
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: Value[] = [];
      while (!this.peekPunct(']')) {
        items.push(this.parseValue());
        if (this.peekPunct(',')) this.next();
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (!this.peekPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
        if (this.peekPunct(',')) this.next();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'number') {
      return /[.eE]/.test(t.value)
        ? { kind: 'float', value: parseFloat(t.value) }
        : { kind: 'int', value: parseInt(t.value, 10) };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error('unexpected token in value');
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': {
      const v = variables[value.name];
      return v === undefined ? null : v;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of value.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argsMap(field: FieldSelection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------- schema tables

// Declared fields per object type, used by introspection and by the
// unknown-field check. The resolver itself is structural: a field the
// schema does not list is an error, never a silent null.
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['repository', 'node', 'viewer', 'search', '__schema', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'url', 'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels'],
  User: ['id', 'login', 'name', 'avatarUrl', 'url'],
  Ref: ['name', 'target', 'prefix'],
  Commit: ['oid', 'message', 'author'],
  GitActor: ['name', 'email'],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  LabelEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  Node: ['id'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileEdge: ['node', 'cursor'],
  SearchType: [],
  __Schema: ['queryType', 'mutationType', 'types', 'description'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', 'ofType'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const TYPE_KIND: Record<string, string> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  Repository: 'OBJECT',
  User: 'OBJECT',
  Ref: 'OBJECT',
  Commit: 'OBJECT',
  GitActor: 'OBJECT',
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  LabelConnection: 'OBJECT',
  IssueCommentConnection: 'OBJECT',
  IssueEdge: 'OBJECT',
  PullRequestEdge: 'OBJECT',
  LabelEdge: 'OBJECT',
  IssueCommentEdge: 'OBJECT',
  PageInfo: 'OBJECT',
  Label: 'OBJECT',
  IssueComment: 'OBJECT',
  PullRequestFile: 'OBJECT',
  Node: 'INTERFACE',
  CreateIssuePayload: 'OBJECT',
  CloseIssuePayload: 'OBJECT',
  CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT',
  AddCommentPayload: 'OBJECT',
  PullRequestFileConnection: 'OBJECT',
  PullRequestFileEdge: 'OBJECT',
  SearchType: 'ENUM',
  __Schema: 'OBJECT',
  __Type: 'OBJECT',
  __Field: 'OBJECT',
  __EnumValue: 'OBJECT',
  __InputValue: 'OBJECT',
  String: 'SCALAR',
  Int: 'SCALAR',
  Boolean: 'SCALAR',
  ID: 'SCALAR',
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
};

const FIELD_TYPE: Record<string, string> = {
  'Query.repository': 'Repository',
  'Query.node': 'Node',
  'Query.viewer': 'User',
  'Query.search': 'SearchResultItemConnection',
  'Repository.issue': 'Issue',
  'Repository.issues': 'IssueConnection',
  'Repository.pullRequest': 'PullRequest',
  'Repository.pullRequests': 'PullRequestConnection',
  'Repository.labels': 'LabelConnection',
  'Repository.owner': 'User',
  'Repository.defaultBranchRef': 'Ref',
  'Issue.comments': 'IssueCommentConnection',
  'Issue.labels': 'LabelConnection',
  'Issue.author': 'User',
  'Issue.repository': 'Repository',
  'PullRequest.files': 'PullRequestFileConnection',
  'PullRequest.author': 'User',
  'PullRequest.headRef': 'Ref',
  'PullRequest.baseRef': 'Ref',
  'IssueConnection.nodes': 'Issue',
  'PullRequestConnection.nodes': 'PullRequest',
  'LabelConnection.nodes': 'Label',
  'IssueCommentConnection.nodes': 'IssueComment',
  'IssueEdge.node': 'Issue',
  'PullRequestEdge.node': 'PullRequest',
  'LabelEdge.node': 'Label',
  'IssueCommentEdge.node': 'IssueComment',
  'Ref.target': 'Commit',
};

// ---------------------------------------------------------------- object builders

// Every resolved object carries __type (its concrete type) plus, for
// store-backed objects, a hidden __repo / __issue / __pr handle. The
// resolver only ever reads the fields it is asked for, so these
// handles never leak into a response.
type GqlObj = Record<string, unknown>;

function repoObj(store: Store, repo: Repo): GqlObj {
  const owner = repo.owner ?? store.ownerLogin ?? '';
  return {
    __type: 'Repository',
    __repo: repo,
    id: encodeId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: owner ? owner + '/' + repo.name : repo.name,
    description: repo.description,
  };
}

function userObj(store: Store, login: string): GqlObj {
  return { __type: 'User', login, id: encodeId('User', login), name: login, avatarUrl: '', url: (store.baseUrl || '') + '/' + login };
}

function issueObj(store: Store, repo: Repo, issue: Issue): GqlObj {
  return {
    __type: 'Issue',
    __repo: repo,
    __issue: issue,
    id: encodeId('Issue', repo.id, issue.number),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.state === 'closed' ? FIXED_TS : null,
  };
}

function pullObj(store: Store, repo: Repo, pr: Pull): GqlObj {
  return {
    __type: 'PullRequest',
    __repo: repo,
    __pr: pr,
    id: encodeId('PullRequest', repo.id, pr.number),
    databaseId: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.merged ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN',
    merged: pr.merged,
    mergeable: pr.mergeable ? 'MERGEABLE' : 'CONFLICTING',
    headRefName: pr.head,
    baseRefName: pr.base,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.merged ? pr.mergedAt : null,
  };
}

function refObj(store: Store, repo: Repo, name: string): GqlObj {
  return { __type: 'Ref', __repo: repo, name, prefix: 'refs/heads/' };
}

function cursorFor(number: number): string {
  return Buffer.from('cursor:' + number, 'utf8').toString('base64');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || !cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- connections

interface ConnPage<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
  totalCount: number;
}

// Shared list slicing for the issue / pull-request connections:
// filter by state, order by number (DESC when orderBy asks for it,
// ASC by default), apply the after-cursor in the current order, and
// take `first` nodes. The cursor encodes the last returned number,
// so paging works in either direction.
function pageList<T extends { number: number; state: string }>(
  items: T[],
  args: Record<string, unknown>,
): ConnPage<T> {
  const statesRaw = args.states;
  const stateSet = Array.isArray(statesRaw) ? new Set(statesRaw.map((s) => String(s))) : null;
  let list = items.slice();
  if (stateSet) list = list.filter((it) => stateSet.has(it.state === 'closed' ? 'CLOSED' : 'OPEN'));
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const desc = String(orderBy.direction ?? '') === 'DESC';
  list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  const after = numberFromCursor(args.after);
  if (after !== null) list = list.filter((it) => (desc ? it.number < after : it.number > after));
  const totalCount = list.length;
  const firstRaw = args.first;
  const first = typeof firstRaw === 'number' && firstRaw >= 0 ? firstRaw : list.length;
  const page = list.slice(0, first);
  return {
    nodes: page,
    hasNextPage: list.length > first,
    endCursor: page.length > 0 ? cursorFor(page[page.length - 1].number) : null,
    totalCount,
  };
}

function connectionObj(kind: string, page: ConnPage<GqlObj>, edgeKind: string): GqlObj {
  return {
    __type: kind,
    __nodes: page.nodes,
    __edges: page.nodes.map((node) => ({
      __type: edgeKind,
      node,
      cursor: cursorFor((node.number as number) ?? 0),
    })),
    __hasNextPage: page.hasNextPage,
    __endCursor: page.endCursor,
    __totalCount: page.totalCount,
  };
}

// ---------------------------------------------------------------- resolver

interface Ctx {
  store: Store;
  errors: { message: string }[];
  fragments: Map<string, FragmentDef>;
  variables: Record<string, unknown>;
}

function fieldTypeOf(typeName: string, field: string): string | null {
  return FIELD_TYPE[typeName + '.' + field] ?? null;
}

function resolveField(ctx: Ctx, obj: GqlObj, typeName: string, field: FieldSelection): unknown {
  const store = ctx.store;
  const args = argsMap(field, ctx.variables);

  // R4 fix 2.4: fields selected directly on the `Node` interface (for
  // example `id` on `node(...)`) have no Node branch of their own; the
  // object carries its concrete type, so resolve against that.
  if (typeName === 'Node') {
    const concrete = String(obj.__type ?? '');
    if (concrete && concrete !== 'Node') return resolveField(ctx, obj, concrete, field);
    return null;
  }

  // Payload objects expose their members directly.
  if (typeName.endsWith('Payload')) {
    if (field.name === 'clientMutationId') return (obj.__clientMutationId as unknown) ?? null;
    return obj[field.name] ?? null;
  }

  switch (typeName) {
    case 'Query': {
      if (field.name === 'repository') {
        const repo = store.findRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoObj(store, repo) : null;
      }
      if (field.name === 'node') {
        const decoded = decodeId(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = store.repos.get(String(decoded.parts[0])) ?? null;
          const byId = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
          const found = repo ?? byId ?? null;
          return found ? repoObj(store, found) : null;
        }
        if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
          const repoId = Number(decoded.parts[0]);
          const number = Number(decoded.parts[1]);
          const repo = [...store.repos.values()].find((r) => r.id === repoId);
          if (!repo) return null;
          if (decoded.kind === 'Issue') {
            const issue = repo.issuesByNumber.get(number);
            return issue ? issueObj(store, repo, issue) : null;
          }
          const pr = repo.pullsByNumber.get(number);
          return pr ? pullObj(store, repo, pr) : null;
        }
        if (decoded.kind === 'User') {
          return userObj(store, decoded.parts[0] ?? '');
        }
        return null;
      }
      if (field.name === 'viewer') {
        return userObj(store, store.ownerLogin ?? '');
      }
      if (field.name === 'search') {
        const needle = String(args.query ?? '').toLowerCase();
        const hits: GqlObj[] = [];
        for (const repo of store.repos.values()) {
          for (const issue of repo.issues) {
            if (!needle || issue.title.toLowerCase().includes(needle)) hits.push(issueObj(store, repo, issue));
          }
        }
        const page = pageList(
          hits.map((h) => ({ number: h.number as number, state: (h.state as string) === 'CLOSED' ? 'closed' : 'open', __obj: h })),
          args,
        );
        return connectionObj('IssueConnection', { ...page, nodes: page.nodes.map((n) => (n as unknown as { __obj: GqlObj }).__obj) }, 'IssueEdge');
      }
      if (field.name === '__schema') return { __type: '__Schema' };
      if (field.name === '__type') return { __type: '__Type', __typeName: String(args.name ?? '') };
      return null;
    }
    case 'Repository': {
      const repo = obj.__repo as Repo;
      switch (field.name) {
        case 'id':
        case 'databaseId':
        case 'name':
        case 'nameWithOwner':
        case 'description':
          return obj[field.name] ?? null;
        case 'owner':
          return userObj(store, repo.owner ?? store.ownerLogin ?? '');
        case 'defaultBranchRef':
          return refObj(store, repo, repo.defaultBranch);
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'url':
          return (store.baseUrl || '') + '/' + (repo.owner ?? store.ownerLogin ?? '') + '/' + repo.name;
        case 'createdAt':
        case 'updatedAt':
          return FIXED_TS;
        case 'issue': {
          const issue = repo.issuesByNumber.get(Number(args.number));
          return issue ? issueObj(store, repo, issue) : null;
        }
        case 'issues': {
          const page = pageList(repo.issues, args);
          return connectionObj('IssueConnection', { ...page, nodes: page.nodes.map((i) => issueObj(store, repo, i)) }, 'IssueEdge');
        }
        case 'pullRequest': {
          const pr = repo.pullsByNumber.get(Number(args.number));
          return pr ? pullObj(store, repo, pr) : null;
        }
        case 'pullRequests': {
          const page = pageList(repo.pulls, args);
          return connectionObj('PullRequestConnection', { ...page, nodes: page.nodes.map((p) => pullObj(store, repo, p)) }, 'PullRequestEdge');
        }
        case 'labels': {
          const labels = [...repo.labels.values()].map((l) => ({
            __type: 'Label',
            id: encodeId('Label', repo.id, l.id),
            name: l.name,
            color: l.color,
            description: l.description,
            number: l.id,
            state: 'open',
          }));
          const page = pageList(labels as unknown as { number: number; state: string }[], args);
          return connectionObj('LabelConnection', { ...page, nodes: page.nodes as unknown as GqlObj[] }, 'LabelEdge');
        }
        default:
          return null;
      }
    }
    case 'User': {
      switch (field.name) {
        case 'id':
        case 'login':
        case 'name':
        case 'avatarUrl':
        case 'url':
          return obj[field.name] ?? null;
        default:
          return null;
      }
    }
    case 'Ref': {
      const repo = obj.__repo as Repo;
      if (field.name === 'name') return obj.name ?? null;
      if (field.name === 'prefix') return 'refs/heads/';
      if (field.name === 'target') {
        const tip = repo.refs.get('refs/heads/' + String(obj.name ?? ''));
        if (!tip) return null;
        const parsed = parseCommit(repo, tip);
        return parsed
          ? { __type: 'Commit', oid: tip, message: parsed.message }
          : null;
      }
      return null;
    }
    case 'Commit': {
      if (field.name === 'oid') return obj.oid ?? null;
      if (field.name === 'message') return obj.message ?? null;
      if (field.name === 'author') return { __type: 'GitActor', name: 'forge', email: 'forge@example.invalid' };
      return null;
    }
    case 'GitActor': {
      return obj[field.name] ?? null;
    }
    case 'Issue': {
      const repo = obj.__repo as Repo;
      const issue = obj.__issue as Issue;
      switch (field.name) {
        case 'id':
        case 'databaseId':
        case 'number':
        case 'title':
        case 'body':
        case 'state':
        case 'createdAt':
        case 'updatedAt':
        case 'closedAt':
          return obj[field.name] ?? null;
        case 'author':
          return userObj(store, issue.user || repo.owner || store.ownerLogin || '');
        case 'repository':
          return repoObj(store, repo);
        case 'labels': {
          const labels = issue.labels.map((l) => ({
            __type: 'Label',
            id: encodeId('Label', repo.id, l.id),
            name: l.name,
            color: l.color,
            description: l.description,
            number: l.id,
            state: 'open',
          }));
          const page = pageList(labels as unknown as { number: number; state: string }[], args);
          return connectionObj('LabelConnection', { ...page, nodes: page.nodes as unknown as GqlObj[] }, 'LabelEdge');
        }
        case 'comments': {
          const comments = (repo.comments.get(issue.number) ?? []).map((c) => ({
            __type: 'IssueComment',
            id: encodeId('IssueComment', repo.id, issue.number, c.id),
            body: c.body,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            number: c.id,
            state: 'open',
            __user: c.user,
          }));
          const page = pageList(comments as unknown as { number: number; state: string }[], args);
          return connectionObj('IssueCommentConnection', { ...page, nodes: page.nodes as unknown as GqlObj[] }, 'IssueCommentEdge');
        }
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const repo = obj.__repo as Repo;
      const pr = obj.__pr as Pull;
      switch (field.name) {
        case 'id':
        case 'databaseId':
        case 'number':
        case 'title':
        case 'body':
        case 'state':
        case 'merged':
        case 'mergeable':
        case 'headRefName':
        case 'baseRefName':
        case 'createdAt':
        case 'updatedAt':
        case 'mergedAt':
          return obj[field.name] ?? null;
        case 'author':
          return userObj(store, pr.user || repo.owner || store.ownerLogin || '');
        case 'headRef':
          return refObj(store, repo, pr.head);
        case 'baseRef':
          return refObj(store, repo, pr.base);
        case 'files': {
          const files = prFiles(repo, pr).map((f) => ({
            __type: 'PullRequestFile',
            path: f.filename,
            additions: f.additions,
            deletions: f.deletions,
            changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'REMOVED' : 'MODIFIED',
            number: 0,
            state: 'open',
          }));
          const firstRaw = args.first;
          const first = typeof firstRaw === 'number' && firstRaw >= 0 ? firstRaw : files.length;
          const page = files.slice(0, first);
          return {
            __type: 'PullRequestFileConnection',
            __nodes: page,
            __edges: page.map((n) => ({ __type: 'PullRequestFileEdge', node: n, cursor: cursorFor(0) })),
            __hasNextPage: files.length > first,
            __endCursor: null,
            __totalCount: files.length,
          };
        }
        default:
          return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'LabelConnection':
    case 'IssueCommentConnection':
    case 'PullRequestFileConnection': {
      if (field.name === 'nodes') return obj.__nodes ?? [];
      if (field.name === 'edges') return obj.__edges ?? [];
      if (field.name === 'totalCount') return obj.__totalCount ?? 0;
      if (field.name === 'pageInfo') {
        return {
          __type: 'PageInfo',
          hasNextPage: obj.__hasNextPage ?? false,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: obj.__endCursor ?? null,
        };
      }
      return null;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'LabelEdge':
    case 'IssueCommentEdge':
    case 'PullRequestFileEdge': {
      if (field.name === 'node') return obj.node ?? null;
      if (field.name === 'cursor') return obj.cursor ?? null;
      return null;
    }
    case 'PageInfo': {
      return obj[field.name] ?? null;
    }
    case 'Label': {
      return obj[field.name] ?? null;
    }
    case 'IssueComment': {
      if (field.name === 'author') return userObj(store, String((obj as GqlObj).__user ?? store.ownerLogin ?? ''));
      return obj[field.name] ?? null;
    }
    case 'PullRequestFile': {
      return obj[field.name] ?? null;
    }
    case '__Schema': {
      if (field.name === 'queryType') return { __type: '__Type', __typeName: 'Query' };
      if (field.name === 'mutationType') return { __type: '__Type', __typeName: 'Mutation' };
      if (field.name === 'types') {
        return Object.keys(TYPE_FIELDS).map((name) => ({ __type: '__Type', __typeName: name }));
      }
      if (field.name === 'description') return null;
      return null;
    }
    case '__Type': {
      const typeName = String(obj.__typeName ?? '');
      switch (field.name) {
        case 'name':
          return typeName;
        case 'kind':
          return TYPE_KIND[typeName] ?? 'OBJECT';
        case 'description':
          return null;
        case 'fields': {
          const names = TYPE_FIELDS[typeName] ?? [];
          return names.map((name) => ({ __type: '__Field', __fieldName: name, __parentType: typeName }));
        }
        case 'enumValues': {
          const values = ENUM_VALUES[typeName] ?? [];
          return values.map((name) => ({ __type: '__EnumValue', __enumName: name }));
        }
        case 'inputFields':
          return [];
        case 'interfaces':
          return [];
        case 'possibleTypes':
          return [];
        case 'ofType':
          return null;
        default:
          return null;
      }
    }
    case '__Field': {
      if (field.name === 'name') return obj.__fieldName ?? null;
      if (field.name === 'description') return null;
      if (field.name === 'args') return [];
      if (field.name === 'type') return { __type: '__Type', __typeName: 'String' };
      return null;
    }
    case '__EnumValue': {
      if (field.name === 'name') return obj.__enumName ?? null;
      if (field.name === 'description') return null;
      if (field.name === 'isDeprecated') return false;
      if (field.name === 'deprecationReason') return null;
      return null;
    }
    case '__InputValue': {
      if (field.name === 'name') return obj.__inputName ?? null;
      if (field.name === 'description') return null;
      if (field.name === 'type') return { __type: '__Type', __typeName: 'String' };
      if (field.name === 'defaultValue') return null;
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- execution

function executeSelections(
  ctx: Ctx,
  obj: GqlObj,
  typeName: string,
  selections: Selection[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (!frag) continue;
      const fragType = frag.typeCondition;
      const concrete = String(obj.__type ?? typeName);
      if (fragType !== typeName && fragType !== concrete) continue;
      Object.assign(out, executeSelections(ctx, obj, fragType, frag.selections));
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition) {
        const concrete = String(obj.__type ?? typeName);
        if (sel.typeCondition !== typeName && sel.typeCondition !== concrete) continue;
        Object.assign(out, executeSelections(ctx, obj, sel.typeCondition, sel.selections));
      } else {
        Object.assign(out, executeSelections(ctx, obj, typeName, sel.selections));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = String(obj.__type ?? typeName);
      continue;
    }
    const known = (TYPE_FIELDS[typeName] ?? []).includes(sel.name) || sel.name.startsWith('__');
    if (!known) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    const value = resolveField(ctx, obj, typeName, sel);
    out[key] = executeValue(ctx, value, fieldTypeOf(typeName, sel.name) ?? typeName, sel.selections);
  }
  return out;
}

function executeValue(ctx: Ctx, value: unknown, typeName: string, selections: Selection[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => executeValue(ctx, item, typeName, selections));
  }
  if (typeof value === 'object') {
    const obj = value as GqlObj;
    if (selections.length === 0) return value;
    // Introspection leaf objects carry their own marker type.
    const concrete = String(obj.__type ?? typeName);
    return executeSelections(ctx, obj, concrete, selections);
  }
  return value;
}

// ---------------------------------------------------------------- mutations

function findRepoByNodeId(store: Store, id: string): Repo | null {
  const decoded = decodeId(id);
  if (!decoded) return null;
  if (decoded.kind === 'Repository') {
    const byId = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
    return byId ?? null;
  }
  return null;
}

function findIssueByNodeId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const repo = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
  if (!repo) return null;
  const issue = repo.issuesByNumber.get(Number(decoded.parts[1]));
  return issue ? { repo, issue } : null;
}

function findPullByNodeId(store: Store, id: string): { repo: Repo; pr: Pull } | null {
  const decoded = decodeId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const repo = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
  if (!repo) return null;
  const pr = repo.pullsByNumber.get(Number(decoded.parts[1]));
  return pr ? { repo, pr } : null;
}

function runMutation(ctx: Ctx, field: FieldSelection): unknown {
  const store = ctx.store;
  const args = argsMap(field, ctx.variables);
  const input = (args.input ?? {}) as Record<string, unknown>;
  const payloadType =
    field.name === 'createIssue'
      ? 'CreateIssuePayload'
      : field.name === 'closeIssue'
        ? 'CloseIssuePayload'
        : field.name === 'createPullRequest'
          ? 'CreatePullRequestPayload'
          : field.name === 'mergePullRequest'
            ? 'MergePullRequestPayload'
            : 'AddCommentPayload';
  const payload: GqlObj = { __type: payloadType, __clientMutationId: input.clientMutationId ?? null };

  if (field.name === 'createIssue') {
    const repo = findRepoByNodeId(store, String(input.repositoryId ?? ''));
    if (!repo) {
      ctx.errors.push({ message: 'Repository not found' });
      return payload;
    }
    const labelNames = Array.isArray(input.labelIds) ? [] : [];
    const created = createIssueRecord(store, repo, String(input.title ?? ''), String(input.body ?? ''), labelNames);
    if (!created.issue) {
      ctx.errors.push({ message: created.error ?? 'Could not create issue' });
      return payload;
    }
    payload.issue = issueObj(store, repo, created.issue);
    return payload;
  }
  if (field.name === 'closeIssue') {
    const found = findIssueByNodeId(store, String(input.issueId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'Issue not found' });
      return payload;
    }
    found.issue.state = 'closed';
    found.issue.updatedAt = FIXED_TS;
    payload.issue = issueObj(store, found.repo, found.issue);
    return payload;
  }
  if (field.name === 'createPullRequest') {
    const repo = findRepoByNodeId(store, String(input.repositoryId ?? ''));
    if (!repo) {
      ctx.errors.push({ message: 'Repository not found' });
      return payload;
    }
    const created = createPullRecord(
      store,
      repo,
      String(input.title ?? ''),
      String(input.headRefName ?? ''),
      String(input.baseRefName ?? ''),
      String(input.body ?? ''),
    );
    if (!created.pr) {
      ctx.errors.push({ message: created.error ?? 'Could not create pull request' });
      return payload;
    }
    payload.pullRequest = pullObj(store, repo, created.pr);
    return payload;
  }
  if (field.name === 'mergePullRequest') {
    const found = findPullByNodeId(store, String(input.pullRequestId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'Pull request not found' });
      return payload;
    }
    const method = String(input.mergeMethod ?? 'SQUASH') === 'MERGE' ? 'merge' : 'squash';
    const result = mergePullRecord(found.repo, found.pr, method);
    if (result.status !== 200) {
      ctx.errors.push({ message: result.message });
      return payload;
    }
    payload.pullRequest = pullObj(store, found.repo, found.pr);
    return payload;
  }
  if (field.name === 'addComment') {
    const found = findIssueByNodeId(store, String(input.subjectId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'Issue not found' });
      return payload;
    }
    const comment = addCommentRecord(store, found.repo, found.issue.number, String(input.body ?? ''));
    if (!comment) {
      ctx.errors.push({ message: 'Could not add comment' });
      return payload;
    }
    const node: GqlObj = {
      __type: 'IssueComment',
      id: encodeId('IssueComment', found.repo.id, found.issue.number, comment.id),
      body: comment.body,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      __user: comment.user,
    };
    payload.commentEdge = { __type: 'IssueCommentEdge', node, cursor: cursorFor(comment.id) };
    return payload;
  }
  ctx.errors.push({ message: `Unknown mutation "${field.name}".` });
  return payload;
}

// ---------------------------------------------------------------- entry

function executeOperation(store: Store, op: Operation, fragments: Map<string, FragmentDef>, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: Ctx = { store, errors: [], fragments, variables };
  const data: Record<string, unknown> = {};
  if (op.operation === 'mutation') {
    for (const sel of op.selections) {
      if (sel.kind !== 'field') continue;
      const key = sel.alias ?? sel.name;
      const payloadType =
        sel.name === 'createIssue'
          ? 'CreateIssuePayload'
          : sel.name === 'closeIssue'
            ? 'CloseIssuePayload'
            : sel.name === 'createPullRequest'
              ? 'CreatePullRequestPayload'
              : sel.name === 'mergePullRequest'
                ? 'MergePullRequestPayload'
                : 'AddCommentPayload';
      const payload = runMutation(ctx, sel) as GqlObj;
      data[key] = executeSelections(ctx, payload, payloadType, sel.selections);
    }
  } else {
    const root: GqlObj = { __type: 'Query' };
    Object.assign(data, executeSelections(ctx, root, 'Query', op.selections));
  }
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

export function handleGraphql(store: Store, parsed: unknown): GraphqlResult {
  const isBatch = Array.isArray(parsed);
  const bodies = isBatch ? (parsed as unknown[]) : [parsed];
  const results: Record<string, unknown>[] = [];
  for (const body of bodies) {
    const doc = (body ?? {}) as Record<string, unknown>;
    const query = typeof doc.query === 'string' ? doc.query : '';
    const variables = (doc.variables ?? {}) as Record<string, unknown>;
    try {
      const parser = new Parser(tokenize(query));
      const defs = parser.parseDocument();
      const fragments = new Map<string, FragmentDef>();
      for (const def of defs) if (def.kind === 'fragment') fragments.set(def.name, def);
      const operations = defs.filter((d): d is Operation => d.kind === 'operation');
      const opName = typeof doc.operationName === 'string' ? doc.operationName : null;
      const op = operations.find((o) => o.name === opName) ?? operations[0];
      if (!op) {
        results.push({ data: {}, errors: [{ message: 'No operation found' }] });
        continue;
      }
      // Operation-level variable defaults fill in missing variables.
      const mergedVars: Record<string, unknown> = { ...variables };
      for (const v of op.variables) {
        if (mergedVars[v.name] === undefined && v.value !== null) {
          mergedVars[v.name] = resolveValue(v.value, variables);
        }
      }
      results.push(executeOperation(store, op, fragments, mergedVars));
    } catch (err) {
      results.push({ data: {}, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] });
    }
  }
  return { status: 200, body: JSON.stringify(isBatch ? results : results[0]) };
}
