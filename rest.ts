import {
  Store, Repo, FIXED_TS, encodeId,
  getObject, parseCommit, treeOfCommit, flattenTree, commitFile, getFileAt,
  createIssueRecord, addCommentRecord, createPullRecord, mergePullRecord, prFiles,
  repoView, issueView, commentView, pullView,
} from './store.ts';

// rest.ts — the REST v3 API under /api/v3.

export interface RestCtx {
  method: string;
  segments: string[];
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  baseUrl: string;
}

export interface RestResult {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

function err(status: number, message: string): RestResult {
  return { status, headers: {}, body: JSON.stringify({ message }) };
}

function ok(status: number, value: unknown, headers: Record<string, string> = {}): RestResult {
  return { status, headers, body: JSON.stringify(value) };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isNaN(n) ? 0 : n;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(list: T[], query: URLSearchParams, path: string, baseUrl: string): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  const pageItems = list.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const total = list.length;
  if (start + perPage < total) {
    const next = new URL(path, baseUrl);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    const last = new URL(path, baseUrl);
    const lastPage = Math.ceil(total / perPage);
    last.searchParams.set('page', String(lastPage));
    last.searchParams.set('per_page', String(perPage));
    headers.link = '<' + next.toString() + '>; rel="next", <' + last.toString() + '>; rel="last"';
  }
  return { page: pageItems, headers };
}

function labelNamesOf(body: Record<string, unknown> | null): string[] {
  const raw = body?.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') names.push(item);
    else if (item && typeof item === 'object') {
      const name = (item as Record<string, unknown>).name;
      if (typeof name === 'string') names.push(name);
    }
  }
  return names;
}

function resolveRepo(store: Store, segments: string[]): Repo | null {
  return store.findRepo(segments[1], segments[2]);
}

export function handleRest(store: Store, ctx: RestCtx): RestResult {
  const { method, segments, query, body } = ctx;
  const seg = segments;

  if (seg.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, {
      current_user_url: ctx.baseUrl + '/api/v3/user',
      current_user_authorizations_html_url: ctx.baseUrl + '/api/v3/authorizations',
      authorizations_url: ctx.baseUrl + '/api/v3/authorizations',
      repository_url: ctx.baseUrl + '/api/v3/repos/{owner}/{repo}',
      user_url: ctx.baseUrl + '/api/v3/users/{user}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (seg[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true, github_services_sha: '0000000000000000000000000000000000000000', hooks: [], git: [], pages: [], importer: [], actions: [] });
  }

  if (seg[0] === 'rate_limit') {
    if (method !== 'GET') return err(404, 'Not Found');
    const res = { limit: 5000, remaining: 5000, reset: 1700000000, used: 0 };
    return ok(200, { resources: { core: res, search: res, graphql: res, code_scanning_upload: res }, rate: res });
  }

  if (seg[0] === 'user') {
    if (seg.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      if (!store.ownerLogin) return err(404, 'Not Found');
      return ok(200, {
        login: store.ownerLogin, id: 1, node_id: encodeId('User', store.ownerLogin), type: 'User', site_admin: false,
        name: store.ownerLogin, email: null, avatar_url: '', html_url: ctx.baseUrl + '/' + store.ownerLogin,
        url: ctx.baseUrl + '/api/v3/users/' + store.ownerLogin, created_at: FIXED_TS, updated_at: FIXED_TS,
      });
    }
    if (seg.length === 2 && seg[1] === 'repos') {
      if (method === 'GET') {
        const list = [...store.repos.values()]
          .filter((r) => store.ownerLogin === null || r.owner === store.ownerLogin)
          .sort((a, b) => a.id - b.id)
          .map((r) => repoView(store, r));
        const { page, headers } = paginate(list, query, ctx.path, ctx.baseUrl);
        return ok(200, page, headers);
      }
      if (method === 'POST') {
        const name = str(body?.name);
        if (!name) return err(422, 'name is required');
        if (store.repos.has(name)) return err(422, 'Repository already exists');
        const repo = new Repo(store.nextRepoId, name, store.ownerLogin, body?.private === true, str(body?.description));
        store.nextRepoId += 1;
        store.repos.set(name, repo);
        return ok(201, repoView(store, repo));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    const repo = resolveRepo(store, seg);
    if (!repo) return err(404, 'Not Found');
    const rest = seg.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoView(store, repo));
      if (method === 'PATCH') {
        if (body && typeof body.description === 'string') repo.description = body.description;
        if (body && typeof body.private === 'boolean') repo.isPrivate = body.private;
        if (body && typeof body.default_branch === 'string' && body.default_branch) repo.defaultBranch = body.default_branch;
        return ok(200, repoView(store, repo));
      }
      if (method === 'DELETE') {
        store.repos.delete(repo.name);
        return { status: 204, headers: {}, body: null };
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      const branch = str(query.get('branch') ?? (body?.branch as string | undefined) ?? '') || repo.defaultBranch;
      if (method === 'GET') {
        const ref = query.get('ref') ?? branch;
        const found = getFileAt(repo, ref, path);
        if (!found) return err(404, 'Not Found');
        if (found.kind === 'dir') {
          const entries = found.entries.map((e) => ({
            name: e.name,
            path: path ? path + '/' + e.name : e.name,
            sha: e.oid,
            size: e.mode === '40000' ? 0 : (getObject(repo, e.oid)?.data.length ?? 0),
            type: e.mode === '40000' ? 'dir' : 'file',
            url: ctx.baseUrl + '/api/v3/repos/' + seg[1] + '/' + seg[2] + '/contents/' + (path ? path + '/' + e.name : e.name),
            html_url: ctx.baseUrl + '/' + seg[1] + '/' + seg[2] + '/blob/' + ref + '/' + (path ? path + '/' + e.name : e.name),
            download_url: null,
          }));
          return ok(200, entries);
        }
        return ok(200, {
          name: path.split('/').pop(),
          path,
          sha: found.oid,
          size: found.data.length,
          type: 'file',
          content: found.data.toString('base64'),
          encoding: 'base64',
          url: ctx.baseUrl + '/api/v3/repos/' + seg[1] + '/' + seg[2] + '/contents/' + path,
          html_url: ctx.baseUrl + '/' + seg[1] + '/' + seg[2] + '/blob/' + ref + '/' + path,
          download_url: null,
        });
      }
      if (method === 'PUT') {
        const contentB64 = str(body?.content);
        if (!contentB64 && contentB64 !== '') return err(422, 'content is required');
        const content = Buffer.from(contentB64, 'base64');
        const targetBranch = str(body?.branch as string | undefined) || repo.defaultBranch;
        if (!repo.refs.has('refs/heads/' + targetBranch) && repo.refs.size > 0) return err(404, 'Branch not found');
        const existing = getFileAt(repo, 'refs/heads/' + targetBranch, path);
        const sha = str(body?.sha);
        if (existing && existing.kind === 'file') {
          if (!sha || sha !== existing.oid) return err(409, 'sha does not match the current file');
        } else if (existing && existing.kind === 'dir') {
          return err(422, 'path is a directory');
        } else if (sha) {
          return err(409, 'sha does not match the current file');
        }
        const wasNew = !existing;
        const result = commitFile(repo, targetBranch, path, content, str(body?.message) || 'Update ' + path);
        return ok(wasNew ? 201 : 200, {
          content: { name: path.split('/').pop(), path, sha: result.blobSha, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
          commit: { sha: result.commitSha, message: str(body?.message) || 'Update ' + path, author: { name: 'forge', email: 'forge@example.invalid', date: FIXED_TS }, committer: { name: 'forge', email: 'forge@example.invalid', date: FIXED_TS } },
        });
      }
      if (method === 'DELETE') {
        const targetBranch = str(body?.branch as string | undefined) || repo.defaultBranch;
        const existing = getFileAt(repo, 'refs/heads/' + targetBranch, path);
        if (!existing || existing.kind !== 'file') return err(404, 'Not Found');
        const sha = str(body?.sha);
        if (sha && sha !== existing.oid) return err(409, 'sha does not match the current file');
        const result = commitFile(repo, targetBranch, path, null, str(body?.message) || 'Delete ' + path);
        return ok(200, { commit: { sha: result.commitSha, message: str(body?.message) || 'Delete ' + path } });
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'labels') {
      if (method === 'GET') {
        return ok(200, [...repo.labels.values()].map((l) => ({ id: l.id, node_id: encodeId('Label', repo.id, l.id), name: l.name, color: l.color, description: l.description, default: false, url: '' })));
      }
      if (method === 'POST') {
        const name = str(body?.name);
        if (!name) return err(422, 'name is required');
        if (repo.labels.has(name)) return err(422, 'Label already exists');
        const label = { id: repo.nextLabelId, name, color: str(body?.color) || 'ffffff', description: str(body?.description) };
        repo.nextLabelId += 1;
        repo.labels.set(name, label);
        return ok(201, { id: label.id, node_id: encodeId('Label', repo.id, label.id), name: label.name, color: label.color, description: label.description, default: false, url: '' });
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = repo.issues.slice();
          if (state !== 'all') list = list.filter((i) => i.state === state);
          list.sort((a, b) => {
            const cmp = sort === 'created' ? a.number - b.number : a.number - b.number;
            return direction === 'asc' ? cmp : -cmp;
          });
          const { page, headers } = paginate(list.map((i) => issueView(store, repo, i)), query, ctx.path, ctx.baseUrl);
          return ok(200, page, headers);
        }
        if (method === 'POST') {
          const title = str(body?.title);
          if (!title) return err(422, 'title is required');
          const made = createIssueRecord(store, repo, title, str(body?.body), labelNamesOf(body));
          if (!made.issue) return err(422, made.error as string);
          return ok(201, issueView(store, repo, made.issue));
        }
        return err(404, 'Not Found');
      }
      const issueNumber = num(rest[1]);
      const issue = repo.issuesByNumber.get(issueNumber);
      if (rest.length === 2) {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, issueView(store, repo, issue));
        if (method === 'PATCH') {
          if (body && typeof body.title === 'string') issue.title = body.title;
          if (body && typeof body.body === 'string') issue.body = body.body;
          if (body && typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          issue.updatedAt = FIXED_TS;
          return ok(200, issueView(store, repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') {
          const list = (repo.comments.get(issueNumber) ?? []).map((c) => commentView(store, repo, issueNumber, c));
          return ok(200, list);
        }
        if (method === 'POST') {
          const comment = addCommentRecord(store, repo, issueNumber, str(body?.body));
          if (!comment) return err(404, 'Not Found');
          return ok(201, commentView(store, repo, issueNumber, comment));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'branches') {
      if (method === 'GET') {
        const list = [...repo.refs.entries()]
          .filter(([name]) => name.startsWith('refs/heads/'))
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha, url: ctx.baseUrl + '/api/v3/repos/' + seg[1] + '/' + seg[2] + '/commits/' + sha }, protected: false }));
        return ok(200, list);
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        const ref = query.get('sha') ?? repo.defaultBranch;
        let tip = repo.refs.get('refs/heads/' + ref) ?? repo.refs.get(ref) ?? null;
        if (!tip && getObject(repo, ref)?.type === 'commit') tip = ref;
        if (!tip) return err(404, 'Not Found');
        const out: unknown[] = [];
        const seen = new Set<string>();
        let current: string | null = tip;
        while (current && !seen.has(current)) {
          seen.add(current);
          const parsed = parseCommit(repo, current);
          if (!parsed) break;
          out.push({
            sha: current,
            node_id: encodeId('Commit', current),
            commit: {
              author: { name: 'forge', email: 'forge@example.invalid', date: FIXED_TS },
              committer: { name: 'forge', email: 'forge@example.invalid', date: FIXED_TS },
              message: parsed.message.replace(/\n+$/, ''),
              tree: { sha: parsed.tree },
            },
            author: { login: store.ownerLogin ?? '', id: 1, type: 'User' },
            committer: { login: store.ownerLogin ?? '', id: 1, type: 'User' },
            parents: parsed.parents.map((p) => ({ sha: p })),
            url: ctx.baseUrl + '/api/v3/repos/' + seg[1] + '/' + seg[2] + '/commits/' + current,
          });
          current = parsed.parents[0] ?? null;
        }
        const { page } = paginate(out, query, ctx.path, ctx.baseUrl);
        return ok(200, page);
      }
      if (rest.length === 2 && method === 'GET') {
        const parsed = parseCommit(repo, rest[1]);
        if (!parsed) return err(404, 'Not Found');
        return ok(200, {
          sha: rest[1],
          node_id: encodeId('Commit', rest[1]),
          commit: {
            author: { name: 'forge', email: 'forge@example.invalid', date: FIXED_TS },
            committer: { name: 'forge', email: 'forge@example.invalid', date: FIXED_TS },
            message: parsed.message.replace(/\n+$/, ''),
            tree: { sha: parsed.tree },
          },
          parents: parsed.parents.map((p) => ({ sha: p })),
        });
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'git') {
      if (rest[1] === 'refs') {
        if (rest.length === 2) {
          if (method === 'GET') {
            const list = [...repo.refs.entries()]
              .sort((a, b) => (a[0] < b[0] ? -1 : 1))
              .map(([name, sha]) => ({ ref: name, node_id: encodeId('Ref', name), url: ctx.baseUrl + '/api/v3/repos/' + seg[1] + '/' + seg[2] + '/git/refs/' + name.slice(5), object: { sha, type: 'commit', url: ctx.baseUrl + '/api/v3/repos/' + seg[1] + '/' + seg[2] + '/git/commits/' + sha } }));
            return ok(200, list);
          }
          if (method === 'POST') {
            const ref = str(body?.ref);
            const sha = str(body?.sha);
            if (!ref || !sha) return err(422, 'ref and sha are required');
            if (repo.refs.has(ref)) return err(422, 'Reference already exists');
            const rec = getObject(repo, sha);
            if (!rec || rec.type !== 'commit') return err(422, 'Invalid sha');
            repo.refs.set(ref, sha);
            repo.refVersion += 1;
            return ok(201, { ref, node_id: encodeId('Ref', ref), url: ctx.baseUrl + '/api/v3/repos/' + seg[1] + '/' + seg[2] + '/git/refs/' + ref.slice(5), object: { sha, type: 'commit', url: ctx.baseUrl + '/api/v3/repos/' + seg[1] + '/' + seg[2] + '/git/commits/' + sha } });
          }
          return err(404, 'Not Found');
        }
        if (rest.length >= 3 && method === 'GET') {
          const refName = 'refs/' + rest.slice(2).join('/');
          const sha = repo.refs.get(refName);
          if (!sha) return err(404, 'Not Found');
          return ok(200, { ref: refName, node_id: encodeId('Ref', refName), url: ctx.baseUrl + '/api/v3/repos/' + seg[1] + '/' + seg[2] + '/git/refs/' + refName.slice(5), object: { sha, type: 'commit', url: ctx.baseUrl + '/api/v3/repos/' + seg[1] + '/' + seg[2] + '/git/commits/' + sha } });
        }
        return err(404, 'Not Found');
      }
      if (rest[1] === 'trees' && rest.length === 3 && method === 'GET') {
        const rec = getObject(repo, rest[2]);
        if (!rec || rec.type !== 'tree') return err(404, 'Not Found');
        const flat = flattenTree(repo, rest[2]);
        const tree = [...flat.entries()].map(([path, ent]) => ({ path, mode: ent.mode, type: 'blob', sha: ent.oid, size: getObject(repo, ent.oid)?.data.length ?? 0, url: '' }));
        return ok(200, { sha: rest[2], url: '', tree, truncated: false });
      }
      if (rest[1] === 'commits' && rest.length === 3 && method === 'GET') {
        const parsed = parseCommit(repo, rest[2]);
        if (!parsed) return err(404, 'Not Found');
        return ok(200, { sha: rest[2], tree: { sha: parsed.tree }, parents: parsed.parents.map((p) => ({ sha: p })), message: parsed.message.replace(/\n+$/, '') });
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = repo.pulls.slice();
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          list.sort((a, b) => b.number - a.number);
          const { page, headers } = paginate(list.map((p) => pullView(store, repo, p)), query, ctx.path, ctx.baseUrl);
          return ok(200, page, headers);
        }
        if (method === 'POST') {
          const title = str(body?.title);
          const head = str(body?.head);
          const base = str(body?.base);
          if (!title || !head || !base) return err(422, 'title, head and base are required');
          const made = createPullRecord(store, repo, title, head, base, str(body?.body));
          if (!made.pr) return err(422, made.error as string);
          return ok(201, pullView(store, repo, made.pr));
        }
        return err(404, 'Not Found');
      }
      const prNumber = num(rest[1]);
      const pr = repo.pullsByNumber.get(prNumber);
      if (rest.length === 2) {
        if (!pr) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, pullView(store, repo, pr));
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (!pr) return err(404, 'Not Found');
        if (method !== 'GET') return err(404, 'Not Found');
        const files = prFiles(repo, pr).map((f) => ({
          sha: f.newOid ?? f.oldOid ?? '',
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.additions + f.deletions,
          blob_url: '',
          raw_url: '',
          contents_url: '',
          patch: '',
        }));
        return ok(200, files);
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (!pr) return err(404, 'Not Found');
        if (method !== 'PUT') return err(404, 'Not Found');
        const mergeMethod = str(body?.merge_method) || 'squash';
        const result = mergePullRecord(repo, pr, mergeMethod);
        if (result.status !== 200) return err(result.status, result.message);
        return ok(200, { sha: result.sha, merged: true, message: result.message });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
