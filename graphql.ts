import {
  Store, Repo, FIXED_TS, encodeId, decodeId,
  parseCommit, treeOfCommit,
  createIssueRecord, addCommentRecord, createPullRecord, mergePullRecord, prFiles,
} from './store.ts';

// graphql.ts — a small hand-rolled GraphQL executor for the documents gh
// and github-mcp-server send: repository/issue/pull-request queries,
// connections with cursors, introspection, and the create/close/merge
// mutations. No external parser is available (stdlib only).

// ---------------------------------------------------------------- tokenizer

type TokKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'var';
interface Tok {
  kind: TokKind;
  value: string;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
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
      toks.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      toks.push({ kind: 'var', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      toks.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let out = '';
      i += 1;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const esc = src[i + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
            i += 4;
          } else out += esc;
          i += 2;
        } else {
          out += src[i];
          i += 1;
        }
      }
      i += 1;
      toks.push({ kind: 'string', value: out });
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      toks.push({ kind: 'var', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      let isFloat = false;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      if ((src[j] === 'e' || src[j] === 'E') && /[0-9+-]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      toks.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error('Unexpected character in GraphQL document: ' + ch);
  }
  return toks;
}

// ---------------------------------------------------------------- parser

export interface GqlSelection {
  kind: 'field' | 'fragment' | 'inline';
  name: string;
  alias: string;
  args: Record<string, unknown>;
  selections: GqlSelection[];
  typeCondition: string;
}

export interface GqlVarDef {
  type: string;
  defaultValue?: unknown;
}

export interface GqlOperation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string;
  variables: Record<string, GqlVarDef>;
  selections: GqlSelection[];
}

export interface GqlFragment {
  name: string;
  typeCondition: string;
  selections: GqlSelection[];
}

export interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, GqlFragment>;
}

class Parser {
  toks: Tok[];
  pos: number;

  constructor(toks: Tok[]) {
    this.toks = toks;
    this.pos = 0;
  }

  peek(): Tok | null {
    return this.toks[this.pos] ?? null;
  }

  next(): Tok {
    const t = this.toks[this.pos];
    if (!t) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }

  expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error('Expected ' + value + ' in GraphQL document');
  }

  expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('Expected name in GraphQL document');
    return t.value;
  }

  parseDocument(): GqlDocument {
    const doc: GqlDocument = { operations: [], fragments: new Map() };
    while (this.peek()) {
      const t = this.peek() as Tok;
      if (t.kind === 'punct' && t.value === '{') {
        doc.operations.push({ kind: 'query', name: '', variables: {}, selections: this.parseSelectionSet() });
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        this.next();
        let name = '';
        const n = this.peek();
        if (n && n.kind === 'name') name = this.next().value;
        const variables = this.parseVariableDefinitions();
        const selections = this.parseSelectionSet();
        doc.operations.push({ kind: t.value as 'query' | 'mutation' | 'subscription', name, variables, selections });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        doc.fragments.set(name, { name, typeCondition, selections });
      } else {
        throw new Error('Unexpected token in GraphQL document: ' + t.value);
      }
    }
    return doc;
  }

  parseVariableDefinitions(): Record<string, GqlVarDef> {
    const out: Record<string, GqlVarDef> = {};
    const t = this.peek();
    if (!t || t.kind !== 'punct' || t.value !== '(') return out;
    this.next();
    while (this.peek() && !(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const v = this.next();
      if (v.kind !== 'var') throw new Error('Expected variable in definition');
      this.expectPunct(':');
      let type = '';
      for (;;) {
        const tk = this.next();
        if (tk.kind === 'punct' && (tk.value === '[' || tk.value === ']' || tk.value === '!')) type += tk.value;
        else if (tk.kind === 'name') type += tk.value;
        else throw new Error('Bad variable type');
        const after = this.peek();
        if (!after || after.kind !== 'punct' || (after.value !== '[' && after.value !== ']' && after.value !== '!')) {
          if (after && after.kind === 'name') continue;
          break;
        }
      }
      const def: GqlVarDef = { type };
      const eq = this.peek();
      if (eq && eq.kind === 'punct' && eq.value === '=') {
        this.next();
        def.defaultValue = this.parseValue();
      }
      out[v.value] = def;
    }
    this.expectPunct(')');
    return out;
  }

  parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (this.peek() && !(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): GqlSelection {
    const t = this.peek() as Tok;
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const n = this.peek();
      if (n && n.kind === 'name' && n.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', name: '', alias: '', args: {}, selections: this.parseSelectionSet(), typeCondition };
      }
      if (n && n.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragment', name, alias: '', args: {}, selections: [], typeCondition: '' };
      }
      throw new Error('Bad fragment spread');
    }
    let name = this.expectName();
    let alias = '';
    const colon = this.peek();
    if (colon && colon.kind === 'punct' && colon.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selections: GqlSelection[] = [];
    const brace = this.peek();
    if (brace && brace.kind === 'punct' && brace.value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections, typeCondition: '' };
  }

  parseArguments(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const t = this.peek();
    if (!t || t.kind !== 'punct' || t.value !== '(') return out;
    this.next();
    while (this.peek() && !(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      out[name] = this.parseValue();
    }
    this.expectPunct(')');
    return out;
  }

  parseValue(): unknown {
    const t = this.next();
    if (t.kind === 'var') return { $var: t.value };
    if (t.kind === 'string') return t.value;
    if (t.kind === 'int') return parseInt(t.value, 10);
    if (t.kind === 'float') return parseFloat(t.value);
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return { $enum: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const list: unknown[] = [];
      while (this.peek() && !(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) list.push(this.parseValue());
      this.expectPunct(']');
      return list;
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek() && !(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        obj[name] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    throw new Error('Bad value in GraphQL document');
  }

  skipDirectives(): void {
    while (this.peek() && this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      this.parseArguments();
    }
  }
}

export function parseGqlDocument(src: string): GqlDocument {
  return new Parser(tokenize(src)).parseDocument();
}

// ---------------------------------------------------------------- schema

const FIELDS: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload', updateIssue: 'UpdateIssuePayload', createRepository: 'CreateRepositoryPayload' },
  User: { login: 'String', id: 'ID', name: 'String', avatarUrl: 'String', url: 'String', email: 'String' },
  Repository: { id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User', defaultBranchRef: 'Ref', viewerPermission: 'String', hasIssuesEnabled: 'Boolean', description: 'String', url: 'String', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
  Ref: { name: 'String', target: 'Commit' },
  Commit: { oid: 'String', message: 'String' },
  Issue: { id: 'ID', number: 'Int', title: 'String', state: 'IssueState', body: 'String', createdAt: 'String', url: 'String', author: 'User', labels: 'LabelConnection', comments: 'IssueCommentConnection' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PullRequest: { id: 'ID', number: 'Int', title: 'String', state: 'PullRequestState', merged: 'Boolean', mergeable: 'String', headRefName: 'String', baseRefName: 'String', headRefOid: 'String', baseRefOid: 'String', body: 'String', files: 'PullRequestFileConnection', author: 'User', createdAt: 'String', url: 'String' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestFileConnection: { nodes: 'PullRequestFile', edges: 'PullRequestFileEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestFileEdge: { node: 'PullRequestFile', cursor: 'String' },
  PullRequestFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  LabelConnection: { nodes: 'Label', totalCount: 'Int' },
  Label: { name: 'String', color: 'String', id: 'ID' },
  IssueCommentConnection: { nodes: 'IssueComment', totalCount: 'Int' },
  IssueComment: { id: 'ID', body: 'String', author: 'User' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  __Type: { name: 'String', kind: 'String', description: 'String', fields: '__Field', enumValues: '__EnumValue' },
  __Field: { name: 'String', description: 'String', args: '__InputValue', type: '__Type' },
  __EnumValue: { name: 'String', description: 'String' },
  __Schema: { types: '__Type', queryType: '__Type', mutationType: '__Type', description: 'String' },
  __InputValue: { name: 'String', description: 'String', type: '__Type' },
  Node: { id: 'ID' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', subject: 'Issue', clientMutationId: 'String' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  UpdateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreateRepositoryPayload: { repository: 'Repository', clientMutationId: 'String' },
};

const SEARCH_ENUMS = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

// ---------------------------------------------------------------- execution

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, GqlFragment>;
}

type AnyObj = Record<string, unknown>;

function resolveValue(value: unknown, ctx: Ctx): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, ctx));
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if ('$var' in rec) {
      const name = rec.$var as string;
      if (name in ctx.variables) return ctx.variables[name];
      return null;
    }
    if ('$enum' in rec) return rec.$enum as string;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec)) out[key] = resolveValue(rec[key], ctx);
    return out;
  }
  return value;
}

function resolveArgs(sel: GqlSelection, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(sel.args)) out[key] = resolveValue(sel.args[key], ctx);
  return out;
}

function cursorFor(n: number): string {
  return Buffer.from('cursor:' + n, 'utf8').toString('base64');
}

function cursorValue(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (text.startsWith('cursor:')) return parseInt(text.slice(7), 10);
    if (text.startsWith('idx:')) return parseInt(text.slice(4), 10);
    return null;
  } catch {
    return null;
  }
}

function issueStateOut(state: string): string {
  return state === 'closed' ? 'CLOSED' : 'OPEN';
}

function prStateOut(pr: { state: string; merged: boolean }): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function repoObj(repo: Repo): AnyObj {
  return { __type: 'Repository', __repo: repo };
}

function issueObj(repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: { name: string; color: string }[]; user: string; createdAt: string }): AnyObj {
  return { __type: 'Issue', __repo: repo, __issue: issue };
}

function prObj(repo: Repo, pr: { id: number; number: number; title: string; body: string; state: string; merged: boolean; mergeable: boolean; head: string; base: string; headSha: string; baseSha: string; user: string; createdAt: string }): AnyObj {
  return { __type: 'PullRequest', __repo: repo, __pr: pr };
}

function userObj(login: string): AnyObj {
  return { __type: 'User', __login: login };
}

function connection(typeName: string, items: AnyObj[], total: number, args: Record<string, unknown>): AnyObj {
  return { __type: typeName, __items: items, __total: total, __args: args };
}

function paginateConnection(conn: AnyObj, keyOf: (item: AnyObj) => number): { nodes: AnyObj[]; hasNextPage: boolean; endCursor: string | null; startCursor: string | null } {
  const items = conn.__items as AnyObj[];
  const args = conn.__args as Record<string, unknown>;
  const first = typeof args.first === 'number' ? args.first : items.length;
  const after = typeof args.after === 'string' ? cursorValue(args.after) : null;
  let filtered = items;
  if (after !== null) {
    const desc = (args.orderBy as Record<string, unknown> | undefined)?.direction === 'DESC';
    filtered = items.filter((item) => (desc ? keyOf(item) < after : keyOf(item) > after));
  }
  const nodes = filtered.slice(0, first);
  const hasNextPage = filtered.length > nodes.length;
  const last = nodes.length > 0 ? nodes[nodes.length - 1] : null;
  const firstNode = nodes.length > 0 ? nodes[0] : null;
  return {
    nodes,
    hasNextPage,
    endCursor: last ? cursorFor(keyOf(last)) : null,
    startCursor: firstNode ? cursorFor(keyOf(firstNode)) : null,
  };
}

function validateSelections(selections: GqlSelection[], typeName: string, ctx: Ctx, errors: { message: string }[]): void {
  for (const sel of selections) {
    if (sel.kind === 'field') {
      if (sel.name === '__typename') continue;
      const fields = FIELDS[typeName];
      if (!fields || !(sel.name in fields)) {
        errors.push({ message: 'Cannot query field "' + sel.name + '" on type "' + typeName + '".' });
        continue;
      }
      if (sel.selections.length > 0) validateSelections(sel.selections, fields[sel.name], ctx, errors);
    } else if (sel.kind === 'inline') {
      validateSelections(sel.selections, sel.typeCondition || typeName, ctx, errors);
    } else if (sel.kind === 'fragment') {
      const frag = ctx.fragments.get(sel.name);
      if (frag) validateSelections(frag.selections, frag.typeCondition, ctx, errors);
    }
  }
}

function executeSelections(typeName: string, obj: AnyObj | null, selections: GqlSelection[], ctx: Ctx): AnyObj | null {
  if (obj === null) return null;
  const out: AnyObj = {};
  for (const sel of selections) {
    if (sel.kind === 'field') {
      const key = sel.alias || sel.name;
      if (sel.name === '__typename') {
        out[key] = obj.__type as string;
        continue;
      }
      const value = resolveField(typeName, obj, sel, ctx);
      if (value === null || value === undefined) {
        out[key] = null;
        continue;
      }
      if (Array.isArray(value)) {
        const childType = FIELDS[typeName]?.[sel.name] ?? 'String';
        out[key] = value.map((item) => (item && typeof item === 'object' ? executeSelections(childType, item as AnyObj, sel.selections, ctx) : item));
        continue;
      }
      if (typeof value === 'object') {
        const childType = FIELDS[typeName]?.[sel.name] ?? 'String';
        out[key] = executeSelections(childType, value as AnyObj, sel.selections, ctx);
        continue;
      }
      out[key] = value;
    } else if (sel.kind === 'inline') {
      if (sel.typeCondition && sel.typeCondition !== (obj.__type as string) && sel.typeCondition !== 'Node') continue;
      const sub = executeSelections(sel.typeCondition || typeName, obj, sel.selections, ctx);
      if (sub) Object.assign(out, sub);
    } else if (sel.kind === 'fragment') {
      const frag = ctx.fragments.get(sel.name);
      if (!frag) continue;
      if (frag.typeCondition && frag.typeCondition !== (obj.__type as string) && frag.typeCondition !== 'Node') continue;
      const sub = executeSelections(frag.typeCondition, obj, frag.selections, ctx);
      if (sub) Object.assign(out, sub);
    }
  }
  return out;
}

function resolveField(typeName: string, obj: AnyObj, sel: GqlSelection, ctx: Ctx): unknown {
  const store = ctx.store;
  const args = resolveArgs(sel, ctx);
  const field = sel.name;

  if (typeName === 'Query') {
    if (field === 'viewer') return userObj(store.ownerLogin ?? '');
    if (field === 'repository') {
      const repo = store.findRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoObj(repo) : null;
    }
    if (field === 'node') {
      const decoded = decodeId(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
        return repo ? repoObj(repo) : null;
      }
      if (decoded.kind === 'Issue') {
        const repo = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
        const issue = repo?.issuesByNumber.get(Number(decoded.parts[1]));
        return repo && issue ? issueObj(repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const repo = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
        const pr = repo?.pullsByNumber.get(Number(decoded.parts[1]));
        return repo && pr ? prObj(repo, pr) : null;
      }
      return null;
    }
    if (field === '__type') {
      const name = String(args.name ?? '');
      if (!FIELDS[name] && name !== 'SearchType' && name !== 'IssueState' && name !== 'PullRequestState' && name !== 'OrderDirection') return null;
      return { __type: '__Type', __name: name };
    }
    if (field === '__schema') return { __type: '__Schema' };
    return null;
  }

  if (typeName === 'Mutation') {
    if (field === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeId(String(input.repositoryId ?? ''));
      const repo = decoded ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0])) : null;
      if (!repo) return null;
      const made = createIssueRecord(store, repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if (!made.issue) return null;
      return { __type: 'CreateIssuePayload', __issue: issueObj(repo, made.issue), __clientMutationId: input.clientMutationId ?? null };
    }
    if (field === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeId(String(input.issueId ?? ''));
      const repo = decoded ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0])) : null;
      const issue = repo?.issuesByNumber.get(Number(decoded?.parts[1] ?? 0));
      if (!repo || !issue) return null;
      issue.state = 'closed';
      issue.updatedAt = FIXED_TS;
      return { __type: 'CloseIssuePayload', __issue: issueObj(repo, issue), __clientMutationId: input.clientMutationId ?? null };
    }
    if (field === 'updateIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeId(String(input.id ?? input.issueId ?? ''));
      const repo = decoded ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0])) : null;
      const issue = repo?.issuesByNumber.get(Number(decoded?.parts[1] ?? 0));
      if (!repo || !issue) return null;
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (input.state === 'CLOSED') issue.state = 'closed';
      if (input.state === 'OPEN') issue.state = 'open';
      issue.updatedAt = FIXED_TS;
      return { __type: 'UpdateIssuePayload', __issue: issueObj(repo, issue), __clientMutationId: input.clientMutationId ?? null };
    }
    if (field === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeId(String(input.repositoryId ?? ''));
      const repo = decoded ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0])) : null;
      if (!repo) return null;
      const made = createPullRecord(store, repo, String(input.title ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''), String(input.body ?? ''));
      if (!made.pr) return null;
      return { __type: 'CreatePullRequestPayload', __pr: prObj(repo, made.pr), __clientMutationId: input.clientMutationId ?? null };
    }
    if (field === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeId(String(input.pullRequestId ?? ''));
      const repo = decoded ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0])) : null;
      const pr = repo?.pullsByNumber.get(Number(decoded?.parts[1] ?? 0));
      if (!repo || !pr) return null;
      const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
      mergePullRecord(repo, pr, method === 'merge' ? 'merge' : 'squash');
      return { __type: 'MergePullRequestPayload', __pr: prObj(repo, pr), __clientMutationId: input.clientMutationId ?? null };
    }
    if (field === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeId(String(input.subjectId ?? ''));
      const repo = decoded ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0])) : null;
      const issue = repo?.issuesByNumber.get(Number(decoded?.parts[1] ?? 0));
      if (!repo || !issue) return null;
      const comment = addCommentRecord(store, repo, issue.number, String(input.body ?? ''));
      if (!comment) return null;
      return {
        __type: 'AddCommentPayload',
        __commentEdge: { __type: 'IssueCommentEdge', __node: { __type: 'IssueComment', __repo: repo, __issueNumber: issue.number, __comment: comment } },
        __subject: issueObj(repo, issue),
        __clientMutationId: input.clientMutationId ?? null,
      };
    }
    if (field === 'createRepository') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const name = String(input.name ?? '');
      if (!name || store.repos.has(name)) return null;
      const repo = new Repo(store.nextRepoId, name, store.ownerLogin, input.visibility === 'PRIVATE', String(input.description ?? ''));
      store.nextRepoId += 1;
      store.repos.set(name, repo);
      return { __type: 'CreateRepositoryPayload', __repoObj: repoObj(repo), __clientMutationId: input.clientMutationId ?? null };
    }
    return null;
  }

  if (typeName === 'Repository') {
    const repo = obj.__repo as Repo;
    const owner = repo.owner ?? store.ownerLogin ?? '';
    switch (field) {
      case 'id': return encodeId('Repository', repo.id);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return owner + '/' + repo.name;
      case 'owner': return userObj(owner);
      case 'defaultBranchRef': return { __type: 'Ref', __name: repo.defaultBranch, __repo: repo };
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'url': return (store.baseUrl || '') + '/' + owner + '/' + repo.name;
      case 'issue': {
        const issue = repo.issuesByNumber.get(Number(args.number ?? 0));
        return issue ? issueObj(repo, issue) : null;
      }
      case 'issues': {
        let list = repo.issues.slice();
        const states = args.states as string[] | undefined;
        if (states) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        const orderBy = args.orderBy as Record<string, unknown> | undefined;
        const desc = orderBy?.direction === 'DESC';
        list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
        return connection('IssueConnection', list.map((i) => issueObj(repo, i)), list.length, args);
      }
      case 'pullRequests': {
        let list = repo.pulls.slice();
        const states = args.states as string[] | undefined;
        if (states) {
          const wanted = new Set(states.map((s) => String(s).toUpperCase()));
          list = list.filter((p) => wanted.has(prStateOut(p)));
        }
        const orderBy = args.orderBy as Record<string, unknown> | undefined;
        const desc = orderBy?.direction === 'DESC';
        list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
        return connection('PullRequestConnection', list.map((p) => prObj(repo, p)), list.length, args);
      }
      case 'pullRequest': {
        const pr = repo.pullsByNumber.get(Number(args.number ?? 0));
        return pr ? prObj(repo, pr) : null;
      }
      default: return null;
    }
  }

  if (typeName === 'User') return field === 'login' || field === 'name' ? (obj.__login as string) : field === 'id' ? encodeId('User', obj.__login as string) : null;

  if (typeName === 'Ref') {
    if (field === 'name') return obj.__name as string;
    if (field === 'target') {
      const repo = obj.__repo as Repo;
      const tip = repo.refs.get('refs/heads/' + (obj.__name as string));
      if (!tip) return null;
      const parsed = parseCommit(repo, tip);
      return parsed ? { __type: 'Commit', __oid: tip, __message: parsed.message } : null;
    }
    return null;
  }

  if (typeName === 'Commit') {
    if (field === 'oid') return obj.__oid as string;
    if (field === 'message') return (obj.__message as string).replace(/\n+$/, '');
    return null;
  }

  if (typeName === 'Issue') {
    const issue = obj.__issue as { id: number; number: number; title: string; body: string; state: string; labels: { name: string; color: string }[]; user: string; createdAt: string };
    const repo = obj.__repo as Repo;
    switch (field) {
      case 'id': return encodeId('Issue', repo.id, issue.number);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issueStateOut(issue.state);
      case 'body': return issue.body;
      case 'createdAt': return issue.createdAt;
      case 'url': return (store.baseUrl || '') + '/' + (repo.owner ?? store.ownerLogin ?? '') + '/' + repo.name + '/issues/' + issue.number;
      case 'author': return userObj(issue.user || (repo.owner ?? store.ownerLogin ?? ''));
      case 'labels': return connection('LabelConnection', issue.labels.map((l) => ({ __type: 'Label', __name: l.name, __color: l.color })), issue.labels.length, args);
      case 'comments': {
        const list = repo.comments.get(issue.number) ?? [];
        return connection('IssueCommentConnection', list.map((c) => ({ __type: 'IssueComment', __repo: repo, __issueNumber: issue.number, __comment: c })), list.length, args);
      }
      default: return null;
    }
  }

  if (typeName === 'PullRequest') {
    const pr = obj.__pr as { id: number; number: number; title: string; body: string; state: string; merged: boolean; mergeable: boolean; head: string; base: string; headSha: string; baseSha: string; user: string; createdAt: string };
    const repo = obj.__repo as Repo;
    switch (field) {
      case 'id': return encodeId('PullRequest', repo.id, pr.number);
      case 'number': return pr.number;
      case 'title': return pr.title;
      case 'state': return prStateOut(pr);
      case 'merged': return pr.merged;
      case 'mergeable': return pr.mergeable ? 'MERGEABLE' : 'CONFLICTING';
      case 'headRefName': return pr.head;
      case 'baseRefName': return pr.base;
      case 'headRefOid': return pr.headSha;
      case 'baseRefOid': return pr.baseSha;
      case 'body': return pr.body;
      case 'createdAt': return pr.createdAt;
      case 'url': return (store.baseUrl || '') + '/' + (repo.owner ?? store.ownerLogin ?? '') + '/' + repo.name + '/pull/' + pr.number;
      case 'author': return userObj(pr.user || (repo.owner ?? store.ownerLogin ?? ''));
      case 'files': {
        const full = repo.pullsByNumber.get(pr.number);
        const files = full ? prFiles(repo, full) : [];
        const nodes = files.map((f, i) => ({ __type: 'PullRequestFile', __path: f.filename, __additions: f.additions, __deletions: f.deletions, __changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'REMOVED' : 'MODIFIED', __index: i }));
        return connection('PullRequestFileConnection', nodes, nodes.length, args);
      }
      default: return null;
    }
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestFileConnection') {
    const keyOf = (item: AnyObj): number => {
      if (typeName === 'PullRequestFileConnection') return item.__index as number;
      const inner = item.__issue ?? item.__pr;
      return inner ? (inner as { number: number }).number : 0;
    };
    if (field === 'totalCount') return obj.__total as number;
    if (field === 'nodes') return paginateConnection(obj, keyOf).nodes;
    if (field === 'edges') {
      const page = paginateConnection(obj, keyOf);
      const edgeType = typeName === 'IssueConnection' ? 'IssueEdge' : typeName === 'PullRequestConnection' ? 'PullRequestEdge' : 'PullRequestFileEdge';
      return page.nodes.map((node) => ({ __type: edgeType, __node: node, __cursor: cursorFor(keyOf(node)) }));
    }
    if (field === 'pageInfo') {
      const page = paginateConnection(obj, keyOf);
      return { __type: 'PageInfo', __hasNextPage: page.hasNextPage, __endCursor: page.endCursor, __startCursor: page.startCursor };
    }
    return null;
  }

  if (typeName === 'LabelConnection' || typeName === 'IssueCommentConnection') {
    if (field === 'totalCount') return obj.__total as number;
    if (field === 'nodes') return obj.__items as AnyObj[];
    return null;
  }

  if (typeName === 'IssueEdge' || typeName === 'PullRequestEdge' || typeName === 'PullRequestFileEdge' || typeName === 'IssueCommentEdge') {
    if (field === 'node') return obj.__node as AnyObj;
    if (field === 'cursor') return obj.__cursor as string;
    return null;
  }

  if (typeName === 'PageInfo') {
    if (field === 'hasNextPage') return obj.__hasNextPage as boolean;
    if (field === 'hasPreviousPage') return false;
    if (field === 'endCursor') return obj.__endCursor as string | null;
    if (field === 'startCursor') return obj.__startCursor as string | null;
    return null;
  }

  if (typeName === 'Label') {
    if (field === 'name') return obj.__name as string;
    if (field === 'color') return obj.__color as string;
    if (field === 'id') return encodeId('Label', obj.__name as string);
    return null;
  }

  if (typeName === 'IssueComment') {
    const comment = obj.__comment as { id: number; body: string; user: string };
    if (field === 'id') return encodeId('IssueComment', (obj.__repo as Repo).id, obj.__issueNumber as number, comment.id);
    if (field === 'body') return comment.body;
    if (field === 'author') return userObj(comment.user);
    return null;
  }

  if (typeName === 'PullRequestFile') {
    if (field === 'path') return obj.__path as string;
    if (field === 'additions') return obj.__additions as number;
    if (field === 'deletions') return obj.__deletions as number;
    if (field === 'changeType') return obj.__changeType as string;
    return null;
  }

  if (typeName === '__Type') {
    const name = obj.__name as string;
    if (field === 'name') return name;
    if (field === 'kind') return name === 'SearchType' || name === 'IssueState' || name === 'PullRequestState' || name === 'OrderDirection' ? 'ENUM' : 'OBJECT';
    if (field === 'description') return null;
    if (field === 'fields') {
      const names = Object.keys(FIELDS[name] ?? {});
      return names.map((n) => ({ __type: '__Field', __name: n }));
    }
    if (field === 'enumValues') {
      if (name === 'SearchType') return SEARCH_ENUMS.map((n) => ({ __type: '__EnumValue', __name: n }));
      if (name === 'IssueState') return ['OPEN', 'CLOSED'].map((n) => ({ __type: '__EnumValue', __name: n }));
      if (name === 'PullRequestState') return ['OPEN', 'CLOSED', 'MERGED'].map((n) => ({ __type: '__EnumValue', __name: n }));
      return [];
    }
    return null;
  }

  if (typeName === '__Field') {
    if (field === 'name') return obj.__name as string;
    if (field === 'description') return null;
    if (field === 'args') return [];
    if (field === 'type') return { __type: '__Type', __name: 'String' };
    return null;
  }

  if (typeName === '__EnumValue') {
    if (field === 'name') return obj.__name as string;
    if (field === 'description') return null;
    return null;
  }

  if (typeName === '__Schema') {
    if (field === 'types') return Object.keys(FIELDS).map((n) => ({ __type: '__Type', __name: n }));
    if (field === 'queryType') return { __type: '__Type', __name: 'Query' };
    if (field === 'mutationType') return { __type: '__Type', __name: 'Mutation' };
    if (field === 'description') return null;
    return null;
  }

  if (typeName === '__InputValue') {
    if (field === 'name') return obj.__name as string;
    if (field === 'description') return null;
    if (field === 'type') return { __type: '__Type', __name: 'String' };
    return null;
  }

  if (typeName.endsWith('Payload')) {
    if (field === 'issue') return obj.__issue as AnyObj;
    if (field === 'pullRequest') return obj.__pr as AnyObj;
    if (field === 'repository') return obj.__repoObj as AnyObj;
    if (field === 'commentEdge') return obj.__commentEdge as AnyObj;
    if (field === 'subject') return obj.__subject as AnyObj;
    if (field === 'clientMutationId') return obj.__clientMutationId as string | null;
    return null;
  }

  return null;
}

function executeOperation(store: Store, doc: GqlDocument, op: GqlOperation, variables: Record<string, unknown>): Record<string, unknown> {
  const mergedVars: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(op.variables)) {
    if (name in variables) mergedVars[name] = variables[name];
    else if ('defaultValue' in def) mergedVars[name] = resolveValue(def.defaultValue, { store, variables, fragments: doc.fragments });
  }
  for (const [name, value] of Object.entries(variables)) {
    if (!(name in mergedVars)) mergedVars[name] = value;
  }
  const ctx: Ctx = { store, variables: mergedVars, fragments: doc.fragments };
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const errors: { message: string }[] = [];
  validateSelections(op.selections, rootType, ctx, errors);
  if (errors.length > 0) return { data: null, errors };
  const data = executeSelections(rootType, { __type: rootType } as AnyObj, op.selections, ctx);
  return { data };
}

export interface GqlResult {
  status: number;
  body: string;
}

export function handleGraphql(store: Store, body: unknown): GqlResult {
  if (Array.isArray(body)) {
    const results = body.map((item) => {
      if (!item || typeof item !== 'object') return { data: null, errors: [{ message: 'Invalid GraphQL request' }] };
      return runOne(store, item as Record<string, unknown>);
    });
    return { status: 200, body: JSON.stringify(results) };
  }
  if (!body || typeof body !== 'object') return { status: 200, body: JSON.stringify({ data: null, errors: [{ message: 'Invalid GraphQL request' }] }) };
  return { status: 200, body: JSON.stringify(runOne(store, body as Record<string, unknown>)) };
}

function runOne(store: Store, body: Record<string, unknown>): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (body.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof body.operationName === 'string' ? body.operationName : '';
  if (!query) return { data: null, errors: [{ message: 'Must provide query string.' }] };
  let doc: GqlDocument;
  try {
    doc = parseGqlDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  let op: GqlOperation | undefined;
  if (operationName) op = doc.operations.find((o) => o.name === operationName);
  if (!op) op = doc.operations[0];
  if (!op) return { data: null, errors: [{ message: 'No operation in document' }] };
  return executeOperation(store, doc, op, variables);
}
