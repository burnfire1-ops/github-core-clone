// store.ts — the forge's in-memory store: git objects, repos, refs, issues, pulls.
// Everything lives in memory; no per-request disk sync. Timestamps the forge
// itself invents are fixed constants, so two runs leave identical state.
// Repos are keyed by name only: the forge is single-tenant and the owner
// login is learned once, from the first repo-scoped request that names one.

import {
  hashObject,
  parseCommit,
  parseTree,
  serializeCommit,
  serializeTree,
  type ObjType,
} from './git.ts';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueComment {
  id: number;
  nodeId: string;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergeable: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  comments: Map<number, IssueComment[]>;
  issueSeq: number;
  pullSeq: number;
  nextCommentId: number;
  createdAt: string;
  updatedAt: string;
}

/** Fixed timestamp used for everything the forge creates, keeping state deterministic. */
export const FIXED_TIME = '2026-01-01T00:00:00Z';
/** Fixed git timestamp (seconds since epoch) for commits the forge creates. */
export const FIXED_GIT_TS = 1704067200;
const FORGE_AUTHOR = `Forge <forge@example.invalid> ${FIXED_GIT_TS} +0000`;

const ZERO_SHA = '0000000000000000000000000000000000000000';

export class Store {
  objects = new Map<string, GitObject>();
  repos = new Map<string, Repo>();
  learnedOwner: string | null = null;
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextLabelId = 1;

  // ------------------------------------------------------------ owner
  learnOwner(name: string): void {
    if (this.learnedOwner === null && name.length > 0) this.learnedOwner = name;
  }

  ownerLogin(): string {
    return this.learnedOwner ?? '';
  }

  // ------------------------------------------------------------ objects
  putObject(type: ObjType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  getObject(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  // ------------------------------------------------------------ repos
  createRepo(name: string, opts: { description?: string; isPrivate?: boolean }): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      comments: new Map(),
      issueSeq: 0,
      pullSeq: 0,
      nextCommentId: 1,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  // ------------------------------------------------------------ commits & trees
  /** Apply path changes onto a tree, returning the new tree sha. changes: path -> content (null = delete). */
  applyToTree(baseTreeSha: string | null, changes: Map<string, Buffer | null>): string {
    const applyLevel = (treeSha: string | null, levelChanges: Map<string, Buffer | null>): string => {
      const entries = treeSha !== null ? parseTree(this.getObject(treeSha)?.data ?? Buffer.alloc(0)) : [];
      const byName = new Map<string, { mode: string; name: string; sha: string }>();
      for (const e of entries) byName.set(e.name, e);
      // Group the pending changes by their next path segment at this level.
      const groups = new Map<string, Array<{ rest: string[]; content: Buffer | null }>>();
      for (const [p, c] of levelChanges) {
        const segs = p.split('/').filter((s) => s.length > 0);
        if (segs.length === 0) continue;
        const head = segs[0];
        const list = groups.get(head) ?? [];
        list.push({ rest: segs.slice(1), content: c });
        groups.set(head, list);
      }
      for (const [name, list] of groups) {
        if (list.length === 1 && list[0].rest.length === 0) {
          // Leaf change at this level.
          if (list[0].content === null) {
            byName.delete(name);
          } else {
            const blobSha = this.putObject('blob', list[0].content);
            byName.set(name, { mode: '100644', name, sha: blobSha });
          }
        } else {
          // Descend into a subtree.
          const sub = new Map<string, Buffer | null>();
          for (const item of list) sub.set(item.rest.join('/'), item.content);
          const existing = byName.get(name);
          const newSubSha = applyLevel(existing ? existing.sha : null, sub);
          const subObj = this.getObject(newSubSha);
          const subEntries = subObj ? parseTree(subObj.data) : [];
          if (subEntries.length === 0) {
            byName.delete(name);
          } else {
            byName.set(name, { mode: '40000', name, sha: newSubSha });
          }
        }
      }
      const out = [...byName.values()].sort((a, b) => {
        const an = a.mode === '40000' ? `${a.name}/` : a.name;
        const bn = b.mode === '40000' ? `${b.name}/` : b.name;
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
      return this.putObject('tree', serializeTree(out));
    };
    return applyLevel(baseTreeSha, changes);
  }

  /** Create a commit on a branch from path changes. Returns the new commit sha. */
  commitOnBranch(repo: Repo, branch: string, message: string, changes: Map<string, Buffer | null>): string {
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName) ?? null;
    const baseTree = tip !== null ? parseCommit(this.getObject(tip)?.data ?? Buffer.alloc(0)).tree : null;
    const treeSha = this.applyToTree(baseTree, changes);
    const msg = message.endsWith('\n') ? message : `${message}\n`;
    const commit = serializeCommit({
      tree: treeSha,
      parents: tip !== null ? [tip] : [],
      author: FORGE_AUTHOR,
      committer: FORGE_AUTHOR,
      message: msg,
    });
    const sha = this.putObject('commit', commit);
    repo.refs.set(refName, sha);
    return sha;
  }

  /** Read a path out of a commit's tree. Returns null when missing. */
  readPath(commitSha: string, path: string): { type: 'blob' | 'tree'; sha: string; data: Buffer } | null {
    const commitObj = this.getObject(commitSha);
    if (!commitObj || commitObj.type !== 'commit') return null;
    let treeSha = parseCommit(commitObj.data).tree;
    const segs = path.split('/').filter((s) => s.length > 0);
    if (segs.length === 0) {
      const treeObj = this.getObject(treeSha);
      return treeObj ? { type: 'tree', sha: treeSha, data: treeObj.data } : null;
    }
    for (let i = 0; i < segs.length; i += 1) {
      const treeObj = this.getObject(treeSha);
      if (!treeObj) return null;
      const entry = parseTree(treeObj.data).find((e) => e.name === segs[i]);
      if (!entry) return null;
      const obj = this.getObject(entry.sha);
      if (!obj) return null;
      if (i === segs.length - 1) {
        return { type: obj.type === 'tree' ? 'tree' : 'blob', sha: entry.sha, data: obj.data };
      }
      if (obj.type !== 'tree') return null;
      treeSha = entry.sha;
    }
    return null;
  }

  /** Flatten a commit's tree to path -> {sha, isTree}. */
  flattenTree(commitSha: string): Map<string, { sha: string; isTree: boolean }> {
    const out = new Map<string, { sha: string; isTree: boolean }>();
    const commitObj = this.getObject(commitSha);
    if (!commitObj || commitObj.type !== 'commit') return out;
    const walk = (treeSha: string, prefix: string): void => {
      const treeObj = this.getObject(treeSha);
      if (!treeObj) return;
      for (const entry of parseTree(treeObj.data)) {
        const p = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') {
          out.set(p, { sha: entry.sha, isTree: true });
          walk(entry.sha, p);
        } else {
          out.set(p, { sha: entry.sha, isTree: false });
        }
      }
    };
    walk(parseCommit(commitObj.data).tree, '');
    return out;
  }

  /** Newest-first commit shas walking first parents from a tip. */
  walkCommits(tipSha: string, limit: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let cur: string | null = tipSha;
    while (cur !== null && out.length < limit) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const obj = this.getObject(cur);
      if (!obj || obj.type !== 'commit') break;
      out.push(cur);
      const parents = parseCommit(obj.data).parents;
      cur = parents.length > 0 ? parents[0] : null;
    }
    return out;
  }

  /** All ancestors of a commit (inclusive), with BFS distance from the tip. */
  ancestors(tipSha: string): Map<string, number> {
    const dist = new Map<string, number>();
    const queue: Array<[string, number]> = [[tipSha, 0]];
    while (queue.length > 0) {
      const [sha, d] = queue.shift() as [string, number];
      if (dist.has(sha)) continue;
      const obj = this.getObject(sha);
      if (!obj || obj.type !== 'commit') continue;
      dist.set(sha, d);
      for (const p of parseCommit(obj.data).parents) {
        if (!dist.has(p)) queue.push([p, d + 1]);
      }
    }
    return dist;
  }

  isAncestor(anc: string, desc: string): boolean {
    if (anc === desc) return true;
    return this.ancestors(desc).has(anc);
  }

  mergeBase(a: string, b: string): string | null {
    const ancA = this.ancestors(a);
    const ancB = this.ancestors(b);
    let best: string | null = null;
    let bestDist = Infinity;
    for (const [sha, d] of ancB) {
      if (ancA.has(sha) && d < bestDist) {
        bestDist = d;
        best = sha;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ issues / pulls
  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    repo.issueSeq += 1;
    const number = repo.issueSeq;
    const issue: Issue = {
      id: this.nextIssueId,
      nodeId: `I_${repo.id}_${number}`,
      number,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      userLogin: this.ownerLogin(),
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    };
    this.nextIssueId += 1;
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string): Pull {
    repo.pullSeq += 1;
    const number = repo.pullSeq;
    const pull: Pull = {
      id: this.nextPullId,
      nodeId: `PR_${repo.id}_${number}`,
      number,
      title,
      body: body ?? '',
      state: 'open',
      headRef,
      headSha,
      baseRef,
      baseSha,
      merged: false,
      mergeable: true,
      mergedAt: null,
      mergeCommitSha: null,
      userLogin: this.ownerLogin(),
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    };
    this.nextPullId += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /** Recompute mergeable for a pull by a three-way file comparison. */
  prIsConflicted(repo: Repo, pull: Pull): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = this.mergeBase(pull.headSha, baseTip);
    if (base === null) return false;
    const baseFiles = this.flattenTree(base);
    const headFiles = this.flattenTree(pull.headSha);
    const tipFiles = this.flattenTree(baseTip);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
    for (const p of paths) {
      const b = baseFiles.get(p);
      const h = headFiles.get(p);
      const t = tipFiles.get(p);
      const bSha = b && !b.isTree ? b.sha : null;
      const hSha = h && !h.isTree ? h.sha : null;
      const tSha = t && !t.isTree ? t.sha : null;
      const headChanged = hSha !== bSha;
      const tipChanged = tSha !== bSha;
      if (headChanged && tipChanged && hSha !== tSha) return true;
    }
    return false;
  }

  /** Squash-merge a pull onto its base branch. Returns the new commit sha, or null on conflict. */
  squashMerge(repo: Repo, pull: Pull): string | null {
    if (this.prIsConflicted(repo, pull)) return null;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = this.mergeBase(pull.headSha, baseTip);
    const baseFiles = base !== null ? this.flattenTree(base) : new Map();
    const headFiles = this.flattenTree(pull.headSha);
    const changes = new Map<string, Buffer | null>();
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const p of paths) {
      const b = baseFiles.get(p);
      const h = headFiles.get(p);
      const bSha = b && !b.isTree ? b.sha : null;
      const hSha = h && !h.isTree ? h.sha : null;
      if (hSha === bSha) continue;
      if (h === undefined || h.isTree) {
        changes.set(p, null);
      } else {
        const obj = this.getObject(h.sha);
        if (obj) changes.set(p, obj.data);
      }
    }
    const tipTree = this.getObject(baseTip) ? parseCommit(this.getObject(baseTip)?.data ?? Buffer.alloc(0)).tree : null;
    const treeSha = this.applyToTree(tipTree, changes);
    const msg = `${pull.title}\n`;
    const commit = serializeCommit({
      tree: treeSha,
      parents: [baseTip],
      author: FORGE_AUTHOR,
      committer: FORGE_AUTHOR,
      message: msg,
    });
    const sha = this.putObject('commit', commit);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    return sha;
  }
}

export { ZERO_SHA };
