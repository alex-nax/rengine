# The JS host stops serving what red-host owns (2026-09-14)

F189, spec 129, KI-102/KI-106. With every host door-fronted, `main.mjs`'s store routes, session
routes, `/api/state`, the desktop routes and the `/events` socket were dead in every path. This
deletes them.

## What went

Eighteen route cases, the `/events` upgrade, the socket server, the session-event fan-out and the
`Desktops` the host kept for it. `main.mjs` is 239 lines and serves **fifteen** `/api/*` cases — the
ones F153–F156 own — plus the `/surface` upgrade, which is `games.mjs`'s frame transport and moves
with games.

**red-host is now required.** A checkout that has not built it cannot serve a workspace: the host
says so by name and exits 3, rather than publishing a descriptor for something that answers
`/health` and little else. That is a real narrowing and it is what the row's third criterion means —
the JS host is the backend of the routes that have not moved, not a workspace of its own.

## Keeping the comparison after deleting the counterpart

`red-host.test.mjs` compared the door against the JS host **over HTTP**, which is not available for a
route the JS host no longer serves. AGENTS.md's rule for this is to capture the counterpart's answers
before they go, and the capture here is the implementation rather than a fixture: every comparison
moved one layer down, to the code the deleted route called —

- `store.list`, `store.readText`, `store.preferences` for the store routes;
- `sessions.terminal`, `sessions.snapshot`, `sessions.list`, `sessions.input` for the session routes;
- a `composed()` helper carrying `/api/state`'s exact composition, through `JSON.stringify` because
  that is what the route did — a field the host left undefined was a field its answer did not carry;
- `new Desktops(store, sessions)` driven with a socket that records what it is sent, for the
  registration frame and the listing.

The comparisons are the same comparisons; what changed is that they no longer travel through a route
that has gone. They keep working when the JS modules themselves are deleted, because each one names
the function that produced the answer.

## What the migration found, before it was allowed to pass

**A conversation's task was wiped by the pane's own report.** A conversation is reported more than
once: the workspace names it when it spawns a pane *on a task*, and then the pane reports what it
actually launched, knowing nothing about tasks. The store reads an explicit `null` task as "forget
it" — so the door, which sent `null` for an absent field, erased the task every time a pane reported
in. The JS host never did: `undefined` does not survive `JSON.stringify`, so its call carried no
`task` key at all. Absence and null are different answers, and this is the second time today that
distinction was the bug.

**A door could not answer about a pane it had just started.** The pane cache is fed by the service's
announcements, which arrive on another thread; the worker's next call after a spawn is
`agent-conversation` on that pane, and it beat the announcement. A door now records the pane it
started at the moment it starts it.

## Gates

`npm test` — **326 of 326**. `cargo test` — all crates. Native: `native-front-door`, `native`,
`native-sessions`, `native-cooperative`.

## What this does not claim

- **The line count did not fall.** 6,805 → 6,845: `main.mjs` lost 56 lines and the cutover machinery
  cost about as much. The JS that remains on the path is the fifteen routes' modules (formats,
  tracker, dashboard, devices, games, images, recordings, tasks) and the runtime layer above the
  host — F153–F156 and F157–F162. This commit moves the *boundary*, not the total.
- **F189 and F152 stay open.** F152 depends on F150, whose last criterion is the owner's live-pane
  run (F186).
