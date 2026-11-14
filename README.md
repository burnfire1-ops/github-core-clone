# forge — a standalone GitHub-compatible git forge

One process, Node 22 standard library only, that serves git smart HTTP
(protocol v2 and v0), the REST v3 API, GraphQL and MCP from its own
in-memory store. No UI, no git binary, no outside service.

## Run

The trial harness runs `node main.ts`. The program binds an ephemeral port
of its own, registers it with the env at `$MAKEFUN_ENV_URL`, serves until the
env answers `{"done": true}` on `/done`, then exits 0. It never binds 8080.
`$MAKEFUN_SHOP_TOKEN` is the bearer token every API request must carry.

## Layout

- `main.ts` — entrypoint and env lifecycle (bind, register, poll done, exit).
- `app.ts` — the HTTP server: routing, auth, JSON body parsing, request ids.
- `store.ts` — the in-memory store: git objects, repos, refs, issues, pulls.
- `git.ts` — git plumbing: objects, packfiles, pkt-line framing, smart HTTP
  (upload-pack v2/v0, receive-pack v0), shallow/deepen support.
- `rest.ts` — the GitHub REST v3 API under `/api/v3`.
- `graphql.ts` — the GraphQL API at `/api/graphql` (parser, validator,
  executor, introspection).
- `mcp.ts` — the MCP endpoint at `/mcp` (JSON-RPC 2.0, Streamable HTTP).

## Notes

- Repositories are created through REST; a push cannot invent one.
- Every push must fast-forward; a non-fast-forward update is refused per ref
  with `ng <ref> non-fast-forward` and the ref does not move.
- State is deterministic: timestamps the forge itself invents are fixed, so
  two runs on the same input leave the same state. The same holds for the
  commit objects the forge creates for REST content writes: they carry a
  fixed author timestamp, so their ids are reproducible too.
- The forge is single-tenant: the owner login is learned from the first
  repo-scoped request that names an existing repository, and a different
  owner asking for the same repository name gets a 404, never a 403.
