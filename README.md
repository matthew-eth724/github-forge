# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/matthew-eth724/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/matthew-eth724/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible forge in one Node 22 process: git smart HTTP, REST v3, GraphQL v4 and MCP, with
no dependencies, no git binary and no clock. It is an entry in make.fun's
[Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01) bounty.

## What it serves

One HTTP server, five surfaces, all over one in-memory store:

- **git smart HTTP** at `/{owner}/{repo}.git` — `info/refs` advertisements for protocol v2 and v0,
  `git-upload-pack` (`ls-refs`, `fetch`, shallow depths, partial-clone filters, sideband packfile) and
  `git-receive-pack` (`report-status`/`report-status-v2`, `delete-refs`, `side-band-64k`). The pack
  format, delta resolution, tree and commit parsing, and object hashing are implemented here on
  `node:zlib` and `node:crypto`; nothing shells out to git.
- **REST v3** under `/api/v3` — repositories, branches, commits, git data, contents (with
  compare-and-swap `sha`), labels, issues, comments, pull requests, pull files and merges, with
  GitHub's status codes, JSON shapes, `Link` pagination and `X-OAuth-Scopes`.
- **GraphQL v4** at `/api/graphql` — a parser and executor for the documents gh and github-mcp-server
  send: `viewer`, `repository`, `__type` introspection, issue and pull-request connections with
  cursors, global ids, and the create/close/merge/comment mutations.
- **MCP** at `/mcp` — streamable HTTP in both protocol eras: the 2026-07-28 revision
  (`server/discover`, per-request revision, no session) and the handshake revisions before it
  (`initialize`, `notifications/initialized`, `Mcp-Session-Id`). Eight tools, each a thin shell over
  the same store, so a repository or issue created over MCP reads back over REST.
- **`/healthz`** — `{"ok": true}`.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

`main.ts` is the lifecycle: bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register {"port": N}`,
poll `/done`, exit 0. The server itself is built by `app.ts` and binds nothing until `main.ts` listens.

## Layout

| file | what it holds |
| --- | --- |
| `main.ts` | the entry ↔ env lifecycle (bind, register, poll, exit) |
| `app.ts` | the router: `/healthz`, git smart HTTP, `/api/v3`, `/api/graphql`, `/mcp` |
| `githttp.ts` | the two advertisements and the two services, v2 and v0 |
| `gitobjects.ts` | loose objects, trees, commits, tags, packs, deltas, SHA-1 |
| `pktline.ts` | pkt-line framing |
| `store.ts` | repositories, refs, commits, issues, comments, pull requests |
| `rest.ts` | GitHub REST v3 |
| `graphql.ts` | a GraphQL parser, executor and the schema surface |
| `mcp.ts` | JSON-RPC over streamable HTTP and the tool catalogue |
| `util.ts` | HTTP, base64 and timestamp helpers |

## No clock, no randomness

Every timestamp the forge generates comes from a fixed epoch (`1_735_689_600`) plus arithmetic
(`isoSeconds`, a civil-from-days conversion) and a monotonic counter, so the same requests produce the
same bytes. Nothing reads `Date`, a timer, or `Math.random`, which is what makes the conformance run
replay byte for byte.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
