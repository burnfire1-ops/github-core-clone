# forge — a standalone GitHub-compatible git forge

One process, no dependencies beyond the Node 22 standard library, no git
binary, no outside service. It serves from its own in-memory store:

- git smart HTTP at `/{owner}/{repo}.git` — upload-pack protocol v2 and v0,
  receive-pack v0, with its own object store (zlib), packfile read (with
  delta application) and write (full objects)
- the REST v3 API under `/api/v3` — repositories, contents, labels, issues,
  comments, branches, commits, git refs, pull requests and squash merges
- GraphQL at `/api/graphql` — repository/issue/pull-request queries, the
  create/close/merge mutations, batch bodies and `__type`/`__schema`
  introspection
- MCP at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28,
  with `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request` and `merge_pull_request` tools acting on the same
  store as REST

## Running

```
node main.ts
```

The process needs `MAKEFUN_ENV_URL` (the trial environment base URL) and
`MAKEFUN_SHOP_TOKEN` (the bearer token it accepts). It binds an ephemeral
port, registers it with `POST $MAKEFUN_ENV_URL/register`, serves, and polls
`GET $MAKEFUN_ENV_URL/done` until the suite is finished, then exits 0.
Without `MAKEFUN_ENV_URL` it exits 1 at once. It never binds port 8080.

## Layout

- `main.ts` — entrypoint and trial lifecycle (bind, register, poll, exit)
- `app.ts` — HTTP server and routing, auth, JSON envelope
- `store.ts` — in-memory store: repos, git objects, trees, commits, issues,
  pull requests, labels, three-way merge and squash merge
- `git.ts` — pkt-line framing, packfile read/write, upload-pack v0/v2 and
  receive-pack v0
- `rest.ts` — REST v3 handlers
- `graphql.ts` — GraphQL parser and executor
- `mcp.ts` — MCP tools

## Verifying locally

The local test client (kept next to the repo, not part of the entry) boots
the forge against a fake trial environment and exercises REST, git,
GraphQL, MCP and the four workloads at small scale — 119 checks in total:

```
node ../test-client.mjs
```

## Notes

- All state is in memory; nothing is synced to disk on the request path.
- Times in stored state are deterministic (a fixed base plus a counter), so
  two runs over the same operations leave the same state.
- Every push must fast-forward; a non-fast-forward ref is refused per ref
  with `ng <ref> non-fast-forward` and the ref does not move.
- A repository is created through REST; a push cannot invent one. A
  repository belongs to the login the bearer token names; the same name
  under another owner is 404, never 403.
