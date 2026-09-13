# F189 — the workspace a launcher starts is answered by red-host (2026-09-13)

Spec 129, F152b. Every route F152 names moved into the door earlier today. This is the commit that
made a workspace **run** it.

## What was actually true before this

red-host existed, was complete for F152's scope, and was started by nothing except tests.
`ensureSidecar` spawned `node orchestrator/server/main.mjs --state DIR`, that process wrote
`sidecar.json`, and every client — the native desktop, the root-bound worker, the MCP, `launch.mjs`
— talked to the JS host exactly as before. A row can move nine routes, a socket and a registry into
Rust and change nothing about what a person is running, and that is what had happened.

`npm test` was green through all of it, because the suite starts hosts in process and drives them
directly. Nothing in it asks *what a workspace runs*.

## The cutover

The process a launcher starts now starts the door in front of itself:

- `main.mjs`'s CLI path brings up the JS host as before, then spawns
  `red-host --state DIR --backend <its url> --backend-token <its token> --pid <its own pid>`;
- the door publishes `sidecar.json` — its url, its token, its instance — and **this process's pid**,
  because the pair is the workspace and that is the process the launcher started, `replace.mjs`
  stops and `discoverSidecar` asks about;
- the door dies with the host it fronts. On unix an orphan's parent becomes pid 1 and that is the
  signal. A door left behind would answer `/health` and every route it owns for a backend that is
  gone, which reads as a healthy workspace to everything that asks.
- a checkout with no red-host built still starts, from the JS host alone, and says so in its log. A
  workspace that refused to come up because a binary was missing would be a worse answer.

## The check, and why it did not exist

`orchestrator/tests/front-door-cutover.test.mjs` starts a workspace the way `launch.mjs`, the
desktop and the MCP start one, and asks what is answering: the descriptor names a live process, the
process ANSWERING is a different one, that one is the single `red-host --state <dir>` in the process
table, and the JS host is still behind it. Then a route the door owns and a route it forwards are
both driven through the one port a client knows about, and the host is killed to prove the door goes
with it. The second test does the same with `RENGINE_RED_HOST` naming nothing, and gets one process
answering everything.

This spec exists because the change had none. Removing the cutover entirely — `const door = null` —
left **23 tests across four host-starting specs green**, which is the same shape as the two defects
`docs/evidence/blind-regressions-2026-09-06.md` records: a check nobody could break is a check
nobody was making.

| Sabotage | Observed |
| --- | --- |
| the launcher's workspace is the JS host alone | `the process answering is not the process the launcher started` |
| the door outlives the host it fronts | `the door stops with the host it fronts` — a door still serving a killed workspace |

## Gates

`npm test` — **326 of 326**. `cargo test` — all crates. The native `native-front-door` spec, plus
`native-bootstrap` and `native-updates`, which start real hosts.

## What this does not claim

- **No JavaScript is deleted by this**, and none can be yet: thirteen routes are still forwarded to
  `main.mjs` (KI-102) and 71 spec files still start the JS host directly (KI-106). What changed is
  that the Rust host is now on the path a person runs rather than one a test builds.
- **F189 and F152 stay open.** F152 depends on F150, whose last criterion is the owner's live-pane
  run (F186).
- The orphan rule is unix-only, like every other process rule in this repository's host layer.
