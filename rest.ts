// rest.ts — the GitHub REST v3 API under /api/v3. Auth is enforced by the
// router (app.ts) before this runs. Every reply is JSON and carries an
// X-GitHub-Request-Id header (added by app.ts).
import type { Store, Repo, Issue, Pull } from './store.ts';
import { opaqueId } from './store.ts';

export interface RestResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResponse => ({ status, body, headers });
const err = (status: number, message: string): RestResponse => ({ status, body: { message } });

// ---------------------------------------------------------------- shapes
export function repoJson(store: Store, repo: Repo, host: string): Record<string, unknown> {
  const owner = store.ownerLogin();
  return {
    id: repo.id,
    node_id: opaqueId('Repository', repo.id),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User', avatar_url: '' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
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
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    default_branch: repo.defaultBranch,
    html_url: `http://${host}/${owner}/${repo.name}`,
    clone_url: `http://${host}/${owner}/${repo.name}.git`,
    git_url: `git://${host}/${owner}/${repo.name}.git`,
    ssh_url: `git@${host}:${owner}/${repo.name}.git`,
    url: `http://${host}/api/v3/repos/${owner}/${repo.name}`,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = store.ownerLogin();
  return {
    id: issue.id,
    node_id: opaqueId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return { name, color: l?.color ?? 'ededed', id: 0, description: '' };
    }),
    user: { login: issue.user, id: 1, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    closed_at: issue.state === 'closed' ? repo.updatedAt : null,
    html_url: `http://${owner}/${repo.name}/issues/${issue.number}`,
    url: `http://${owner}/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `http://${owner}/api/v3/repos/${owner}/${repo.name}`,
  };
}

export function pullJson(store: Store, repo: Repo, pr: Pull): Record<string, unknown> {
  const owner = store.ownerLogin();
  const headSha = store.branchTip(repo, pr.headRef) ?? pr.headSha;
  const baseSha = store.branchTip(repo, pr.baseRef) ?? pr.baseSha;
  const mergeable = pr.merged ? false : store.computeMerge(repo, pr).mergeable;
  return {
    id: pr.id,
    node_id: opaqueId('PullRequest', repo.id, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    user: { login: owner, id: 1, type: 'User' },
    head: { label: `${owner}:${pr.headRef}`, ref: pr.headRef, sha: headSha, user: { login: owner }, repo: { name: repo.name, full_name: `${owner}/${repo.name}` } },
    base: { label: `${owner}:${pr.baseRef}`, ref: pr.baseRef, sha: baseSha, user: { login: owner }, repo: { name: repo.name, full_name: `${owner}/${repo.name}` } },
    merged: pr.merged,
    mergeable,
    merge_commit_sha: pr.mergeCommitSha,
    merged_at: pr.mergedAt,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    closed_at: pr.state === 'closed' ? repo.updatedAt : null,
    html_url: `http://${owner}/${repo.name}/pull/${pr.number}`,
    url: `http://${owner}/api/v3/repos/${owner}/${repo.name}/pulls/${pr.number}`,
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

// ---------------------------------------------------------------- helpers
function paginate(items: unknown[], url: URL): { page: unknown[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URL(url.toString());
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    link = `<${next.toString()}>; rel="next"`;
  }
  return { page: pageItems, link };
}

function parseBody(rawBody: string | null): { body: Record<string, unknown> } | { error: RestResponse } {
  if (rawBody === null || rawBody === '') return { body: {} };
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: err(400, 'Request body must be a JSON object') };
    }
    return { body: parsed as Record<string, unknown> };
  } catch {
    return { error: err(400, 'Invalid JSON') };
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function branchOf(name: string): string {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

// Resolve /repos/{owner}/{repo} — owner must match the learned login.
function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  if (!store.ownerMatches(owner)) return null;
  return store.getRepo(name) ?? null;
}

// ---------------------------------------------------------------- contents
function contentsGet(store: Store, repo: Repo, path: string, ref: string | null, host: string): RestResponse {
  const branch = ref ?? repo.defaultBranch;
  const tip = store.branchTip(repo, branch);
  if (tip === null) return err(404, 'Branch not found');
  const commit = store.getCommit(repo, tip);
  if (!commit) return err(404, 'Branch not found');
  const flat = store.flattenTree(repo, commit.tree);
  const owner = store.ownerLogin();
  if (path === '') {
    const entries: Record<string, unknown>[] = [];
    const seenDirs = new Set<string>();
    for (const [p, v] of flat) {
      const slash = p.indexOf('/');
      if (slash === -1) {
        entries.push({ type: 'file', name: p, path: p, sha: v.oid, size: 0, url: '', html_url: '', git_url: '', download_url: '' });
      } else {
        const dir = p.slice(0, slash);
        if (!seenDirs.has(dir)) {
          seenDirs.add(dir);
          entries.push({ type: 'dir', name: dir, path: dir, sha: '', size: 0, url: '', html_url: '', git_url: '', download_url: '' });
        }
      }
    }
    entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return ok(200, entries);
  }
  const file = flat.get(path);
  if (file) {
    const obj = store.getObject(repo, file.oid);
    const content = obj && obj.type === 'blob' ? obj.content.toString('base64') : '';
    return ok(200, {
      type: 'file',
      encoding: 'base64',
      size: obj ? obj.content.length : 0,
      name: path.split('/').pop(),
      path,
      content,
      sha: file.oid,
      url: `http://${host}/api/v3/repos/${owner}/${repo.name}/contents/${path}`,
      html_url: `http://${host}/${owner}/${repo.name}/blob/${branch}/${path}`,
      git_url: '',
      download_url: '',
    });
  }
  // Directory?
  const prefix = `${path}/`;
  const entries: Record<string, unknown>[] = [];
  const seenDirs = new Set<string>();
  for (const [p, v] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      entries.push({ type: 'file', name: rest, path: p, sha: v.oid, size: 0, url: '', html_url: '', git_url: '', download_url: '' });
    } else {
      const dir = rest.slice(0, slash);
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        entries.push({ type: 'dir', name: dir, path: `${path}/${dir}`, sha: '', size: 0, url: '', html_url: '', git_url: '', download_url: '' });
      }
    }
  }
  if (entries.length === 0) return err(404, 'Not Found');
  entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return ok(200, entries);
}

function contentsPut(store: Store, repo: Repo, path: string, body: Record<string, unknown>): RestResponse {
  const message = str(body.message) || 'Update file';
  const contentB64 = str(body.content);
  const sha = str(body.sha);
  const branch = str(body.branch) || repo.defaultBranch;
  if (store.branchTip(repo, branch) === null && repo.refs.size > 0 && !repo.refs.has(`refs/heads/${branch}`)) {
    return err(404, 'Branch not found');
  }
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    return err(422, 'content is not valid base64');
  }
  const tip = store.branchTip(repo, branch);
  let existing: string | null = null;
  if (tip !== null) {
    const commit = store.getCommit(repo, tip);
    if (commit) existing = store.flattenTree(repo, commit.tree).get(path)?.oid ?? null;
  }
  if (sha !== '' && sha !== existing) return err(409, 'sha does not match the current blob');
  const isNew = existing === null;
  const changes = new Map<string, Buffer | null>([[path, content]]);
  const res = store.commitOnBranch(repo, branch, changes, message);
  if ('error' in res) return err(422, res.error);
  const blobOid = store.putObject(repo, 'blob', content);
  return ok(isNew ? 201 : 200, {
    content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
    commit: { sha: res.commit, message, author: { name: 'forge' }, committer: { name: 'forge' } },
  });
}

function contentsDelete(store: Store, repo: Repo, path: string, body: Record<string, unknown>): RestResponse {
  const message = str(body.message) || 'Delete file';
  const sha = str(body.sha);
  const branch = str(body.branch) || repo.defaultBranch;
  const tip = store.branchTip(repo, branch);
  if (tip === null) return err(404, 'Branch not found');
  const commit = store.getCommit(repo, tip);
  if (!commit) return err(404, 'Branch not found');
  const existing = store.flattenTree(repo, commit.tree).get(path)?.oid ?? null;
  if (existing === null) return err(404, 'Not Found');
  if (sha !== '' && sha !== existing) return err(409, 'sha does not match the current blob');
  const res = store.commitOnBranch(repo, branch, new Map([[path, null]]), message);
  if ('error' in res) return err(422, res.error);
  return ok(200, { commit: { sha: res.commit, message } });
}

// ---------------------------------------------------------------- router
export function handleRest(
  store: Store,
  method: string,
  pathname: string,
  url: URL,
  rawBody: string | null,
  host: string,
): RestResponse {
  let segments: string[];
  try {
    segments = pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    return err(404, 'Not Found');
  }
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') {
    return err(404, 'Not Found');
  }
  const rest = segments.slice(2);

  // GET /api/v3/ — root
  if (rest.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, {
      current_user_url: `http://${host}/api/v3/user`,
      repository_url: `http://${host}/api/v3/repos/{owner}/{repo}`,
      user_url: `http://${host}/api/v3/users/{user}`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (rest[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      hooks: [],
      git: [],
      github_enterprise: false,
    });
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (method === 'GET') {
      if (store.owner === null) return err(404, 'Not Found');
      return ok(200, { login: store.owner, id: 1, type: 'User', avatar_url: '' });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const { page, link } = paginate(store.listRepos().map((r) => repoJson(store, r, host)), url);
      return ok(200, page, link ? { link } : undefined);
    }
    if (method === 'POST') {
      const parsed = parseBody(rawBody);
      if ('error' in parsed) return parsed.error;
      const body = parsed.body;
      const name = str(body.name);
      if (name === '') return err(422, 'name is required');
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'name is invalid');
      if (store.getRepo(name)) return err(422, `Repository '${name}' already exists`);
      const repo = store.createRepo(name, {
        isPrivate: body.private === true,
        description: str(body.description),
        defaultBranch: str(body.default_branch) || undefined,
      });
      return ok(201, repoJson(store, repo, host));
    }
    return err(404, 'Not Found');
  }

  if (rest[0] !== 'repos' || rest.length < 3) return err(404, 'Not Found');
  const owner = rest[1];
  const repoName = rest[2];
  const repo = resolveRepo(store, owner, repoName);
  if (!repo) return err(404, 'Not Found');
  const tail = rest.slice(3);

  // /repos/{owner}/{repo} itself
  if (tail.length === 0) {
    if (method === 'GET') return ok(200, repoJson(store, repo, host));
    if (method === 'PATCH') {
      const parsed = parseBody(rawBody);
      if ('error' in parsed) return parsed.error;
      const body = parsed.body;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') {
        repo.defaultBranch = body.default_branch;
      }
      return ok(200, repoJson(store, repo, host));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repoName);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  const resource = tail[0];

  if (resource === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') return contentsGet(store, repo, path, url.searchParams.get('ref'), host);
    const parsed = parseBody(rawBody);
    if ('error' in parsed) return parsed.error;
    if (method === 'PUT') return contentsPut(store, repo, path, parsed.body);
    if (method === 'DELETE') return contentsDelete(store, repo, path, parsed.body);
    return err(404, 'Not Found');
  }

  if (resource === 'labels') {
    if (method === 'GET') {
      return ok(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, id: 0, description: '' })));
    }
    if (method === 'POST') {
      const parsed = parseBody(rawBody);
      if ('error' in parsed) return parsed.error;
      const name = str(parsed.body.name);
      if (name === '') return err(422, 'name is required');
      if (repo.labels.has(name)) return err(422, `Label '${name}' already exists`);
      const label = { name, color: str(parsed.body.color) || 'ededed' };
      repo.labels.set(name, label);
      return ok(201, { name: label.name, color: label.color, id: 0, description: '' });
    }
    return err(404, 'Not Found');
  }

  if (resource === 'issues') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const sort = url.searchParams.get('sort') ?? 'created';
        const direction = url.searchParams.get('direction') ?? 'desc';
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        const { page, link } = paginate(list.map((i) => issueJson(store, repo, i)), url);
        return ok(200, page, link ? { link } : undefined);
      }
      if (method === 'POST') {
        const parsed = parseBody(rawBody);
        if ('error' in parsed) return parsed.error;
        const body = parsed.body;
        const title = str(body.title);
        if (title === '') return err(422, 'title is required');
        const labels = Array.isArray(body.labels) ? body.labels.map(String) : [];
        for (const l of labels) {
          if (!repo.labels.has(l)) return err(422, `Label '${l}' does not exist`);
        }
        const issue = store.createIssue(repo, title, str(body.body), labels);
        return ok(201, issueJson(store, repo, issue));
      }
      return err(404, 'Not Found');
    }
    const num = parseInt(tail[1], 10);
    if (Number.isNaN(num)) return err(404, 'Not Found');
    const issue = repo.issueByNumber.get(num);
    if (tail.length === 2) {
      if (!issue) return err(404, 'Not Found');
      if (method === 'GET') return ok(200, issueJson(store, repo, issue));
      if (method === 'PATCH') {
        const parsed = parseBody(rawBody);
        if ('error' in parsed) return parsed.error;
        const body = parsed.body;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
        if (Array.isArray(body.labels)) {
          const labels = body.labels.map(String);
          for (const l of labels) {
            if (!repo.labels.has(l)) return err(422, `Label '${l}' does not exist`);
          }
          issue.labels = labels;
        }
        return ok(200, issueJson(store, repo, issue));
      }
      return err(404, 'Not Found');
    }
    if (tail[2] === 'comments') {
      if (!issue) return err(404, 'Not Found');
      if (method === 'GET') {
        return ok(200, issue.comments.map((c) => ({
          id: c.id,
          node_id: opaqueId('IssueComment', repo.id, issue.number, c.id),
          body: c.body,
          user: { login: c.user, id: 1, type: 'User' },
          created_at: repo.createdAt,
          updated_at: repo.updatedAt,
        })));
      }
      if (method === 'POST') {
        const parsed = parseBody(rawBody);
        if ('error' in parsed) return parsed.error;
        const bodyText = str(parsed.body.body);
        if (bodyText === '') return err(422, 'body is required');
        const comment = { id: store.nextGlobalId, body: bodyText, user: store.ownerLogin() };
        store.nextGlobalId += 1;
        issue.comments.push(comment);
        return ok(201, {
          id: comment.id,
          node_id: opaqueId('IssueComment', repo.id, issue.number, comment.id),
          body: comment.body,
          user: { login: comment.user, id: 1, type: 'User' },
          created_at: repo.createdAt,
          updated_at: repo.updatedAt,
        });
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  if (resource === 'branches') {
    if (method !== 'GET' || tail.length !== 1) return err(404, 'Not Found');
    const list = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }));
    return ok(200, list);
  }

  if (resource === 'commits') {
    if (method !== 'GET' || tail.length !== 1) return err(404, 'Not Found');
    const branch = url.searchParams.get('sha') ?? repo.defaultBranch;
    const tip = store.branchTip(repo, branch);
    if (tip === null) return ok(200, []);
    const out: Record<string, unknown>[] = [];
    const perPage = Math.max(1, Math.min(100, parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
    let cur: string | null = tip;
    const seen = new Set<string>();
    while (cur !== null && out.length < perPage && !seen.has(cur)) {
      seen.add(cur);
      const c = store.getCommit(repo, cur);
      if (!c) break;
      out.push({
        sha: cur,
        node_id: opaqueId('Commit', repo.id, cur),
        commit: {
          message: c.message.replace(/\n$/, ''),
          author: { name: 'forge', email: 'forge@example.invalid', date: repo.createdAt },
          committer: { name: 'forge', email: 'forge@example.invalid', date: repo.createdAt },
          tree: { sha: c.tree },
        },
        author: { login: store.ownerLogin() },
        committer: { login: store.ownerLogin() },
        parents: c.parents.map((p) => ({ sha: p })),
      });
      cur = c.parents[0] ?? null;
    }
    return ok(200, out);
  }

  if (resource === 'git' && tail[1] === 'refs') {
    if (tail.length === 2) {
      if (method === 'GET') {
        return ok(200, [...repo.refs.entries()].map(([name, sha]) => ({ ref: name, object: { sha, type: 'commit' } })));
      }
      if (method === 'POST') {
        const parsed = parseBody(rawBody);
        if ('error' in parsed) return parsed.error;
        const ref = str(parsed.body.ref);
        const sha = str(parsed.body.sha);
        if (!ref.startsWith('refs/')) return err(422, 'ref must start with refs/');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        if (!store.hasObject(repo, sha)) return err(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return ok(201, { ref, object: { sha, type: 'commit' } });
      }
      return err(404, 'Not Found');
    }
    const refName = `refs/${tail.slice(2).join('/')}`;
    if (method === 'GET') {
      const sha = repo.refs.get(refName);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, { ref: refName, object: { sha, type: 'commit' } });
    }
    if (method === 'PATCH') {
      const parsed = parseBody(rawBody);
      if ('error' in parsed) return parsed.error;
      const sha = str(parsed.body.sha);
      if (!repo.refs.has(refName)) return err(404, 'Not Found');
      if (!store.hasObject(repo, sha)) return err(422, 'Object does not exist');
      repo.refs.set(refName, sha);
      return ok(200, { ref: refName, object: { sha, type: 'commit' } });
    }
    return err(404, 'Not Found');
  }

  if (resource === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => b.number - a.number);
        const { page, link } = paginate(list.map((p) => pullJson(store, repo, p)), url);
        return ok(200, page, link ? { link } : undefined);
      }
      if (method === 'POST') {
        const parsed = parseBody(rawBody);
        if ('error' in parsed) return parsed.error;
        const body = parsed.body;
        const title = str(body.title);
        const head = branchOf(str(body.head));
        const base = branchOf(str(body.base));
        if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
        const headSha = store.branchTip(repo, head);
        const baseSha = store.branchTip(repo, base);
        if (headSha === null || baseSha === null) return err(422, 'head or base branch does not exist');
        const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
        if (dup) return err(422, 'A pull request already exists for this head and base');
        const pr = store.createPull(repo, title, str(body.body), head, headSha, base, baseSha);
        return ok(201, pullJson(store, repo, pr));
      }
      return err(404, 'Not Found');
    }
    const num = parseInt(tail[1], 10);
    if (Number.isNaN(num)) return err(404, 'Not Found');
    const pr = repo.pullByNumber.get(num);
    if (tail.length === 2) {
      if (!pr) return err(404, 'Not Found');
      if (method === 'GET') return ok(200, pullJson(store, repo, pr));
      return err(404, 'Not Found');
    }
    if (tail[2] === 'files') {
      if (!pr) return err(404, 'Not Found');
      if (method !== 'GET') return err(404, 'Not Found');
      const files = store.prFiles(repo, pr).map((f) => ({
        filename: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.additions + f.deletions,
        sha: f.newOid ?? f.oldOid,
        patch: f.status === 'added' ? '' : '',
      }));
      return ok(200, files);
    }
    if (tail[2] === 'merge') {
      if (!pr) return err(404, 'Not Found');
      if (method !== 'PUT') return err(404, 'Not Found');
      if (pr.merged) return err(405, 'Pull request is already merged');
      if (pr.state === 'closed') return err(405, 'Pull request is closed');
      const res = store.squashMerge(repo, pr);
      if ('conflict' in res) return err(405, 'Merge conflict');
      return ok(200, { sha: res.sha, merged: true, message: 'Pull request successfully merged' });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
