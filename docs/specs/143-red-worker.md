# Spec 143 — red-worker: what the root-bound worker actually is

Owner goal, 2026-09-15: *"finish remaining js"* (charter D57, spec 129; F158).

Status: **in progress — 8 of 13 routes answered** (the registry's two went to the door), plus the front door and the feed's core and fan-out.

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
| `POST /api/task` | — | **done**; the tracker is read back **through the door**, which answers a local one itself and forwards a remote one, so the worker needs none of its own |
| `POST /api/agent-spawn` | — | **done** |
| `POST /api/script-open` | — | **done** |
| `GET /api/diagnostics`<br>`POST /api/ide-mention`<br>`POST /api/ide-selection` | **the IDE bridge**: the worker spawns one `red-ide serve` per bridge and answers `getDiagnostics` back down the pipe, because the language servers are the worker's (spec 133 D3) | infrastructure |
| `POST /api/session-view`<br>`GET /api/runtime-desktops` | ~~the desktop registry~~ — **the door's** (below) | **done, and not here** |
| `POST /api/update-workspace` | — | **done** |
| `POST /api/tracker/signin`<br>`POST /api/tracker/signout` | **a TLS decision** — rustls, hyper and hyper-util are already linked through libp2p, but the workspace has no root-certificate store | F154 |
| the `/feed` socket | the fan-out, which exists; the socket, which does not | **next** |

The four that landed together are one shape, and it is worth naming because the next ones are it
too: **resolve the project, ask the gate, do the work, tell the feed.** The gate is
`red_token`'s `gate` call — settle, note the caller, ask for the refusal, persist, in one round trip
rather than four — and a request with no agent header passes it, because the header is arbitration
among cooperating agents and the person at a desktop is never gated. A worker with no ledger also
passes, for the same reason an unidentified caller does: there is nothing to be refused *by*.

Two things are deliberately not the worker's:

- **The tracker read.** `POST /api/task` answers with the tracker as the write left it, and asks the
  door for it. The door answers a local tracker itself and forwards a remote one, so nothing here
  waits on F154's TLS decision.
- **Showing the pane.** `script-open` and `agent-spawn` both end by showing what they started, and
  that is the door's `/api/session-view` (above). A failure to show is REPORTED, never retried: the
  pane is already running and retained, so a caller that tried again would start a second one, and
  the answer says so in words.

Every route's work runs on `spawn_blocking`. A CLI's `--help`, a call to the door and a project's
own write command all block, and a runtime whose workers were all inside one would stop accepting
the connection that was waiting to be told so.

## The answer: the registry is the door's

Asked before the work, and the answer was already shipped: **`red-host` has held the registry since
F189.** It serves `/events`, and a desktop says it exists by sending a frame on that socket, so the
door is the only process that can know about one. There was never a second registry to build — only
two routes over the one that exists.

So the registry is the door's, and with it:

| route | was | is |
|---|---|---|
| `POST /api/session-view` | the worker's second registry | **the door's** — `answer_session_view` |
| `GET /api/runtime-desktops` | the worker's second registry | **the door's** — `Desktops::registry` |
| `POST /api/update-workspace` | listed here as the registry's | **the worker's** — it never touched the registry; it is the token GATE and a forward, and the table above had it in the wrong row |

Two things followed from actually doing it, and both were latent gaps rather than new work:

- **`act` carried no payload.** A reload needs none — the desktop knows how to rebuild itself — so
  the one that shipped took only an action name. An attach is nothing without the session: a desktop
  told only an id would have to ask for the record back, and the one thing it must not do between
  being asked and answering is make another round trip.
- **A refusal was not remembered.** Spec 098's launcher waits for a window and has to name the
  reason one never appeared. The JS worker kept that beside its registry; the door now does, cleared
  by the next registration that succeeds, because a stale reason is worse than none.

What this buys beyond two routes: the JS worker's registry existed so it could push the pinned token
segment to a desktop over a socket it owned, and that is the whole reason spec 095's retirement has
a **relay** — a retired worker following the current worker's feed to push frames to desktops it
still holds. With the registry at the door, the desktops never belonged to a worker in the first
place, and a worker being replaced is not something a desktop can notice. That machinery retires
with `worker.mjs` rather than being ported.

Evidence: `orchestrator/tests/red-host.test.mjs`, in the F189 registry test — the two routes
against the JS `Desktops` while it is still the record of what the answers are. Three sabotages,
each rebuilt before its run (KI-120): an attach frame with no session record, the pane's root read
from the caller's claim instead of the record, and a refusal that is never cleared.
