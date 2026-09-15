# Spec 143 — red-worker: what the root-bound worker actually is

Owner goal, 2026-09-15: *"finish remaining js"* (charter D57, spec 129; F158).

Status: **in progress — 4 of 15 routes answered, the front door, the feed's core and fan-out, and the script rules.**

## The measurement that shaped this

`runtime/worker.mjs` is 733 lines and reads like the biggest port left. It is not, because it is a
**dispatcher**: it serves 32 `/api/*` routes and **19 of them are already answered by `red-host`**.
They reach it by being forwarded. Of the 13 that are its own — 15, once the two `/api/tracker/*`
paths a slash-blind survey missed are counted — five sit on `red-token` and `red-ide`, crates that
exist. The feed itself has been `red_token::feed` since F157.

So this is a server around work that is already done.

## What makes it safe to port a route at a time

`serve::own_route` is the **contract**: the routes that are the worker's, checked against
`worker.mjs` by reading it. `serve::implemented` is **how far the port has got**. A route moves
between them when its evidence lands, and until then it is forwarded — so a half-ported worker
behaves exactly like the whole one, and the JS worker can be deleted on the day the two tables meet
rather than on the day a single enormous commit is reviewed.

## The routes, and what each still needs

| route | needs | state |
|---|---|---|
| `GET /api/feed` | the ledger service | **done** |
| `GET /api/token` | the ledger service | **done** |
| `POST /api/token-action` | the ledger service | **done** |
| `GET /api/agents-menu` | — | **done** |
| `POST /api/task` | the token gate, a per-root serialisation, `red_project::tasks::task_write`, a feed frame, and the tracker read back — **the tracker is F154's** unless the worker asks the door for it, which it may, since it already forwards there | crate exists |
| `POST /api/agent-spawn` | the token gate, `red_agents::spawn`, and the host's own pane spawn | crate exists |
| `POST /api/script-open` | the desktop registry and the host's pane spawn; **its rules are done** — `scripts::script_path` judges the resolved path, `scripts::script_arguments` the bounds | half |
| `GET /api/diagnostics`<br>`POST /api/ide-mention`<br>`POST /api/ide-selection` | **the IDE bridge**: the worker spawns one `red-ide serve` per bridge and answers `getDiagnostics` back down the pipe, because the language servers are the worker's (spec 133 D3) | infrastructure |
| `POST /api/session-view`<br>`GET /api/runtime-desktops`<br>`POST /api/update-workspace` | **the desktop registry**: desktops register over the worker's socket and it holds them | infrastructure |
| `POST /api/tracker/signin`<br>`POST /api/tracker/signout` | **a TLS decision** — rustls, hyper and hyper-util are already linked through libp2p, but the workspace has no root-certificate store | F154 |
| the `/feed` socket | the fan-out, which exists; the socket, which does not | next |

## A question worth asking before the desktop registry is built

Three routes are the worker's only because **it** holds the desktop sockets. `red-host` holds
desktop sockets too — it serves `/events` and owns a `Desktops` registry — and it is the
longer-lived of the two, which is the reason D62 gave for moving a pane's RECORD there.

If desktops registered with the door instead, those three routes would become the door's and the
worker would forward them, the way it forwards nineteen others. That is a smaller worker and one
fewer socket, and it is the kind of change that is cheap now and expensive after the registry is
built twice. It is not this row's to decide alone: it touches D60/D62 and the retirement protocol in
spec 095, where a RETIRED worker forwards a retained desktop's frames to the current one.

**Recorded here so it is asked before the work, not after.**
