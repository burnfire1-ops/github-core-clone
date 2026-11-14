// rest.ts — GitHub REST v3 API under /api/v3. Shares the Store with git, GraphQL and MCP.
// Every reply is JSON with a non-empty X-GitHub-Request-Id; unknown routes are
// JSON 404s, never HTML. A repository under a different owner than the learned
// one is a 404, never a 403.

import { parseCommit, parseTree } from './git.ts';
import { FIXED_TIME, type Issue, type Pull, type Repo, type Store } from './store.ts';
import type { Ctx, HandlerResult } from './app.ts';

export interface RestCtx extends Ctx {}

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): HandlerResult {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function errJson(status: number, message: string): HandlerResult {
  return json(status, { message, documentation_url: 'https://docs.github.com/rest' });
}

function baseUrl(host: string): string {
  return `http://${host}`;
}

function userJson(store: Store, host: string): Record<string, unknown> {
  const login = store.ownerLogin();
  return {
    login,
    id: 1,
    node_id: 'U_1',
    avatar_url: `${baseUrl(host)}/avatars/1`,
    type: 'User',
    site_admin: false,
    html_url: `${baseUrl(host)}/${login}`,
  };
}

export function repoJson(store: Store, repo: Repo, host: string): Record<string, unknown> {
  const login = store.ownerLogin();
  const base = baseUrl(host);
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: 1, node_id: 'U_1', type: 'User', site_admin: false },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `${base}/${login}/${repo.name}`,
    clone_url: `${base}/${login}/${repo.name}.git`,
    git_url: `git://${host}/${login}/${repo.name}.git`,
    ssh_url: `git@${host}:${login}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    archived: false,
    disabled: false,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    forks: 0,
    open_issues: repo.issues.filter((i) => i.state === 'open').length,
    watchers: 0,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue, host: string): Record<string, unknown> {
  const login = store.ownerLogin();
  const base = baseUrl(host);
  const comments = repo.comments.get(issue.number) ?? [];
  return {
    id: issue.id,
    node_id: issue.nodeId,
    url: `${base}/api/v3/repos/${login}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${login}/${repo.name}`,
    html_url: `${base}/${login}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: issue.userLogin, id: 1, node_id: 'U_1', type: 'User' },
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: label?.id ?? 0, node_id: `L_${repo.id}_${name}`, name, color: label?.color ?? 'd73a4a', description: label?.description ?? '', default: true };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
    state_reason: null,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull, host: string): Record<string, unknown> {
  const login = store.ownerLogin();
  const base = baseUrl(host);
  const liveHeadSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const liveBaseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: pull.nodeId,
    url: `${base}/api/v3/repos/${login}/${repo.name}/pulls/${pull.number}`,
    html_url: `${base}/${login}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: pull.userLogin, id: 1, node_id: 'U_1', type: 'User' },
    head: { label: `${login}:${pull.headRef}`, ref: pull.headRef, sha: liveHeadSha, user: { login, id: 1, type: 'User' }, repo: repoJson(store, repo, host) },
    base: { label: `${login}:${pull.baseRef}`, ref: pull.baseRef, sha: liveBaseSha, user: { login, id: 1, type: 'User' }, repo: repoJson(store, repo, host) },
    merged: pull.merged,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeable ? 'clean' : 'dirty',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    author_association: 'OWNER',
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label?.id ?? 0,
    node_id: `L_${repo.id}_${name}`,
    url: '',
    name,
    color: label?.color ?? 'd73a4a',
    description: label?.description ?? '',
    default: true,
  };
}

/** Resolve /repos/{owner}/{name}: 404 when the owner does not match the learned one. */
function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  if (store.learnedOwner !== null && owner !== store.learnedOwner) return null;
  const repo = store.getRepo(name);
  if (!repo) return null;
  store.learnOwner(owner);
  return repo;
}

function parsePage(ctx: Ctx): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(ctx: Ctx, items: T[]): { page: T[]; link: string | null } {
  const { page, perPage } = parsePage(ctx);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  let link: string | null = null;
  if (page < totalPages) {
    const q = new URLSearchParams(ctx.query);
    q.set('per_page', String(perPage));
    q.set('page', String(page + 1));
    const next = `http://${ctx.host}${ctx.pathname}?${q.toString()}`;
    const qLast = new URLSearchParams(ctx.query);
    qLast.set('per_page', String(perPage));
    qLast.set('page', String(totalPages));
    const last = `http://${ctx.host}${ctx.pathname}?${qLast.toString()}`;
    link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { page: slice, link };
}

function linkHeader(link: string | null): Record<string, string> {
  return link ? { link } : {};
}

function decodePathPart(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function handleRest(store: Store, ctx: Ctx): HandlerResult {
  const seg = ctx.segments.map(decodePathPart);
  const method = ctx.method;

  // GET /api/v3/
  if (seg.length === 2 && seg[0] === 'api' && seg[1] === 'v3' && method === 'GET') {
    return json(200, {
      current_user_url: `${baseUrl(ctx.host)}/api/v3/user`,
      repository_url: `${baseUrl(ctx.host)}/api/v3/repos/{owner}/{repo}`,
      meta_url: `${baseUrl(ctx.host)}/api/v3/meta`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (seg.length === 3 && seg[2] === 'meta' && method === 'GET') {
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true, git: ['1.0.0'], hooks: [] });
  }

  // GET /api/v3/user
  if (seg.length === 3 && seg[2] === 'user' && method === 'GET') {
    if (store.learnedOwner === null) return errJson(404, 'Not Found');
    return json(200, userJson(store, ctx.host));
  }

  // /api/v3/user/repos
  if (seg.length === 4 && seg[2] === 'user' && seg[3] === 'repos') {
    if (method === 'GET') {
      const { page, link } = paginate(ctx, store.listRepos());
      return json(200, page.map((r) => repoJson(store, r, ctx.host)), linkHeader(link));
    }
    if (method === 'POST') {
      const body = ctx.bodyJson ?? {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') return errJson(422, 'Validation Failed: name is required');
      if (store.getRepo(name)) return errJson(422, `Repository ${name} already exists`);
      const repo = store.createRepo(name, { description: body.description ?? '', isPrivate: body.private === true });
      return json(201, repoJson(store, repo, ctx.host));
    }
    return errJson(405, 'Method Not Allowed');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (seg.length >= 5 && seg[2] === 'repos') {
    const owner = seg[3];
    const repoName = seg[4];
    const rest = seg.slice(5);
    const repo = resolveRepo(store, owner, repoName);
    if (!repo) return errJson(404, 'Not Found');

    // Repository itself.
    if (rest.length === 0) {
      if (method === 'GET') return json(200, repoJson(store, repo, ctx.host));
      if (method === 'PATCH') {
        const body = ctx.bodyJson ?? {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
        return json(200, repoJson(store, repo, ctx.host));
      }
      if (method === 'DELETE') {
        store.deleteRepo(repoName);
        return { status: 204, headers: {}, body: '' };
      }
      return errJson(405, 'Method Not Allowed');
    }

    const head = rest[0];

    // Branches.
    if (head === 'branches' && rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([r]) => r.startsWith('refs/heads/'))
        .map(([r, sha]) => ({ name: r.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const { page, link } = paginate(ctx, branches);
      return json(200, page, linkHeader(link));
    }

    // Commits.
    if (head === 'commits' && rest.length === 1 && method === 'GET') {
      const shaParam = ctx.query.get('sha') ?? repo.defaultBranch;
      let tip = repo.refs.get(`refs/heads/${shaParam}`);
      if (!tip && /^[0-9a-f]{40}$/.test(shaParam)) tip = shaParam;
      if (!tip) return errJson(404, 'Not Found');
      const { page, link } = paginate(ctx, store.walkCommits(tip, 1000));
      const out = page.map((sha) => {
        const obj = store.getObject(sha);
        const info = obj ? parseCommit(obj.data) : null;
        const message = (info?.message ?? '').replace(/\n$/, '');
        const authorLine = info?.author ?? '';
        const m = /^(.*) <(.*)> (\d+) ([+-]\d+)$/.exec(authorLine);
        const date = m ? new Date(Number(m[3]) * 1000).toISOString() : FIXED_TIME;
        const author = { name: m?.[1] ?? 'Forge', email: m?.[2] ?? 'forge@example.invalid', date };
        return {
          sha,
          node_id: `C_${sha}`,
          commit: { author, committer: author, message, tree: { sha: info?.tree ?? '' }, url: '', comment_count: 0 },
          author: { login: store.ownerLogin(), id: 1, type: 'User' },
          committer: { login: store.ownerLogin(), id: 1, type: 'User' },
          parents: (info?.parents ?? []).map((p) => ({ sha: p, url: '' })),
        };
      });
      return json(200, out, linkHeader(link));
    }

    // Contents.
    if (head === 'contents') {
      const path = rest.slice(1).join('/');
      const refParam = ctx.query.get('ref') ?? repo.defaultBranch;
      let tip = repo.refs.get(`refs/heads/${refParam}`);
      if (!tip && /^[0-9a-f]{40}$/.test(refParam)) tip = refParam;
      if (method === 'GET') {
        if (!tip) return errJson(404, 'Not Found');
        const node = store.readPath(tip, path);
        if (!node) return errJson(404, 'Not Found');
        if (node.type === 'tree') {
          const entries = parseTree(node.data).map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            size: e.mode === '40000' ? 0 : (store.getObject(e.sha)?.data.length ?? 0),
            name: e.name,
            path: path === '' ? e.name : `${path}/${e.name}`,
            sha: e.sha,
            url: '',
            html_url: '',
            git_url: '',
            download_url: null,
          }));
          return json(200, entries);
        }
        return json(200, {
          type: 'file',
          encoding: 'base64',
          size: node.data.length,
          name: path.split('/').pop() ?? path,
          path,
          content: node.data.toString('base64'),
          sha: node.sha,
          url: '',
          html_url: '',
          git_url: '',
          download_url: null,
        });
      }
      if (method === 'PUT') {
        const body = ctx.bodyJson ?? {};
        if (typeof body.content !== 'string') return errJson(422, 'Validation Failed: content is required');
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        if (!repo.refs.has(`refs/heads/${branch}`) && repo.refs.size > 0) return errJson(404, 'Not Found');
        const branchTip = repo.refs.get(`refs/heads/${branch}`);
        const existing = branchTip ? store.readPath(branchTip, path) : null;
        if (existing && existing.type === 'blob' && typeof body.sha === 'string' && body.sha !== existing.sha) {
          return errJson(409, 'Conflict: sha does not match the current file');
        }
        const content = Buffer.from(body.content, 'base64');
        const changes = new Map<string, Buffer | null>([[path, content]]);
        const commitSha = store.commitOnBranch(repo, branch, body.message ?? `Update ${path}`, changes);
        const node = store.readPath(commitSha, path);
        const status = existing ? 200 : 201;
        return json(status, {
          content: {
            type: 'file', encoding: 'base64', size: content.length,
            name: path.split('/').pop() ?? path, path,
            content: content.toString('base64'), sha: node?.sha ?? '', url: '', html_url: '', git_url: '', download_url: null,
          },
          commit: { sha: commitSha, message: body.message ?? '', author: { name: 'Forge', email: 'forge@example.invalid', date: FIXED_TIME }, committer: { name: 'Forge', email: 'forge@example.invalid', date: FIXED_TIME }, tree: { sha: '' }, parents: [] },
        });
      }
      if (method === 'DELETE') {
        const body = ctx.bodyJson ?? {};
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const branchTip = repo.refs.get(`refs/heads/${branch}`);
        if (!branchTip) return errJson(404, 'Not Found');
        const existing = store.readPath(branchTip, path);
        if (!existing || existing.type !== 'blob') return errJson(404, 'Not Found');
        if (typeof body.sha === 'string' && body.sha !== existing.sha) {
          return errJson(409, 'Conflict: sha does not match the current file');
        }
        const changes = new Map<string, Buffer | null>([[path, null]]);
        const commitSha = store.commitOnBranch(repo, branch, body.message ?? `Delete ${path}`, changes);
        return json(200, { commit: { sha: commitSha } });
      }
      return errJson(405, 'Method Not Allowed');
    }

    // Labels.
    if (head === 'labels') {
      if (method === 'GET') {
        const { page, link } = paginate(ctx, [...repo.labels.values()].map((l) => labelJson(repo, l.name)));
        return json(200, page, linkHeader(link));
      }
      if (method === 'POST') {
        const body = ctx.bodyJson ?? {};
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') return errJson(422, 'Validation Failed: name is required');
        if (repo.labels.has(name)) return errJson(422, `Label ${name} already exists`);
        const label = { id: store.nextLabelId, name, color: body.color ?? 'd73a4a', description: body.description ?? '' };
        store.nextLabelId += 1;
        repo.labels.set(name, label);
        return json(201, labelJson(repo, name));
      }
      return errJson(405, 'Method Not Allowed');
    }

    // Issues.
    if (head === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const direction = (ctx.query.get('direction') ?? 'asc').toLowerCase();
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          list.sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
          const { page, link } = paginate(ctx, list);
          return json(200, page.map((i) => issueJson(store, repo, i, ctx.host)), linkHeader(link));
        }
        if (method === 'POST') {
          const body = ctx.bodyJson ?? {};
          const title = typeof body.title === 'string' ? body.title.trim() : '';
          if (title === '') return errJson(422, 'Validation Failed: title is required');
          const labels: string[] = Array.isArray(body.labels) ? body.labels.map((l: unknown) => (typeof l === 'string' ? l : (l as { name?: string })?.name ?? '')).filter(Boolean) : [];
          for (const l of labels) {
            if (!repo.labels.has(l)) return errJson(422, `Validation Failed: label "${l}" does not exist`);
          }
          const issue = store.createIssue(repo, title, body.body ?? '', labels);
          return json(201, issueJson(store, repo, issue, ctx.host));
        }
        return errJson(405, 'Method Not Allowed');
      }
      const num = parseInt(rest[1], 10);
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) return errJson(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return json(200, issueJson(store, repo, issue, ctx.host));
        if (method === 'PATCH') {
          const body = ctx.bodyJson ?? {};
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (Array.isArray(body.labels)) {
            const labels: string[] = body.labels.map((l: unknown) => (typeof l === 'string' ? l : (l as { name?: string })?.name ?? '')).filter(Boolean);
            for (const l of labels) {
              if (!repo.labels.has(l)) return errJson(422, `Validation Failed: label "${l}" does not exist`);
            }
            issue.labels = labels;
          }
          return json(200, issueJson(store, repo, issue, ctx.host));
        }
        return errJson(405, 'Method Not Allowed');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const list = repo.comments.get(num) ?? [];
        if (method === 'GET') {
          const { page, link } = paginate(ctx, list);
          return json(200, page.map((c) => ({
            id: c.id, node_id: c.nodeId, body: c.body,
            user: { login: c.userLogin, id: 1, type: 'User' },
            created_at: c.createdAt, updated_at: c.updatedAt, html_url: '',
          })), linkHeader(link));
        }
        if (method === 'POST') {
          const body = ctx.bodyJson ?? {};
          if (typeof body.body !== 'string' || body.body.trim() === '') return errJson(422, 'Validation Failed: body is required');
          const comment = {
            id: repo.nextCommentId,
            nodeId: `C_${repo.id}_${num}_${repo.nextCommentId}`,
            body: body.body,
            userLogin: store.ownerLogin(),
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME,
          };
          repo.nextCommentId += 1;
          list.push(comment);
          repo.comments.set(num, list);
          return json(201, {
            id: comment.id, node_id: comment.nodeId, body: comment.body,
            user: { login: comment.userLogin, id: 1, type: 'User' },
            created_at: comment.createdAt, updated_at: comment.updatedAt, html_url: '',
          });
        }
        return errJson(405, 'Method Not Allowed');
      }
      return errJson(404, 'Not Found');
    }

    // Pull requests.
    if (head === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.number - a.number);
          const { page, link } = paginate(ctx, list);
          return json(200, page.map((p) => pullJson(store, repo, p, ctx.host)), linkHeader(link));
        }
        if (method === 'POST') {
          const body = ctx.bodyJson ?? {};
          const title = typeof body.title === 'string' ? body.title.trim() : '';
          const headRef = typeof body.head === 'string' ? body.head : (body.head as { ref?: string } | undefined)?.ref ?? '';
          const baseRef = typeof body.base === 'string' ? body.base : (body.base as { ref?: string } | undefined)?.ref ?? repo.defaultBranch;
          if (title === '' || headRef === '') return errJson(422, 'Validation Failed: title and head are required');
          const headSha = repo.refs.get(`refs/heads/${headRef}`);
          const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
          if (!headSha || !baseSha) return errJson(422, 'Validation Failed: head or base branch not found');
          if (repo.pulls.some((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef)) {
            return errJson(422, 'Validation Failed: a pull request already exists for this head and base');
          }
          const pull = store.createPull(repo, title, body.body ?? '', headRef, headSha, baseRef, baseSha);
          pull.mergeable = !store.prIsConflicted(repo, pull);
          return json(201, pullJson(store, repo, pull, ctx.host));
        }
        return errJson(405, 'Method Not Allowed');
      }
      const num = parseInt(rest[1], 10);
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return errJson(404, 'Not Found');
      if (rest.length === 2 && method === 'GET') return json(200, pullJson(store, repo, pull, ctx.host));
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const files = diffFiles(store, pull);
        return json(200, files);
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull.merged || pull.state === 'closed') return errJson(405, 'Method Not Allowed: pull request is already closed');
        const mergedSha = store.squashMerge(repo, pull);
        if (mergedSha === null) {
          pull.mergeable = false;
          return errJson(405, 'Method Not Allowed: merge conflict');
        }
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = FIXED_TIME;
        pull.mergeCommitSha = mergedSha;
        return json(200, { sha: mergedSha, merged: true, message: 'Pull Request successfully merged' });
      }
      return errJson(404, 'Not Found');
    }

    // Git refs.
    if (head === 'git' && rest[1] === 'refs') {
      if (method === 'GET') {
        const refPath = rest.slice(2).join('/');
        if (refPath === '') {
          const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' as const, url: '' }, url: '' }));
          return json(200, all);
        }
        const fullRef = `refs/${refPath}`;
        const sha = repo.refs.get(fullRef);
        if (!sha) return errJson(404, 'Not Found');
        return json(200, { ref: fullRef, object: { sha, type: 'commit', url: '' }, url: '' });
      }
      if (method === 'POST') {
        const body = ctx.bodyJson ?? {};
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return errJson(422, 'Validation Failed: ref and sha are required');
        if (repo.refs.has(ref)) return errJson(422, 'Validation Failed: ref already exists');
        if (!store.getObject(sha)) return errJson(422, 'Validation Failed: sha not found');
        repo.refs.set(ref, sha);
        return json(201, { ref, object: { sha, type: 'commit', url: '' }, url: '' });
      }
      return errJson(405, 'Method Not Allowed');
    }

    return errJson(404, 'Not Found');
  }

  return errJson(404, 'Not Found');
}

// ------------------------------------------------------------ PR file diff
function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

function diffLines(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length > 0 && oldText.endsWith('\n')) a.pop();
  if (b.length > 0 && newText.endsWith('\n')) b.pop();
  // Longest-common-subsequence count, fine for the small files in a forge.
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const common = dp[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

export function diffFiles(store: Store, pull: Pull): Array<Record<string, unknown>> {
  const base = store.mergeBase(pull.headSha, pull.baseSha);
  const baseFiles = base !== null ? store.flattenTree(base) : new Map<string, { sha: string; isTree: boolean }>();
  const headFiles = store.flattenTree(pull.headSha);
  const out: Array<Record<string, unknown>> = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const p of [...paths].sort()) {
    const b = baseFiles.get(p);
    const h = headFiles.get(p);
    if (b?.isTree || h?.isTree) continue;
    const bSha = b ? b.sha : null;
    const hSha = h ? h.sha : null;
    if (bSha === hSha) continue;
    const oldText = bSha ? (store.getObject(bSha)?.data.toString('utf8') ?? '') : '';
    const newText = hSha ? (store.getObject(hSha)?.data.toString('utf8') ?? '') : '';
    let status: string;
    let additions = 0;
    let deletions = 0;
    if (bSha === null) {
      status = 'added';
      additions = countLines(newText);
    } else if (hSha === null) {
      status = 'removed';
      deletions = countLines(oldText);
    } else {
      status = 'modified';
      const d = diffLines(oldText, newText);
      additions = d.additions;
      deletions = d.deletions;
    }
    out.push({
      sha: hSha ?? bSha ?? '',
      filename: p,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '',
    });
  }
  return out;
}
