import { createHash } from 'node:crypto';

// store.ts — in-memory store for the forge: repositories, git objects,
// trees, commits, issues, pull requests, labels and comments.
// All timestamps are fixed constants so two runs over the same operations
// leave identical state (no time or randomness is stored anywhere).

export const FIXED_TS = '2023-11-14T22:13:20Z';
export const FIXED_GIT_DATE = '1700000000 +0000';
export const FIXED_AUTHOR = 'forge <forge@example.invalid>';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface ObjRec {
  type: ObjType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface FlatEntry {
  oid: string;
  mode: string;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function sha1Hex(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

// The object id of a git object: SHA-1 over "<type> <len>\0" + content.
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(type + ' ' + data.length + '\0', 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function encodeId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function decodeId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const pieces = text.split(':');
    if (pieces.length < 2) return null;
    return { kind: pieces[0], parts: pieces.slice(1) };
  } catch {
    return null;
  }
}

export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? entry.name + '/' : entry.name;
}

export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const ka = treeSortKey(a);
  const kb = treeSortKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space === -1) break;
    const mode = data.subarray(off, space).toString('utf8');
    const nul = data.indexOf(0, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = entries.slice().sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(entry.mode + ' ' + entry.name + '\0', 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommitText(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const out: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: Label[];
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeable: boolean;
  mergeCommitSha: string;
  mergedAt: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export class Repo {
  id: number;
  name: string;
  owner: string | null;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, ObjRec>;
  refs: Map<string, string>;
  refVersion: number;
  labels: Map<string, Label>;
  issues: Issue[];
  issuesByNumber: Map<number, Issue>;
  pulls: Pull[];
  pullsByNumber: Map<number, Pull>;
  comments: Map<number, Comment[]>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  nextLabelId: number;
  // OPT-6: parsed-commit cache. Commits are immutable, so a cached
  // record never goes stale and is never invalidated.
  commitCache: Map<string, ParsedCommit>;
  // OPT-8: PR diff line-count caches. Blobs are immutable, so no
  // invalidation is needed.
  lineCountCache: Map<string, number>;
  diffCountCache: Map<string, { additions: number; deletions: number }>;
  // OPT-9: cached sorted ref list, keyed by the ref version counter.
  sortedRefsCache: { version: number; refs: { oid: string; name: string }[] } | null;

  constructor(id: number, name: string, owner: string | null, isPrivate: boolean, description: string) {
    this.id = id;
    this.name = name;
    this.owner = owner;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = 'main';
    this.objects = new Map();
    this.refs = new Map();
    this.refVersion = 0;
    this.labels = new Map();
    this.issues = [];
    this.issuesByNumber = new Map();
    this.pulls = [];
    this.pullsByNumber = new Map();
    this.comments = new Map();
    this.nextIssue = 1;
    this.nextPull = 1;
    this.nextComment = 1;
    this.nextLabelId = 1;
    this.commitCache = new Map();
    this.lineCountCache = new Map();
    this.diffCountCache = new Map();
    this.sortedRefsCache = null;
  }
}

export class Store {
  ownerLogin: string | null;
  repos: Map<string, Repo>;
  nextRepoId: number;
  nextObjId: number;
  reqSeq: number;
  baseUrl: string;

  constructor() {
    this.ownerLogin = null;
    this.repos = new Map();
    this.nextRepoId = 1;
    this.nextObjId = 1;
    this.reqSeq = 0;
    this.baseUrl = '';
  }

  // The login the token names is learned from the first repo-scoped request
  // that names a repository which actually exists. Until then the owner is
  // unknown and GET /api/v3/user answers 404.
  learnOwner(login: string): void {
    if (this.ownerLogin !== null) return;
    if (!login) return;
    this.ownerLogin = login;
    for (const repo of this.repos.values()) {
      if (repo.owner === null) repo.owner = login;
    }
  }

  findRepo(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (!repo) return null;
    if (this.ownerLogin === null) {
      if (repo.owner !== null) return null;
      this.learnOwner(owner);
      return repo;
    }
    if (owner !== this.ownerLogin) return null;
    if (repo.owner !== this.ownerLogin) return null;
    return repo;
  }

  findRepoByName(name: string): Repo | null {
    return this.repos.get(name) ?? null;
  }

  nextRequestId(): string {
    this.reqSeq += 1;
    return 'req-' + this.reqSeq;
  }
}

// ---------------------------------------------------------------- objects
// OPT-2: objects live in memory UNCOMPRESSED. putObject stores the raw
// record, getObject returns it directly; no deflate/inflate on this path.

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): ObjRec | null {
  return repo.objects.get(oid) ?? null;
}

export function parseCommit(repo: Repo, oid: string): ParsedCommit | null {
  const cached = repo.commitCache.get(oid);
  if (cached) return cached;
  const rec = getObject(repo, oid);
  if (!rec || rec.type !== 'commit') return null;
  const parsed = parseCommitText(rec.data);
  repo.commitCache.set(oid, parsed);
  return parsed;
}

export function makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
  let text = 'tree ' + tree + '\n';
  for (const parent of parents) text += 'parent ' + parent + '\n';
  text += 'author ' + FIXED_AUTHOR + ' ' + FIXED_GIT_DATE + '\n';
  text += 'committer ' + FIXED_AUTHOR + ' ' + FIXED_GIT_DATE + '\n';
  text += '\n' + message + '\n';
  return putObject(repo, 'commit', Buffer.from(text, 'utf8'));
}

export function emptyTreeOid(repo: Repo): string {
  return putObject(repo, 'tree', Buffer.alloc(0));
}

// ---------------------------------------------------------------- trees
export function flattenTree(repo: Repo, rootOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const rec = getObject(repo, oid);
    if (!rec || rec.type !== 'tree') return;
    for (const entry of parseTree(rec.data)) {
      if (entry.mode === '40000') walk(entry.oid, prefix + entry.name + '/');
      else out.set(prefix + entry.name, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(rootOid, '');
  return out;
}

// OPT-4: build trees from a trie, not by scanning the flat map per
// directory. One pass inserts every path into a nested trie; trees are
// then hashed bottom-up from already-computed child oids. Entry order
// and sorting are exactly as before (directories sort with a trailing
// slash), so every tree oid is byte-identical to the old method.
interface TrieNode {
  children: Map<string, TrieNode>;
  file: FlatEntry | null;
}

export function buildTreeFromFlat(repo: Repo, flat: Map<string, FlatEntry>): string {
  const root: TrieNode = { children: new Map(), file: null };
  for (const [path, ent] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length; i += 1) {
      let child = node.children.get(segments[i]);
      if (!child) {
        child = { children: new Map(), file: null };
        node.children.set(segments[i], child);
      }
      node = child;
      if (i === segments.length - 1) node.file = ent;
    }
  }
  const hashNode = (node: TrieNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, child] of node.children) {
      if (child.file) entries.push({ mode: child.file.mode, name, oid: child.file.oid });
      else entries.push({ mode: '40000', name, oid: hashNode(child) });
    }
    return putObject(repo, 'tree', serializeTree(entries));
  };
  return hashNode(root);
}

export function treeOfCommit(repo: Repo, commitOid: string): string | null {
  const parsed = parseCommit(repo, commitOid);
  return parsed ? parsed.tree : null;
}

// ---------------------------------------------------------------- graph

export function ancestorsSet(repo: Repo, start: string): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [start];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const parsed = parseCommit(repo, oid);
    if (!parsed) continue;
    for (const parent of parsed.parents) stack.push(parent);
  }
  return seen;
}

// OPT-6: the ancestor test stops the search as soon as the target is
// found; it does not build the full ancestor set first.
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const parsed = parseCommit(repo, oid);
    if (!parsed) continue;
    for (const parent of parsed.parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const aAncestors = ancestorsSet(repo, a);
  const stack: string[] = [b];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (aAncestors.has(oid)) return oid;
    const parsed = parseCommit(repo, oid);
    if (!parsed) continue;
    for (const parent of parsed.parents) stack.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------- commits

export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get('refs/heads/' + branch) ?? null;
}

export function setRef(repo: Repo, ref: string, oid: string): void {
  repo.refs.set(ref, oid);
  repo.refVersion += 1;
}

export function deleteRef(repo: Repo, ref: string): boolean {
  const had = repo.refs.delete(ref);
  if (had) repo.refVersion += 1;
  return had;
}

// OPT-5: path-copying commits. Applying a file change walks down only
// the changed path, rebuilding just the trees on the way back up and
// reusing every untouched subtree's oid. The old flatten-and-rebuild
// machinery (flattenTree/buildTreeFromFlat) stays for the diff/merge
// paths, which need full flat maps and are not hot.
function updateTree(
  repo: Repo,
  treeOid: string,
  segments: string[],
  idx: number,
  blobOid: string | null,
): string | null {
  const rec = getObject(repo, treeOid);
  const entries = rec && rec.type === 'tree' ? parseTree(rec.data) : [];
  const name = segments[idx];
  const last = idx === segments.length - 1;
  const pos = entries.findIndex((e) => e.name === name);
  if (last) {
    if (blobOid === null) {
      if (pos !== -1) entries.splice(pos, 1);
    } else if (pos !== -1) {
      entries[pos] = { mode: '100644', name, oid: blobOid };
    } else {
      entries.push({ mode: '100644', name, oid: blobOid });
    }
  } else {
    let childOid: string | null = null;
    if (pos !== -1 && entries[pos].mode === '40000') childOid = entries[pos].oid;
    const newChild = updateTree(repo, childOid ?? emptyTreeOid(repo), segments, idx + 1, blobOid);
    if (newChild === null) {
      if (pos !== -1) entries.splice(pos, 1);
    } else if (pos !== -1) {
      entries[pos] = { mode: '40000', name, oid: newChild };
    } else {
      entries.push({ mode: '40000', name, oid: newChild });
    }
  }
  if (entries.length === 0) return null;
  return putObject(repo, 'tree', serializeTree(entries));
}

export function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null; existed: boolean } {
  const tip = branchTip(repo, branch);
  const tipTree = tip ? treeOfCommit(repo, tip) : null;
  const segments = path.split('/').filter((s) => s.length > 0);
  const existed = tip ? getFileAt(repo, 'refs/heads/' + branch, path)?.kind === 'file' : false;
  let blobSha: string | null = null;
  if (content !== null) blobSha = putObject(repo, 'blob', content);
  const newRoot = updateTree(repo, tipTree ?? emptyTreeOid(repo), segments, 0, blobSha) ?? emptyTreeOid(repo);
  const commitSha = makeCommit(repo, newRoot, tip ? [tip] : [], message);
  setRef(repo, 'refs/heads/' + branch, commitSha);
  return { commitSha, blobSha, existed };
}

export type FileLookup =
  | { kind: 'file'; oid: string; data: Buffer; mode: string }
  | { kind: 'dir'; entries: TreeEntry[] }
  | null;

export function getFileAt(repo: Repo, refName: string, path: string): FileLookup {
  let tip = repo.refs.get(refName);
  if (!tip) tip = branchTip(repo, refName);
  if (!tip) {
    const rec = getObject(repo, refName);
    if (rec && rec.type === 'commit') tip = refName;
  }
  if (!tip) return null;
  const parsed = parseCommit(repo, tip);
  if (!parsed) return null;
  if (!path) {
    const rec = getObject(repo, parsed.tree);
    if (!rec) return null;
    return { kind: 'dir', entries: parseTree(rec.data) };
  }
  const segments = path.split('/').filter((s) => s.length > 0);
  let treeOid = parsed.tree;
  for (let i = 0; i < segments.length; i += 1) {
    const rec = getObject(repo, treeOid);
    if (!rec || rec.type !== 'tree') return null;
    const entry = parseTree(rec.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      if (entry.mode === '40000') {
        const sub = getObject(repo, entry.oid);
        if (!sub) return null;
        return { kind: 'dir', entries: parseTree(sub.data) };
      }
      const blob = getObject(repo, entry.oid);
      if (!blob) return null;
      return { kind: 'file', oid: entry.oid, data: blob.data, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}

// ---------------------------------------------------------------- diff

export interface DiffFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  oldOid: string | null;
  newOid: string | null;
}

function lcsLength(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[m];
}

function cachedLineCount(repo: Repo, oid: string): number {
  const cached = repo.lineCountCache.get(oid);
  if (cached !== undefined) return cached;
  const n = countLines(getObject(repo, oid)?.data ?? Buffer.alloc(0));
  repo.lineCountCache.set(oid, n);
  return n;
}

export function lineDiffCounts(repo: Repo, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
  const key = (oldOid ?? '-') + '|' + (newOid ?? '-');
  const cached = repo.diffCountCache.get(key);
  if (cached) return cached;
  let result: { additions: number; deletions: number };
  const oldLines = oldOid ? cachedLineCount(repo, oldOid) : 0;
  const newLines = newOid ? cachedLineCount(repo, newOid) : 0;
  if (!oldOid) result = { additions: newLines, deletions: 0 };
  else if (!newOid) result = { additions: 0, deletions: oldLines };
  else {
    const oldText = (getObject(repo, oldOid)?.data ?? Buffer.alloc(0)).toString('utf8');
    const newText = (getObject(repo, newOid)?.data ?? Buffer.alloc(0)).toString('utf8');
    const a = oldText.split('\n');
    const b = newText.split('\n');
    if (a.length > 0 && a[a.length - 1] === '') a.pop();
    if (b.length > 0 && b[b.length - 1] === '') b.pop();
    if (a.length * b.length > 250000) {
      const counts = new Map<string, number>();
      for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
      let common = 0;
      for (const line of b) {
        const c = counts.get(line) ?? 0;
        if (c > 0) {
          common += 1;
          counts.set(line, c - 1);
        }
      }
      result = { additions: b.length - common, deletions: a.length - common };
    } else {
      const common = lcsLength(a, b);
      result = { additions: b.length - common, deletions: a.length - common };
    }
  }
  repo.diffCountCache.set(key, result);
  return result;
}

export function diffFlats(repo: Repo, oldFlat: Map<string, FlatEntry>, newFlat: Map<string, FlatEntry>): DiffFile[] {
  const files: DiffFile[] = [];
  const paths = new Set<string>([...oldFlat.keys(), ...newFlat.keys()]);
  for (const path of paths) {
    const oldEnt = oldFlat.get(path);
    const newEnt = newFlat.get(path);
    if (oldEnt && !newEnt) {
      const counts = lineDiffCounts(repo, oldEnt.oid, null);
      files.push({ filename: path, status: 'removed', additions: 0, deletions: counts.deletions, oldOid: oldEnt.oid, newOid: null });
    } else if (!oldEnt && newEnt) {
      const counts = lineDiffCounts(repo, null, newEnt.oid);
      files.push({ filename: path, status: 'added', additions: counts.additions, deletions: 0, oldOid: null, newOid: newEnt.oid });
    } else if (oldEnt && newEnt && oldEnt.oid !== newEnt.oid) {
      const counts = lineDiffCounts(repo, oldEnt.oid, newEnt.oid);
      files.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, oldOid: oldEnt.oid, newOid: newEnt.oid });
    }
  }
  files.sort((x, y) => (x.filename < y.filename ? -1 : x.filename > y.filename ? 1 : 0));
  return files;
}

export function diffTrees(repo: Repo, oldRoot: string, newRoot: string): DiffFile[] {
  return diffFlats(repo, flattenTree(repo, oldRoot), flattenTree(repo, newRoot));
}

// ---------------------------------------------------------------- issues / pulls

export function createIssueRecord(store: Store, repo: Repo, title: string, body: string, labelNames: string[]): { issue: Issue | null; error: string | null } {
  const labels: Label[] = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name);
    if (!label) return { issue: null, error: 'Label "' + name + '" does not exist' };
    labels.push(label);
  }
  const issue: Issue = {
    id: store.nextObjId,
    number: repo.nextIssue,
    title,
    body,
    state: 'open',
    labels,
    user: store.ownerLogin ?? '',
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  };
  store.nextObjId += 1;
  repo.nextIssue += 1;
  repo.issues.push(issue);
  repo.issuesByNumber.set(issue.number, issue);
  repo.comments.set(issue.number, []);
  return { issue, error: null };
}

export function addCommentRecord(store: Store, repo: Repo, issueNumber: number, body: string): Comment | null {
  const issue = repo.issuesByNumber.get(issueNumber);
  if (!issue) return null;
  const comment: Comment = {
    id: store.nextObjId,
    body,
    user: store.ownerLogin ?? '',
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  };
  store.nextObjId += 1;
  repo.nextComment += 1;
  const list = repo.comments.get(issueNumber) ?? [];
  list.push(comment);
  repo.comments.set(issueNumber, list);
  return comment;
}

export function prConflict(repo: Repo, pr: Pull): boolean {
  const headTip = branchTip(repo, pr.head);
  const baseTip = branchTip(repo, pr.base);
  if (!headTip || !baseTip) return true;
  const base = mergeBase(repo, headTip, baseTip);
  if (!base) return false;
  const baseTree = treeOfCommit(repo, base) as string;
  const headTree = treeOfCommit(repo, headTip) as string;
  const baseTipTree = treeOfCommit(repo, baseTip) as string;
  const baseFlat = flattenTree(repo, baseTree);
  const headFlat = flattenTree(repo, headTree);
  const tipFlat = flattenTree(repo, baseTipTree);
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    const t = tipFlat.get(path);
    const headChanged = (b?.oid ?? null) !== (h?.oid ?? null);
    const tipChanged = (b?.oid ?? null) !== (t?.oid ?? null);
    if (headChanged && tipChanged && (h?.oid ?? null) !== (t?.oid ?? null)) return true;
  }
  return false;
}

export function createPullRecord(store: Store, repo: Repo, title: string, head: string, base: string, body: string): { pr: Pull | null; error: string | null } {
  const headTip = branchTip(repo, head);
  const baseTip = branchTip(repo, base);
  if (!headTip) return { pr: null, error: 'Head branch "' + head + '" does not exist' };
  if (!baseTip) return { pr: null, error: 'Base branch "' + base + '" does not exist' };
  for (const existing of repo.pulls) {
    if (existing.state === 'open' && existing.head === head && existing.base === base) {
      return { pr: null, error: 'A pull request already exists for ' + head };
    }
  }
  const pr: Pull = {
    id: store.nextObjId,
    number: repo.nextPull,
    title,
    body,
    state: 'open',
    head,
    base,
    headSha: headTip,
    baseSha: baseTip,
    merged: false,
    mergeable: true,
    mergeCommitSha: '',
    mergedAt: '',
    user: store.ownerLogin ?? '',
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  };
  store.nextObjId += 1;
  repo.nextPull += 1;
  repo.pulls.push(pr);
  repo.pullsByNumber.set(pr.number, pr);
  pr.mergeable = !prConflict(repo, pr);
  return { pr, error: null };
}

// Squash (default) or merge-commit merge of an open pull request onto its
// base branch. Returns the HTTP status the caller should answer with.
export function mergePullRecord(
  repo: Repo,
  pr: Pull,
  method: string,
): { status: number; sha: string; message: string } {
  if (pr.state !== 'open') return { status: 405, sha: '', message: 'Pull request is already closed' };
  if (prConflict(repo, pr)) {
    pr.mergeable = false;
    return { status: 405, sha: '', message: 'Pull request cannot be merged due to conflicts' };
  }
  const headTip = branchTip(repo, pr.head) as string;
  const baseTip = branchTip(repo, pr.base) as string;
  const base = mergeBase(repo, headTip, baseTip);
  const baseTree = base ? (treeOfCommit(repo, base) as string) : emptyTreeOid(repo);
  const headTree = treeOfCommit(repo, headTip) as string;
  const baseTipTree = treeOfCommit(repo, baseTip) as string;
  const baseFlat = flattenTree(repo, baseTree);
  const headFlat = flattenTree(repo, headTree);
  const result = flattenTree(repo, baseTipTree);
  for (const [path, ent] of headFlat) {
    if ((baseFlat.get(path)?.oid ?? null) !== ent.oid) result.set(path, ent);
  }
  for (const path of baseFlat.keys()) {
    if (!headFlat.has(path)) result.delete(path);
  }
  const root = buildTreeFromFlat(repo, result);
  const message = method === 'merge' ? 'Merge pull request #' + pr.number + ' from ' + pr.head : pr.title + ' (#' + pr.number + ')';
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const sha = makeCommit(repo, root, parents, message);
  setRef(repo, 'refs/heads/' + pr.base, sha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergeCommitSha = sha;
  pr.mergedAt = FIXED_TS;
  pr.updatedAt = FIXED_TS;
  return { status: 200, sha, message: 'Pull request successfully merged' };
}

export function prFiles(repo: Repo, pr: Pull): DiffFile[] {
  const headTip = branchTip(repo, pr.head);
  const baseTip = branchTip(repo, pr.base);
  if (!headTip || !baseTip) return [];
  const base = mergeBase(repo, headTip, baseTip);
  if (!base) return [];
  const baseTree = treeOfCommit(repo, base) as string;
  const headTree = treeOfCommit(repo, headTip) as string;
  return diffTrees(repo, baseTree, headTree);
}

// ---------------------------------------------------------------- views

export function repoView(store: Store, repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? store.ownerLogin ?? '';
  const base = store.baseUrl || 'http://localhost';
  return {
    id: repo.id,
    node_id: encodeId('Repository', repo.id),
    name: repo.name,
    full_name: owner ? owner + '/' + repo.name : repo.name,
    owner: { login: owner, id: 1, node_id: encodeId('User', owner), type: 'User', site_admin: false, avatar_url: '', html_url: base + '/' + owner, url: base + '/api/v3/users/' + owner },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    pushed_at: FIXED_TS,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    html_url: base + '/' + owner + '/' + repo.name,
    clone_url: base + '/' + owner + '/' + repo.name + '.git',
    git_url: base + '/' + owner + '/' + repo.name + '.git',
    ssh_url: 'git@github.com:' + owner + '/' + repo.name + '.git',
    url: base + '/api/v3/repos/' + owner + '/' + repo.name,
  };
}

export function issueView(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = repo.owner ?? store.ownerLogin ?? '';
  return {
    id: issue.id,
    node_id: encodeId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((l) => ({ id: l.id, node_id: encodeId('Label', repo.id, l.id), name: l.name, color: l.color, description: l.description, default: false })),
    user: { login: issue.user || owner, id: 1, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? FIXED_TS : null,
    author_association: 'OWNER',
    html_url: (store.baseUrl || '') + '/' + owner + '/' + repo.name + '/issues/' + issue.number,
    url: (store.baseUrl || '') + '/api/v3/repos/' + owner + '/' + repo.name + '/issues/' + issue.number,
  };
}

export function commentView(store: Store, repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
  const owner = repo.owner ?? store.ownerLogin ?? '';
  return {
    id: comment.id,
    node_id: encodeId('IssueComment', repo.id, issueNumber, comment.id),
    body: comment.body,
    user: { login: comment.user || owner, id: 1, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: (store.baseUrl || '') + '/' + owner + '/' + repo.name + '/issues/' + issueNumber + '#issuecomment-' + comment.id,
    url: (store.baseUrl || '') + '/api/v3/repos/' + owner + '/' + repo.name + '/issues/comments/' + comment.id,
  };
}

export function pullView(store: Store, repo: Repo, pr: Pull): Record<string, unknown> {
  const owner = repo.owner ?? store.ownerLogin ?? '';
  const base = store.baseUrl || '';
  return {
    id: pr.id,
    node_id: encodeId('PullRequest', repo.id, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    draft: false,
    merged: pr.merged,
    mergeable: pr.mergeable,
    merge_commit_sha: pr.mergeCommitSha || null,
    merged_at: pr.merged ? pr.mergedAt : null,
    merged_by: null,
    user: { login: pr.user || owner, id: 1, type: 'User' },
    head: { label: owner + ':' + pr.head, ref: pr.head, sha: pr.headSha, user: { login: owner, id: 1, type: 'User' }, repo: { name: repo.name, full_name: owner + '/' + repo.name } },
    base: { label: owner + ':' + pr.base, ref: pr.base, sha: pr.baseSha, user: { login: owner, id: 1, type: 'User' }, repo: { name: repo.name, full_name: owner + '/' + repo.name } },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.state === 'closed' ? FIXED_TS : null,
    html_url: base + '/' + owner + '/' + repo.name + '/pull/' + pr.number,
    url: base + '/api/v3/repos/' + owner + '/' + repo.name + '/pulls/' + pr.number,
  };
}
