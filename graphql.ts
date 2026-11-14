// graphql.ts — a small GraphQL parser + executor for the documents gh and
// github-mcp-server send: repository/issue/pull-request queries, the
// create/close/merge mutations, batch bodies, and __type/__schema
// introspection. Unknown fields answer HTTP 200 with an errors array.
import type { Store, Repo, Issue, Pull } from './store.ts';
import { decodeOpaqueId, opaqueId } from './store.ts';

// ---------------------------------------------------------------- schema
const SCHEMA: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'search'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'avatarUrl'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'author', 'labels', 'comments', 'url'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'author', 'url'],
  },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  CommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'target'] },
  Label: { kind: 'OBJECT', fields: ['name', 'color', 'id'] },
  LabelConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  SearchResultItemConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'issueCount'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'clientMutationId'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'fields', 'enumValues'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description', 'args', 'type'] },
  __Schema: { kind: 'OBJECT', fields: ['queryType', 'mutationType', 'types'] },
};

// ---------------------------------------------------------------- tokenizer
interface Token {
  kind: 'punct' | 'name' | 'string' | 'int' | 'float' | 'eof';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        const val = end === -1 ? src.slice(i + 3) : src.slice(i + 3, end);
        tokens.push({ kind: 'string', value: val });
        i = end === -1 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let val = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          if (e === 'n') val += '\n';
          else if (e === 't') val += '\t';
          else if (e === 'r') val += '\r';
          else if (e === 'u' && j + 5 < src.length) {
            val += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else val += e;
          j += 2;
        } else {
          val += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: val });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      let isFloat = false;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser
type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: unknown };

interface FieldNode {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, ValueNode>;
  selections: SelectionNode[];
}
interface SpreadNode {
  kind: 'spread';
  name: string;
}
interface InlineNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}
type SelectionNode = FieldNode | SpreadNode | InlineNode;

interface OperationNode {
  kind: 'operation';
  opType: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

interface FragmentDef {
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  tokens: Token[];
  pos = 0;
  constructor(src: string) {
    this.tokens = tokenize(src);
  }
  peek(): Token {
    return this.tokens[this.pos];
  }
  next(): Token {
    return this.tokens[this.pos++];
  }
  expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`Expected '${v}' but got '${t.value}'`);
  }
  expectName(what = 'name'): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`Expected ${what} but got '${t.value}'`);
    return t.value;
  }
  skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName('directive name');
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }
  skipVariableDefinitions(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      let depth = 1;
      while (depth > 0) {
        const t = this.next();
        if (t.kind === 'eof') throw new Error('Unterminated variable definitions');
        if (t.kind === 'punct' && t.value === '(') depth += 1;
        if (t.kind === 'punct' && t.value === ')') depth -= 1;
      }
    }
  }
  parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectName('variable name') };
    }
    if (t.kind === 'int') return { kind: 'literal', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'literal', value: parseFloat(t.value) };
    if (t.kind === 'string') return { kind: 'literal', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'literal', value: true };
      if (t.value === 'false') return { kind: 'literal', value: false };
      if (t.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'literal', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const list: unknown[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        const v = this.parseValue();
        list.push(v.kind === 'variable' ? v : v.value);
      }
      this.expectPunct(']');
      return { kind: 'literal', value: list };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const key = this.expectName('object key');
        this.expectPunct(':');
        const v = this.parseValue();
        obj[key] = v.kind === 'variable' ? v : v.value;
      }
      this.expectPunct('}');
      return { kind: 'literal', value: obj };
    }
    throw new Error(`Unexpected token '${t.value}' in value`);
  }
  parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName('argument name');
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }
  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const sels: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }
  parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const n = this.peek();
      if (n.kind === 'name' && n.value === 'on') {
        this.next();
        const typeCondition = this.expectName('type condition');
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (n.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName('field name');
    let alias = first;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      name = this.expectName('field name');
    }
    let args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }
  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName('fragment name');
        const on = this.expectName("'on'");
        if (on !== 'on') throw new Error("Expected 'on' in fragment definition");
        const typeCondition = this.expectName('type condition');
        this.skipDirectives();
        doc.fragments.set(name, { typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'punct' && t.value === '{') {
        doc.operations.push({ kind: 'operation', opType: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        this.skipVariableDefinitions();
        this.skipDirectives();
        doc.operations.push({ kind: 'operation', opType: t.value as 'query' | 'mutation', name, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`Unexpected token '${t.value}' in document`);
    }
    return doc;
  }
}

function parseDocument(src: string): DocumentNode {
  return new Parser(src).parseDocument();
}

// ---------------------------------------------------------------- executor
type GqlValue =
  | { kind: 'scalar'; value: string | number | boolean | null }
  | { kind: 'object'; type: string; data: unknown }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'null' };

const NULLV: GqlValue = { kind: 'null' };
const scalar = (v: string | number | boolean | null): GqlValue => ({ kind: 'scalar', value: v });
const obj = (type: string, data: unknown): GqlValue => ({ kind: 'object', type, data });

interface Ctx {
  store: Store;
  host: string;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: Array<{ message: string }>;
}

function resolveDeep(x: unknown, ctx: Ctx): unknown {
  if (x !== null && typeof x === 'object') {
    if ('kind' in x && (x as ValueNode).kind === 'variable') return ctx.variables[(x as ValueNode).name];
    if (Array.isArray(x)) return x.map((e) => resolveDeep(e, ctx));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) out[k] = resolveDeep(v, ctx);
    return out;
  }
  return x;
}

function resolveValue(v: ValueNode, ctx: Ctx): unknown {
  return resolveDeep(v.kind === 'variable' ? v : v.value, ctx);
}

function resolveArgs(args: Record<string, ValueNode>, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = resolveValue(v, ctx);
  return out;
}

const cursorFor = (n: number): string => Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
function numberFromCursor(c: string): number | null {
  try {
    const s = Buffer.from(c, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(s);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

interface IssueCtx {
  repo: Repo;
  issue: Issue;
}
interface PullCtx {
  repo: Repo;
  pr: Pull;
}

function issueValue(repo: Repo, issue: Issue): GqlValue {
  return obj('Issue', { repo, issue } as IssueCtx);
}
function pullValue(repo: Repo, pr: Pull): GqlValue {
  return obj('PullRequest', { repo, pr } as PullCtx);
}
function repoValue(repo: Repo): GqlValue {
  return obj('Repository', repo);
}

function connectionPage<T>(
  items: T[],
  args: Record<string, unknown>,
  key: (item: T) => number,
  toNode: (item: T) => GqlValue,
  edgeType: string,
  connType: string,
): GqlValue {
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : 100;
  const afterNum = typeof args.after === 'string' ? numberFromCursor(args.after) : null;
  const direction = (args.orderBy as Record<string, unknown> | undefined)?.direction === 'DESC' ? 'DESC' : 'ASC';
  const totalCount = items.length;
  let filtered = [...items];
  if (afterNum !== null) {
    filtered = filtered.filter((it) => (direction === 'DESC' ? key(it) < afterNum : key(it) > afterNum));
  }
  filtered.sort((a, b) => (direction === 'DESC' ? key(b) - key(a) : key(a) - key(b)));
  const page = filtered.slice(0, first);
  const hasNext = filtered.length > page.length;
  const nodes = page.map(toNode);
  const edges: GqlValue[] = page.map((it) =>
    obj(edgeType, { node: toNode(it), cursor: cursorFor(key(it)) }),
  );
  const pageInfo = obj('PageInfo', {
    hasNextPage: hasNext,
    hasPreviousPage: afterNum !== null,
    startCursor: page.length > 0 ? cursorFor(key(page[0])) : null,
    endCursor: page.length > 0 ? cursorFor(key(page[page.length - 1])) : null,
  });
  return obj(connType, { nodes, edges, pageInfo, totalCount });
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): GqlValue {
  let list = [...repo.issues];
  if (Array.isArray(args.states)) {
    const want = new Set(args.states.map((s) => String(s).toUpperCase()));
    list = list.filter((i) => want.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  return connectionPage<Issue>(list, args, (i) => i.number, (i) => issueValue(repo, i), 'IssueEdge', 'IssueConnection');
}

function pullsConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): GqlValue {
  let list = [...repo.pulls];
  if (Array.isArray(args.states)) {
    const want = new Set(args.states.map((s) => String(s).toUpperCase()));
    list = list.filter((p) => {
      if (want.has('MERGED') && p.merged) return true;
      return want.has(p.state === 'open' ? 'OPEN' : 'CLOSED');
    });
  }
  return connectionPage<Pull>(list, args, (p) => p.number, (p) => pullValue(repo, p), 'PullRequestEdge', 'PullRequestConnection');
}

function findRepoById(ctx: Ctx, id: number): Repo | undefined {
  return ctx.store.listRepos().find((r) => r.id === id);
}

function resolveKnownField(ctx: Ctx, parentType: string, data: unknown, field: FieldNode): GqlValue {
  const args = resolveArgs(field.args, ctx);
  const store = ctx.store;
  switch (parentType) {
    case 'Query': {
      if (field.name === 'viewer') return obj('User', { login: store.ownerLogin() });
      if (field.name === 'repository') {
        const name = String(args.name ?? '');
        const owner = String(args.owner ?? '');
        const repo = store.getRepo(name);
        if (!repo) return NULLV;
        if (store.owner !== null && store.owner !== owner) return NULLV;
        store.learnOwner(owner);
        return repoValue(repo);
      }
      if (field.name === 'node') {
        const decoded = typeof args.id === 'string' ? decodeOpaqueId(args.id) : null;
        if (!decoded) return NULLV;
        if (decoded.kind === 'Repository') {
          const repo = findRepoById(ctx, parseInt(decoded.parts[0], 10));
          return repo ? repoValue(repo) : NULLV;
        }
        if (decoded.kind === 'Issue') {
          const repo = findRepoById(ctx, parseInt(decoded.parts[0], 10));
          const issue = repo?.issueByNumber.get(parseInt(decoded.parts[1], 10));
          return repo && issue ? issueValue(repo, issue) : NULLV;
        }
        if (decoded.kind === 'PullRequest') {
          const repo = findRepoById(ctx, parseInt(decoded.parts[0], 10));
          const pr = repo?.pullByNumber.get(parseInt(decoded.parts[1], 10));
          return repo && pr ? pullValue(repo, pr) : NULLV;
        }
        return NULLV;
      }
      if (field.name === 'search') {
        const pageInfo = obj('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null });
        return obj('SearchResultItemConnection', { nodes: [], edges: [], pageInfo, issueCount: 0 });
      }
      return NULLV;
    }
    case 'Mutation': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (field.name === 'createIssue') {
        const decoded = typeof input.repositoryId === 'string' ? decodeOpaqueId(input.repositoryId) : null;
        const repo = decoded && decoded.kind === 'Repository' ? findRepoById(ctx, parseInt(decoded.parts[0], 10)) : undefined;
        if (!repo) {
          ctx.errors.push({ message: 'Repository not found' });
          return NULLV;
        }
        const title = String(input.title ?? '');
        if (title === '') {
          ctx.errors.push({ message: 'title is required' });
          return NULLV;
        }
        const issue = store.createIssue(repo, title, String(input.body ?? ''), []);
        return obj('CreateIssuePayload', { issue: issueValue(repo, issue), clientMutationId: input.clientMutationId ?? null });
      }
      if (field.name === 'closeIssue') {
        const decoded = typeof input.issueId === 'string' ? decodeOpaqueId(input.issueId) : null;
        const repo = decoded && decoded.kind === 'Issue' ? findRepoById(ctx, parseInt(decoded.parts[0], 10)) : undefined;
        const issue = repo?.issueByNumber.get(decoded ? parseInt(decoded.parts[1], 10) : -1);
        if (!repo || !issue) {
          ctx.errors.push({ message: 'Issue not found' });
          return NULLV;
        }
        issue.state = 'closed';
        return obj('CloseIssuePayload', { issue: issueValue(repo, issue), clientMutationId: input.clientMutationId ?? null });
      }
      if (field.name === 'createPullRequest') {
        const decoded = typeof input.repositoryId === 'string' ? decodeOpaqueId(input.repositoryId) : null;
        const repo = decoded && decoded.kind === 'Repository' ? findRepoById(ctx, parseInt(decoded.parts[0], 10)) : undefined;
        if (!repo) {
          ctx.errors.push({ message: 'Repository not found' });
          return NULLV;
        }
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headSha = store.branchTip(repo, head);
        const baseSha = store.branchTip(repo, base);
        if (headSha === null || baseSha === null) {
          ctx.errors.push({ message: 'head or base branch does not exist' });
          return NULLV;
        }
        const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
        if (dup) {
          ctx.errors.push({ message: 'A pull request already exists for this head and base' });
          return NULLV;
        }
        const pr = store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, headSha, base, baseSha);
        return obj('CreatePullRequestPayload', { pullRequest: pullValue(repo, pr), clientMutationId: input.clientMutationId ?? null });
      }
      if (field.name === 'mergePullRequest') {
        const decoded = typeof input.pullRequestId === 'string' ? decodeOpaqueId(input.pullRequestId) : null;
        const repo = decoded && decoded.kind === 'PullRequest' ? findRepoById(ctx, parseInt(decoded.parts[0], 10)) : undefined;
        const pr = repo?.pullByNumber.get(decoded ? parseInt(decoded.parts[1], 10) : -1);
        if (!repo || !pr) {
          ctx.errors.push({ message: 'Pull request not found' });
          return NULLV;
        }
        if (pr.merged) {
          ctx.errors.push({ message: 'Pull request is already merged' });
          return NULLV;
        }
        const res = store.squashMerge(repo, pr);
        if ('conflict' in res) {
          ctx.errors.push({ message: 'Merge conflict' });
          return NULLV;
        }
        return obj('MergePullRequestPayload', { pullRequest: pullValue(repo, pr), clientMutationId: input.clientMutationId ?? null });
      }
      if (field.name === 'addComment') {
        const decoded = typeof input.subjectId === 'string' ? decodeOpaqueId(input.subjectId) : null;
        const repo = decoded && decoded.kind === 'Issue' ? findRepoById(ctx, parseInt(decoded.parts[0], 10)) : undefined;
        const issue = repo?.issueByNumber.get(decoded ? parseInt(decoded.parts[1], 10) : -1);
        if (!repo || !issue) {
          ctx.errors.push({ message: 'Issue not found' });
          return NULLV;
        }
        const comment = { id: store.nextGlobalId, body: String(input.body ?? ''), user: store.ownerLogin() };
        store.nextGlobalId += 1;
        issue.comments.push(comment);
        const node = obj('IssueComment', { repo, issue, comment });
        return obj('AddCommentPayload', { commentEdge: obj('CommentEdge', { node, cursor: cursorFor(comment.id) }), clientMutationId: input.clientMutationId ?? null });
      }
      return NULLV;
    }
    case 'User': {
      const u = data as { login: string };
      if (field.name === 'login') return scalar(u.login);
      if (field.name === 'id') return scalar(opaqueId('User', 1));
      if (field.name === 'avatarUrl') return scalar('');
      return NULLV;
    }
    case 'Repository': {
      const repo = data as Repo;
      const owner = store.ownerLogin();
      if (field.name === 'id') return scalar(opaqueId('Repository', repo.id));
      if (field.name === 'databaseId') return scalar(repo.id);
      if (field.name === 'name') return scalar(repo.name);
      if (field.name === 'nameWithOwner') return scalar(`${owner}/${repo.name}`);
      if (field.name === 'owner') return obj('User', { login: owner });
      if (field.name === 'defaultBranchRef') return obj('Ref', { name: repo.defaultBranch });
      if (field.name === 'viewerPermission') return scalar('ADMIN');
      if (field.name === 'hasIssuesEnabled') return scalar(true);
      if (field.name === 'description') return scalar(repo.description);
      if (field.name === 'url') return scalar(`http://${ctx.host}/${owner}/${repo.name}`);
      if (field.name === 'createdAt') return scalar(repo.createdAt);
      if (field.name === 'updatedAt') return scalar(repo.updatedAt);
      if (field.name === 'issue') {
        const issue = repo.issueByNumber.get(Number(args.number));
        return issue ? issueValue(repo, issue) : NULLV;
      }
      if (field.name === 'issues') return issuesConnection(ctx, repo, args);
      if (field.name === 'pullRequests') return pullsConnection(ctx, repo, args);
      if (field.name === 'pullRequest') {
        const pr = repo.pullByNumber.get(Number(args.number));
        return pr ? pullValue(repo, pr) : NULLV;
      }
      return NULLV;
    }
    case 'Issue': {
      const { repo, issue } = data as IssueCtx;
      if (field.name === 'id') return scalar(opaqueId('Issue', repo.id, issue.number));
      if (field.name === 'number') return scalar(issue.number);
      if (field.name === 'title') return scalar(issue.title);
      if (field.name === 'body') return scalar(issue.body);
      if (field.name === 'state') return scalar(issue.state === 'open' ? 'OPEN' : 'CLOSED');
      if (field.name === 'createdAt') return scalar(repo.createdAt);
      if (field.name === 'author') return obj('User', { login: issue.user });
      if (field.name === 'url') return scalar(`http://${ctx.host}/${store.ownerLogin()}/${repo.name}/issues/${issue.number}`);
      if (field.name === 'labels') {
        const nodes = issue.labels.map((name) => obj('Label', { name, color: repo.labels.get(name)?.color ?? 'ededed' }));
        const pageInfo = obj('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null });
        return obj('LabelConnection', { nodes, pageInfo, totalCount: nodes.length });
      }
      if (field.name === 'comments') {
        const nodes = issue.comments.map((c) => obj('IssueComment', { repo, issue, comment: c }));
        const pageInfo = obj('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null });
        return obj('IssueCommentConnection', { nodes, pageInfo, totalCount: nodes.length });
      }
      return NULLV;
    }
    case 'PullRequest': {
      const { repo, pr } = data as PullCtx;
      if (field.name === 'id') return scalar(opaqueId('PullRequest', repo.id, pr.number));
      if (field.name === 'number') return scalar(pr.number);
      if (field.name === 'title') return scalar(pr.title);
      if (field.name === 'body') return scalar(pr.body);
      if (field.name === 'state') return scalar(pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED');
      if (field.name === 'merged') return scalar(pr.merged);
      if (field.name === 'mergeable') return scalar(pr.merged ? 'CONFLICTED' : store.computeMerge(repo, pr).mergeable ? 'MERGEABLE' : 'CONFLICTED');
      if (field.name === 'headRefName') return scalar(pr.headRef);
      if (field.name === 'baseRefName') return scalar(pr.baseRef);
      if (field.name === 'headRef') return obj('Ref', { name: pr.headRef });
      if (field.name === 'baseRef') return obj('Ref', { name: pr.baseRef });
      if (field.name === 'createdAt') return scalar(repo.createdAt);
      if (field.name === 'author') return obj('User', { login: store.ownerLogin() });
      if (field.name === 'url') return scalar(`http://${ctx.host}/${store.ownerLogin()}/${repo.name}/pull/${pr.number}`);
      if (field.name === 'files') {
        const files = store.prFiles(repo, pr).map((f) =>
          obj('PullRequestChangedFile', { path: f.path, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() }),
        );
        const first = typeof args.first === 'number' ? Math.max(0, args.first) : 100;
        const nodes = files.slice(0, first);
        const pageInfo = obj('PageInfo', { hasNextPage: files.length > nodes.length, hasPreviousPage: false, startCursor: null, endCursor: null });
        return obj('PullRequestChangedFileConnection', { nodes, pageInfo, totalCount: files.length });
      }
      return NULLV;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'LabelConnection':
    case 'IssueCommentConnection':
    case 'PullRequestChangedFileConnection':
    case 'SearchResultItemConnection': {
      const d = data as { nodes: GqlValue[]; edges?: GqlValue[]; pageInfo: GqlValue; totalCount?: number; issueCount?: number };
      if (field.name === 'nodes') return { kind: 'list', items: d.nodes ?? [] };
      if (field.name === 'edges') return { kind: 'list', items: d.edges ?? [] };
      if (field.name === 'pageInfo') return d.pageInfo;
      if (field.name === 'totalCount') return scalar(d.totalCount ?? (d.nodes?.length ?? 0));
      if (field.name === 'issueCount') return scalar(d.issueCount ?? 0);
      return NULLV;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'CommentEdge': {
      const d = data as { node: GqlValue; cursor: string };
      if (field.name === 'node') return d.node;
      if (field.name === 'cursor') return scalar(d.cursor);
      return NULLV;
    }
    case 'PageInfo': {
      const d = data as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      if (field.name === 'hasNextPage') return scalar(d.hasNextPage);
      if (field.name === 'hasPreviousPage') return scalar(d.hasPreviousPage);
      if (field.name === 'startCursor') return scalar(d.startCursor);
      if (field.name === 'endCursor') return scalar(d.endCursor);
      return NULLV;
    }
    case 'Ref': {
      const d = data as { name: string };
      if (field.name === 'name') return scalar(d.name);
      return NULLV;
    }
    case 'Label': {
      const d = data as { name: string; color: string };
      if (field.name === 'name') return scalar(d.name);
      if (field.name === 'color') return scalar(d.color);
      if (field.name === 'id') return scalar(opaqueId('Label', d.name));
      return NULLV;
    }
    case 'IssueComment': {
      const d = data as { repo: Repo; issue: Issue; comment: { id: number; body: string; user: string } };
      if (field.name === 'id') return scalar(opaqueId('IssueComment', d.repo.id, d.issue.number, d.comment.id));
      if (field.name === 'body') return scalar(d.comment.body);
      if (field.name === 'author') return obj('User', { login: d.comment.user });
      if (field.name === 'createdAt') return scalar(d.repo.createdAt);
      return NULLV;
    }
    case 'PullRequestChangedFile': {
      const d = data as { path: string; additions: number; deletions: number; changeType: string };
      if (field.name === 'path') return scalar(d.path);
      if (field.name === 'additions') return scalar(d.additions);
      if (field.name === 'deletions') return scalar(d.deletions);
      if (field.name === 'changeType') return scalar(d.changeType);
      return NULLV;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const d = data as { issue: GqlValue; clientMutationId: string | null };
      if (field.name === 'issue') return d.issue;
      if (field.name === 'clientMutationId') return scalar(d.clientMutationId);
      return NULLV;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const d = data as { pullRequest: GqlValue; clientMutationId: string | null };
      if (field.name === 'pullRequest') return d.pullRequest;
      if (field.name === 'clientMutationId') return scalar(d.clientMutationId);
      return NULLV;
    }
    case 'AddCommentPayload': {
      const d = data as { commentEdge: GqlValue; clientMutationId: string | null };
      if (field.name === 'commentEdge') return d.commentEdge;
      if (field.name === 'clientMutationId') return scalar(d.clientMutationId);
      return NULLV;
    }
    case '__Type': {
      const d = data as { name: string; kind: string; fields: string[] | null; enumValues: string[] | null };
      if (field.name === 'name') return scalar(d.name);
      if (field.name === 'kind') return scalar(d.kind);
      if (field.name === 'fields') {
        if (!d.fields) return NULLV;
        return { kind: 'list', items: d.fields.map((f) => obj('__Field', { name: f })) };
      }
      if (field.name === 'enumValues') {
        if (!d.enumValues) return NULLV;
        return { kind: 'list', items: d.enumValues.map((v) => obj('__Field', { name: v })) };
      }
      return NULLV;
    }
    case '__Field': {
      const d = data as { name: string };
      if (field.name === 'name') return scalar(d.name);
      if (field.name === 'description') return scalar(null);
      return NULLV;
    }
    case '__Schema': {
      if (field.name === 'queryType') return obj('__Type', { name: 'Query', kind: 'OBJECT', fields: SCHEMA.Query.fields ?? null, enumValues: null });
      if (field.name === 'mutationType') return obj('__Type', { name: 'Mutation', kind: 'OBJECT', fields: SCHEMA.Mutation.fields ?? null, enumValues: null });
      if (field.name === 'types') {
        return {
          kind: 'list',
          items: Object.entries(SCHEMA).map(([name, t]) => obj('__Type', { name, kind: t.kind, fields: t.fields ?? null, enumValues: t.enumValues ?? null })),
        };
      }
      return NULLV;
    }
    default:
      return NULLV;
  }
}

function materialize(ctx: Ctx, value: GqlValue, selections: SelectionNode[]): unknown {
  if (value.kind === 'null') return null;
  if (value.kind === 'scalar') return value.value;
  if (value.kind === 'list') return value.items.map((it) => materialize(ctx, it, selections));
  if (!selections || selections.length === 0) return null;
  return executeSelections(ctx, selections, value);
}

function executeSelections(ctx: Ctx, selections: SelectionNode[], parent: GqlValue): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const parentType = parent.kind === 'object' ? parent.type : '';
  for (const sel of selections) {
    if (sel.kind === 'field') {
      if (sel.name === '__typename') {
        out[sel.alias] = parentType;
        continue;
      }
      if (sel.name === '__type') {
        const args = resolveArgs(sel.args, ctx);
        const name = typeof args.name === 'string' ? args.name : '';
        const t = SCHEMA[name];
        if (!t) {
          out[sel.alias] = null;
          continue;
        }
        out[sel.alias] = materialize(ctx, obj('__Type', { name, kind: t.kind, fields: t.fields ?? null, enumValues: t.enumValues ?? null }), sel.selections);
        continue;
      }
      if (sel.name === '__schema') {
        out[sel.alias] = materialize(ctx, obj('__Schema', {}), sel.selections);
        continue;
      }
      const fields = SCHEMA[parentType]?.fields;
      if (!fields || !fields.includes(sel.name)) {
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${parentType}".` });
        out[sel.alias] = null;
        continue;
      }
      const resolved = resolveKnownField(ctx, parentType, parent.kind === 'object' ? parent.data : null, sel);
      out[sel.alias] = materialize(ctx, resolved, sel.selections);
    } else if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (!frag) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}".` });
        continue;
      }
      if (frag.typeCondition && frag.typeCondition !== parentType) continue;
      Object.assign(out, executeSelections(ctx, frag.selections, parent));
    } else if (sel.kind === 'inline') {
      if (sel.typeCondition && sel.typeCondition !== parentType) continue;
      Object.assign(out, executeSelections(ctx, sel.selections, parent));
    }
  }
  return out;
}

// ---------------------------------------------------------------- entry
export interface GqlResponse {
  status: number;
  body: unknown;
}

function executeOne(store: Store, doc: unknown, host: string): unknown {
  if (!doc || typeof doc !== 'object' || typeof (doc as Record<string, unknown>).query !== 'string') {
    return { errors: [{ message: 'Invalid GraphQL request: expected a query string' }] };
  }
  const d = doc as Record<string, unknown>;
  const variables = d.variables && typeof d.variables === 'object' ? (d.variables as Record<string, unknown>) : {};
  let ast: DocumentNode;
  try {
    ast = parseDocument(d.query as string);
  } catch (e) {
    return { data: null, errors: [{ message: (e as Error).message }] };
  }
  const opName = typeof d.operationName === 'string' ? d.operationName : null;
  const op = opName ? ast.operations.find((o) => o.name === opName) : ast.operations[0];
  if (!op) return { data: null, errors: [{ message: 'No operation found in document' }] };
  const ctx: Ctx = { store, host, variables, fragments: ast.fragments, errors: [] };
  const rootType = op.opType === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, op.selections, obj(rootType, null));
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

export function handleGraphql(store: Store, rawBody: string | null, host: string): GqlResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody ?? '');
  } catch {
    return { status: 400, body: { errors: [{ message: 'Invalid JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((doc) => executeOne(store, doc, host)) };
  }
  return { status: 200, body: executeOne(store, parsed, host) };
}
