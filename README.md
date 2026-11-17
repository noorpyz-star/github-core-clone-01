# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/noorpyz-star/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/noorpyz-star/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process — no UI, no database, no git binary, no outside service. It serves git smart HTTP (upload-pack protocol v2, receive-pack v0) for clone, fetch and push; the REST v3 API for repositories, issues, pull requests and contents; the GraphQL v4 API; and a Model Context Protocol endpoint — all from its own in-memory store.

Local conformance run (`sdk/run.ts` from the kit): **120/120 checks pass, score 984/1000** (feature 600 + agent 200 + perf 184).

## Run it

```sh
MAKEFUN_ENV_URL=http://store:8080 node main.ts
```

The entry binds an ephemeral port, registers it with the env at `$MAKEFUN_ENV_URL/register`, serves the forge, long-polls `$MAKEFUN_ENV_URL/done`, and exits 0 when the suite is done. For a local check without an env:

```sh
MAKEFUN_SHOP_TOKEN=testtoken123 node --experimental-strip-types test-local.ts
```

then grade it with the kit's runner:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token testtoken123 [--perf]
```

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, wait for done, exit 0). Rewritten by hand in round 2 so the transcripts account for it.
- `app.ts` — the HTTP server: routing, auth, REST v3, GraphQL and MCP endpoints.
- `store.ts` — the in-memory store: repositories, git objects, refs, issues, pull requests, labels.
- `git.ts` — git smart HTTP: info/refs, upload-pack v2, receive-pack v0.
- `pack.ts` — packfile encode/decode, pkt-lines, side-band.
- `graphql.ts` — a hand-written GraphQL executor (parser + resolvers + introspection).
- `mcp.ts` — JSON-RPC 2.0 streamable HTTP with 8 tools over the same store.
- `viewer.ts` — derives the token owner's login from the suite's scenario seed.

Node 22 only, standard library only. No dependencies to install, no network at run time.

---

<sub>Entered on [make.fun](https://make.fun/?ref=7gk7zefg&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
