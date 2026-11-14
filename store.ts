// store.ts — in-memory forge store: repositories, git objects, issues,
// pull requests and labels. Everything lives in memory; nothing is synced
// to disk on the request path. Times are deterministic (a fixed base plus a
// per-commit counter) so two runs over the same operations leave the same
// state.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

const FIXED_TIME = '2026-11-14T00:00:00Z';
const COMMIT_TS_BASE = 1760000000;
const ZERO_OID = '0000000000000000000000000000000000000000';

// ------------------------------------------------------------------ objects
export function hashObject(type: ObjectType, content: Buffer): string {
  const head = Buffer.from(`${type} ${content.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(content).digest('hex');
}

export function encodeObject(type: ObjectType, content: Buffer): Buffer {
  const head = Buffer.from(`${type} ${content.length}\0`, 'utf8');
  return deflateSync(Buffer.concat([head, content]));
}

export function decodeObject(raw: Buffer): { type: ObjectType; content: Buffer } {
  const inflated = inflateSync(raw);
  const nul = inflated.indexOf(0);
  const head = inflated.subarray(0, nul).toString('utf8');
  const sp = head.indexOf(' ');
  return { type: head.slice(0, sp) as ObjectType, content: Buffer.from(inflated.subarray(nul + 1)) };
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(content: Buffer): CommitInfo {
  const text = content.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(
  tree: string,
  parents: string[],
  message: string,
  authorName: string,
  authorEmail: string,
  ts: number,
): Buffer {
  const ident = `${authorName} <${authorEmail}> ${ts} +0000`;
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${ident}\ncommitter ${ident}\n\n${message}\n`;
  return Buffer.from(s, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(content: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < content.length) {
    const sp = content.indexOf(0x20, off);
    if (sp === -1) break;
    const nul = content.indexOf(0, sp);
    if (nul === -1 || nul + 21 > content.length) break;
    entries.push({
      mode: content.subarray(off, sp).toString('utf8'),
      name: content.subarray(sp + 1, nul).toString('utf8'),
      oid: content.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTag(content: Buffer): { object: string; type: string } {
  const text = content.toString('utf8');
  const m = /^object ([0-9a-f]{40})$/m.exec(text);
  const t = /^type (\w+)$/m.exec(text);
  return { object: m ? m[1] : '', type: t ? t[1] : '' };
}

// ------------------------------------------------------------------ entities
export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdSeq: number;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, Buffer>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  issueByNumber: Map<number, Issue>;
  pulls: Pull[];
  pullByNumber: Map<number, Pull>;
  nextIssueNumber: number;
  nextPullNumber: number;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

// Opaque GraphQL node ids: base64url of "Kind:part:part". Never the bare
// numeric id, so a client cannot guess one id from another.
export function opaqueId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

export function decodeOpaqueId(id: string): { kind: string; parts: string[] } | null {
  try {
    const s = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = s.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ store
export class Store {
  owner: string | null = null;
  repos: Map<string, Repo> = new Map();
  nextRepoId = 1;
  nextGlobalId = 1;
  commitSeq = 0;
  opSeq = 0;

  learnOwner(login: string): void {
    if (this.owner === null) this.owner = login;
  }

  ownerMatches(login: string): boolean {
    if (this.owner === null) {
      this.owner = login;
      return true;
    }
    return this.owner === login;
  }

  ownerLogin(): string {
    return this.owner ?? '';
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  createRepo(name: string, opts: { isPrivate?: boolean; description?: string; defaultBranch?: string }): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      isPrivate: opts.isPrivate ?? false,
      description: opts.description ?? '',
      defaultBranch: opts.defaultBranch ?? 'main',
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      issueByNumber: new Map(),
      pulls: [],
      pullByNumber: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): void {
    this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  // ---------------------------------------------------------- git objects
  putObject(repo: Repo, type: ObjectType, content: Buffer): string {
    const oid = hashObject(type, content);
    if (!repo.objects.has(oid)) repo.objects.set(oid, encodeObject(type, content));
    return oid;
  }

  putObjectRaw(repo: Repo, oid: string, rawDeflated: Buffer): void {
    if (!repo.objects.has(oid)) repo.objects.set(oid, rawDeflated);
  }

  getObject(repo: Repo, oid: string): { type: ObjectType; content: Buffer } | null {
    const raw = repo.objects.get(oid);
    if (!raw) return null;
    try {
      return decodeObject(raw);
    } catch {
      return null;
    }
  }

  hasObject(repo: Repo, oid: string): boolean {
    return repo.objects.has(oid);
  }

  getCommit(repo: Repo, oid: string): CommitInfo | null {
    const obj = this.getObject(repo, oid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.content);
  }

  createCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    this.commitSeq += 1;
    const content = buildCommit(tree, parents, message, 'forge', 'forge@example.invalid', COMMIT_TS_BASE + this.commitSeq);
    return this.putObject(repo, 'commit', content);
  }

  // ---------------------------------------------------------- trees
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = this.getObject(repo, oid);
      if (!obj || obj.type !== 'tree') return;
      for (const e of parseTree(obj.content)) {
        if (e.mode === '40000') walk(e.oid, prefix + e.name + '/');
        else out.set(prefix + e.name, { oid: e.oid, mode: e.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
      for (const [path, v] of flat) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          entries.push({ mode: v.mode, name: rest, oid: v.oid });
        } else {
          const dir = rest.slice(0, slash);
          if (!dirs.has(dir)) dirs.set(dir, new Map());
          dirs.get(dir)!.set(path, v);
        }
      }
      for (const [dir, sub] of dirs) {
        entries.push({ mode: '40000', name: dir, oid: build(prefix + dir + '/') });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build('');
  }

  emptyTree(repo: Repo): string {
    return this.putObject(repo, 'tree', buildTree([]));
  }

  // ---------------------------------------------------------- history
  commitAncestors(repo: Repo, oid: string): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [oid];
    let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++];
      if (seen.has(cur) || cur === ZERO_OID) continue;
      seen.add(cur);
      const c = this.getCommit(repo, cur);
      if (!c) continue;
      for (const p of c.parents) queue.push(p);
    }
    return seen;
  }

  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    return this.commitAncestors(repo, desc).has(anc);
  }

  mergeBase(repo: Repo, a: string, b: string): string | null {
    const aSet = this.commitAncestors(repo, a);
    const queue: string[] = [b];
    const seen = new Set<string>();
    let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++];
      if (seen.has(cur) || cur === ZERO_OID) continue;
      seen.add(cur);
      if (aSet.has(cur)) return cur;
      const c = this.getCommit(repo, cur);
      if (!c) continue;
      for (const p of c.parents) queue.push(p);
    }
    return null;
  }

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  // Apply file changes to a branch tip and commit the result.
  commitOnBranch(
    repo: Repo,
    branch: string,
    changes: Map<string, Buffer | null>,
    message: string,
  ): { commit: string } | { error: string } {
    const tip = this.branchTip(repo, branch);
    let flat: Map<string, { oid: string; mode: string }>;
    let parents: string[];
    if (tip === null) {
      flat = new Map();
      parents = [];
    } else {
      const c = this.getCommit(repo, tip);
      if (!c) return { error: 'branch tip is not a commit' };
      flat = this.flattenTree(repo, c.tree);
      parents = [tip];
    }
    for (const [path, content] of changes) {
      if (content === null) flat.delete(path);
      else flat.set(path, { oid: this.putObject(repo, 'blob', content), mode: '100644' });
    }
    const tree = this.buildTreeFromFlat(repo, flat);
    const commit = this.createCommit(repo, tree, parents, message);
    repo.refs.set(`refs/heads/${branch}`, commit);
    return { commit };
  }

  // ---------------------------------------------------------- diff / merge
  diffFlat(
    base: Map<string, { oid: string; mode: string }>,
    head: Map<string, { oid: string; mode: string }>,
  ): Array<{ path: string; oldOid: string | null; newOid: string | null }> {
    const out: Array<{ path: string; oldOid: string | null; newOid: string | null }> = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const p of paths) {
      const b = base.get(p);
      const h = head.get(p);
      if (!b && h) out.push({ path: p, oldOid: null, newOid: h.oid });
      else if (b && !h) out.push({ path: p, oldOid: b.oid, newOid: null });
      else if (b && h && b.oid !== h.oid) out.push({ path: p, oldOid: b.oid, newOid: h.oid });
    }
    out.sort((x, y) => (x.path < y.path ? -1 : 1));
    return out;
  }

  private lineCounts(repo: Repo, oid: string | null): Map<string, number> {
    const counts = new Map<string, number>();
    if (!oid) return counts;
    const obj = this.getObject(repo, oid);
    if (!obj || obj.type !== 'blob') return counts;
    for (const line of obj.content.toString('utf8').split('\n')) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    return counts;
  }

  prFiles(repo: Repo, pr: Pull): FileChange[] {
    const headTip = this.branchTip(repo, pr.headRef) ?? pr.headSha;
    const baseTip = this.branchTip(repo, pr.baseRef) ?? pr.baseSha;
    const mb = this.mergeBase(repo, baseTip, headTip);
    if (mb === null) return [];
    const mbCommit = this.getCommit(repo, mb);
    const headCommit = this.getCommit(repo, headTip);
    if (!mbCommit || !headCommit) return [];
    const baseFlat = this.flattenTree(repo, mbCommit.tree);
    const headFlat = this.flattenTree(repo, headCommit.tree);
    const out: FileChange[] = [];
    for (const d of this.diffFlat(baseFlat, headFlat)) {
      let additions = 0;
      let deletions = 0;
      if (d.oldOid === null && d.newOid !== null) {
        additions = [...this.lineCounts(repo, d.newOid).values()].reduce((a, b) => a + b, 0);
      } else if (d.newOid === null && d.oldOid !== null) {
        deletions = [...this.lineCounts(repo, d.oldOid).values()].reduce((a, b) => a + b, 0);
      } else {
        const oldLines = this.lineCounts(repo, d.oldOid);
        const newLines = this.lineCounts(repo, d.newOid);
        for (const [line, n] of newLines) {
          const extra = n - (oldLines.get(line) ?? 0);
          if (extra > 0) additions += extra;
        }
        for (const [line, n] of oldLines) {
          const extra = n - (newLines.get(line) ?? 0);
          if (extra > 0) deletions += extra;
        }
      }
      out.push({
        path: d.path,
        status: d.oldOid === null ? 'added' : d.newOid === null ? 'removed' : 'modified',
        oldOid: d.oldOid,
        newOid: d.newOid,
        additions,
        deletions,
      });
    }
    return out;
  }

  // Three-way file-level merge check. Returns the merged tree when clean.
  computeMerge(repo: Repo, pr: Pull): { mergeable: boolean; conflicts: string[]; mergedTree: string | null; mergeBase: string | null } {
    const headTip = this.branchTip(repo, pr.headRef) ?? pr.headSha;
    const baseTip = this.branchTip(repo, pr.baseRef) ?? pr.baseSha;
    const mb = this.mergeBase(repo, baseTip, headTip);
    if (mb === null) return { mergeable: false, conflicts: ['no-merge-base'], mergedTree: null, mergeBase: null };
    const mbCommit = this.getCommit(repo, mb);
    const headCommit = this.getCommit(repo, headTip);
    const baseCommit = this.getCommit(repo, baseTip);
    if (!mbCommit || !headCommit || !baseCommit) {
      return { mergeable: false, conflicts: ['missing-commit'], mergedTree: null, mergeBase: mb };
    }
    const mbFlat = this.flattenTree(repo, mbCommit.tree);
    const headFlat = this.flattenTree(repo, headCommit.tree);
    const tipFlat = this.flattenTree(repo, baseCommit.tree);
    const conflicts: string[] = [];
    const merged = new Map(tipFlat);
    const headDiff = this.diffFlat(mbFlat, headFlat);
    const tipDiff = new Map(this.diffFlat(mbFlat, tipFlat).map((d) => [d.path, d]));
    for (const d of headDiff) {
      const t = tipDiff.get(d.path);
      if (t && t.newOid !== d.newOid) {
        conflicts.push(d.path);
        continue;
      }
      if (d.newOid === null) merged.delete(d.path);
      else merged.set(d.path, { oid: d.newOid, mode: headFlat.get(d.path)!.mode });
    }
    if (conflicts.length > 0) {
      return { mergeable: false, conflicts, mergedTree: null, mergeBase: mb };
    }
    return { mergeable: true, conflicts: [], mergedTree: this.buildTreeFromFlat(repo, merged), mergeBase: mb };
  }

  squashMerge(repo: Repo, pr: Pull): { sha: string } | { conflict: string } {
    const m = this.computeMerge(repo, pr);
    if (!m.mergeable || m.mergedTree === null) {
      return { conflict: 'merge conflict' };
    }
    const baseTip = this.branchTip(repo, pr.baseRef) ?? pr.baseSha;
    const commit = this.createCommit(repo, m.mergedTree, [baseTip], `${pr.title} (#${pr.number})`);
    repo.refs.set(`refs/heads/${pr.baseRef}`, commit);
    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = FIXED_TIME;
    pr.mergeCommitSha = commit;
    repo.updatedAt = FIXED_TIME;
    return { sha: commit };
  }

  // ---------------------------------------------------------- issues / pulls
  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    this.opSeq += 1;
    const issue: Issue = {
      id: this.nextGlobalId,
      number: repo.nextIssueNumber,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      user: this.ownerLogin(),
      createdSeq: this.opSeq,
      comments: [],
    };
    this.nextGlobalId += 1;
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    repo.issueByNumber.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string): Pull {
    this.opSeq += 1;
    const pr: Pull = {
      id: this.nextGlobalId,
      number: repo.nextPullNumber,
      title,
      body: body ?? '',
      state: 'open',
      headRef,
      headSha,
      baseRef,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.opSeq,
    };
    this.nextGlobalId += 1;
    repo.nextPullNumber += 1;
    repo.pulls.push(pr);
    repo.pullByNumber.set(pr.number, pr);
    return pr;
  }
}

export { ZERO_OID };
