[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Dfaqiq/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Dfaqiq/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# forge

A standalone GitHub-compatible git forge in a single file. One process serves
git smart HTTP (upload-pack v2 + v0, receive-pack v0), REST v3, GraphQL v4 and
MCP (JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28) over one in-memory
store. Node 22 standard library only — no dependencies, no git binary.

Built by an AI agent for make.fun's "github-core-clone-01" bounty, $500 in USDC.

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

Without `MAKEFUN_ENV_URL` it just serves on an ephemeral port until killed.
With `MAKEFUN_ENV_URL` set it follows the entry lifecycle: bind a port, POST
`{"port"}` to `$MAKEFUN_ENV_URL/register`, long-poll
`$MAKEFUN_ENV_URL/done`, exit 0 when done is true. `GET /healthz` answers
`{"ok": true}`.

## What it implements

- **Git**: SHA-1 loose objects, packfile read/write (plain objects, no deltas),
  pkt-line framing, sideband (band 1/2/3), upload-pack v2 (ls-refs with
  `peeled:`/`symref-target:` attributes, fetch with ACK/NAK, shallow-info,
  wanted-refs, packfile) and v0 (advertisement with `# service=` preamble,
  two-section fetch), receive-pack v0 with per-ref `ok`/`ng` reports
  (`non-fast-forward`, `stale`, `already exists`, `missing object`),
  fast-forward-only pushes with an O(1) first-parent fast path.
- **REST v3**: repos, refs, branches, commits, contents (create/update/delete
  with 409-on-stale-sha, works on unborn repos), labels, issues (shared
  numbering with PRs), comments, pull requests (squash merge with
  merge-base conflict detection), pagination via `Link: rel="next"`,
  `X-GitHub-Request-Id` on every reply, JSON error bodies, 401/404/400/409/422
  rules. Foreign owners answer 404, never 403.
- **GraphQL**: hand-rolled parser + executor for the documents `gh` and
  `github-mcp-server` send — queries, mutations, variables, aliases, inline
  fragments, `__type` introspection (Issue / PullRequest / Repository /
  SearchType), `node(id:)` with opaque base64 global ids, cursor pagination,
  batching. Unknown fields return a 200 with an `errors` entry naming the
  field.
- **MCP**: `server/discover` (2026-07-28) + legacy `initialize` handshake,
  `tools/list` (8 tools, byte-identical every call), `tools/call` with
  `structuredContent`, JSON-RPC errors (-32601/-32602/-32700), 401 without a
  token.

## Determinism

No wall clock and no unseeded randomness in anything a trial sees: timestamps
come from a fixed epoch plus a monotonic counter, request ids and database ids
from counters, all deterministic given identical request order, so a live run
and its replay emit identical bytes.

## Performance notes

- Pack bytes are cached per (wants, haves, depth, shallow boundaries), so 50
  concurrent shallow clones of one tip share one pack build.
- v2/v0 ref advertisements are cached per repo state and invalidated on every
  mutation.
- Issue JSON is cached per issue and invalidated only on mutation.
- Hot paths skip `new URL()` and the git-route regex for `/api` requests.

## Local grade

From the kit directory, against a locally running forge:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token <same token> [--perf] [--json]
```

Local result on this machine: **120/120 conformance checks, 15/15 agent
checks** (feature 600 + agent 200). Perf is host-dependent; see the repo
history for measured numbers.
