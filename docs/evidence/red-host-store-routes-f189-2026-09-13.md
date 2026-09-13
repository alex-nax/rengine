# F189 (F152b), first half — the store routes move into red-host (2026-09-13)

Spec 129, KI-101/KI-103, charter D61. F188 gave the workspace a front door that owns the port and
forwards everything. This is the first set of routes to stop being forwarded.

## Why these routes could move at all

A front door and a backend are two processes. Until D61 they were also two *owners* of the
workspace state: `store.mjs`/red-store kept `state.json` in memory, so a second reader would have
answered from its own copy and written over the first's. Moving a store route into the door would
have been a data-loss bug dressed as a port (KI-103).

D61 answered it: the store is a **service of the state directory**, one process, and every host
attaches. So the door and the JS backend are two readers of one owner — and a route may move.

## What moved

`store_route()` in `red/red-host/src/main.rs` is the whole list, method and path together:

| route | store method |
| --- | --- |
| `GET /api/tree` | `list` |
| `GET /api/file` | `readText` |
| `POST /api/roots` | `addRoot` |
| `POST /api/save` | `saveText` |
| `POST /api/draft` | `putDraft` |
| `POST /api/discard` | `discardDraft` |
| `POST /api/layout` | `saveLayout` |
| `POST /api/preferences` | `preferences` |

Eight of `main.mjs`'s 33 routes. The other twenty-five are still forwarded, unchanged.

Two details are the JS host's rather than the store's, and the port has to carry both:

- **The answer shape.** `discardDraft` and `saveLayout` return nothing at all; `main.mjs` answers
  `{ok: true}` and callers check it. The door does the same.
- **The status on a refusal.** The store's failures carry their own code — 404 for a root that is
  not there, 409 for a save against a version that moved — and a client acts on them. They are
  carried through as the status of the HTTP answer, in the store's own words.

The door **attaches**; it never starts a store service. The processes that run these services belong
to the host that owns the directory, and a door racing to start one would be the second owner the
whole arrangement exists to prevent. With no service to attach to, the store routes are forwarded
and the door says so on stderr.

## The thing a parity test cannot see

`red-host.test.mjs` compares the same live host driven directly and through the door. After D61 it
compares two readers of one store — so **every one of those comparisons passes whether the door
answers the route or forwards it.** A parity suite is the wrong instrument for "where is this
answered", and running it is not evidence that anything moved.

What shows it is taking the backend away. The store is the state directory's own service and
outlives the host attached to it, so with the JS host stopped:

- `GET /api/file` still answers 200 with the file's text — the door owns it;
- `GET /api/dashboard` fails at the socket — the door only forwards it, and there is nothing there.

That pair is the acceptance check for this half of the row.

## Sabotages, each observed failing for its own reason

| Sabotage | Observed |
| --- | --- |
| `/api/file` forwarded after all (`store_route` returns `None` for it) | `TypeError: fetch failed` at red-host.test.mjs:173 — the route the door is supposed to own had nowhere to go once the backend stopped; every earlier assertion still passed, which is the point |
| the `{ok: true}` shape dropped for `discardDraft` | `+ null  - { ok: true }` — the store's own empty answer reaching a caller that checks the field |
| the store's status ignored (every refusal 500) | `a root the store does not have is 404 at the door: 500 !== 404` |
| a POST body not read before the next request (`/api/draft` skipped) | `the backend reads what the door wrote: undefined !== 'a draft from the door'` |

## A leak this row found, in the suite rather than the product

This test retains its sessions at the end, and a retained PTY service never reaps while it holds one
— that is D60's promise, not a bug. `orchestrator/tests/state-services.mjs` exists to end them, and
`headless.test.mjs` records the trap in a comment: **after-hooks run in registration order**, so a
cleanup registered after the directory removal reads a descriptor that is already gone and ends
nothing.

This test had them as two hooks in the wrong order, and `launcher.test.mjs` and `hot-update.test.mjs`
— which also start real sidecars — never ended their services at all. Fifteen manual runs left
fifteen `red-pty-serve` processes holding shells for deleted directories. All three are now one
ordered hook. Verified: a run of `red-host.test.mjs` leaves zero services behind, and a full `npm
test` adds none.

## Gates

`npm test` — **320 of 320**, twice, with zero services left behind. `cargo test` — all crates pass,
including a new `a_route_this_door_does_not_own_is_forwarded` that pins the route table by method as
well as path.

## What this row does not claim

- **F189 is not finished and is not flipped.** The session routes, desktops and surfaces have not
  moved; `main.mjs` is still the backend of twenty-five routes and both sockets. Nothing is deleted.
- **The door holds one store connection behind a mutex**, so its store routes serialise. The JS host
  holds one socket too, so this is the same throughput the workspace has today — but it is a known
  place to look if the door ever becomes a bottleneck.
- **F152 is still blocked on F150 (F186, a live-pane run), and this work is ahead of that
  dependency** for the reason F188's evidence records: the criterion is verification of a capability
  that already exists in the boot path, not a foundation these routes need. This commit is
  self-contained and revertible if the owner would rather the lane waited.
