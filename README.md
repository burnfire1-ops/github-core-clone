# forge

A standalone GitHub-compatible git forge in Node 22 (TypeScript, standard
library only). One process serves git smart HTTP (upload-pack protocol v2,
receive-pack v0), the REST v3 API, GraphQL and MCP from a single in-memory
store. No UI, no outside service, no git binary.

## Run

```sh
MAKEFUN_ENV_URL=<env url> MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

The process binds an ephemeral port, registers it with
`$MAKEFUN_ENV_URL/register`, serves until `$MAKEFUN_ENV_URL/done` answers
`{"done": true}`, then exits 0.

## Layout

- `main.ts` — entrypoint and lifecycle (bind, register, poll done, exit)
- `app.ts` — HTTP server and routing across the four surfaces
- `store.ts` — in-memory store: repositories, git objects, trees, commits,
  issues, pull requests, labels and comments
- `git.ts` — pkt-line framing, packfile read/write, smart HTTP
- `rest.ts` — REST v3 API under `/api/v3`
- `graphql.ts` — GraphQL API at `/api/graphql`
- `mcp.ts` — Model Context Protocol endpoint at `/mcp`

## Notes

- Git objects are stored uncompressed in memory; pack bytes are deflated
  at write time (level 1).
- All stored timestamps are fixed constants, so two runs over the same
  operations leave identical state.
