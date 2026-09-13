# Every host is door-fronted, and what that found (2026-09-14)

F189, spec 129, KI-106. The cutover put red-host in front of the workspace a *launcher* starts. This
puts it in front of the one a *spec* starts, which is the same change to `startServer` — and it is
the step KI-106 said the JS deletions are gated on.

## What changed

- **Every host uses its directory's services.** `retainSessions` used to decide whether a host
  attached to the store and PTY services or opened its own; now it decides only what happens at
  SHUTDOWN — a host being replaced leaves its panes, a host closing for good ends them. The services
  are always the directory's, because red-host and the JS host serve one workspace together.
- **A service stops when its state directory does.** That is what makes the above safe for a suite:
  a test deletes its scratch directory, and a service holding a shell for a workspace that no longer
  exists is holding it for nobody. This is the leak that produced 91 stray processes once already,
  fixed in the reaper rather than audited for in fifty specs. `ENOENT` specifically — a directory
  that cannot be READ is not a directory that is gone.
- **`startServer` starts a door** and returns its url, token and instance; the JS host's own endpoint
  stays available as `backend` for the three specs that manage a door themselves (`frontDoor: false`).
- **A host registers panes it did not start.** The service announces every session it holds (D62), so
  `adopt()` continues past startup. Without this, a host behind the door answers `Unknown session.`
  about a pane running in front of the person — which is what ten specs said when the door started
  spawning.

## What it found

Two defects in the door, both of which were **in production** as of the cutover commit:

- **The door never closed a connection it answered.** `red_core::http` — which is how red-mcp,
  red-link and every other Rust client talks to a workspace — asks in HTTP/1.0 with
  `Connection: close` and reads to end of stream. The door answered correctly and held the socket,
  so every such client waited out its fifteen-second read timeout and reported
  `no answer from 127.0.0.1:PORT for /api/state: Resource temporarily unavailable`. Nothing caught
  it because nothing pointed a Rust client at the door until the whole suite did.
- **`/api/terminal` accepted `type: "game"`.** The JS route refuses the word before the composition
  ever sees it — `/api/game` composes a game from the project's declaration and the surface it
  reserves — and a pane that called itself a game would have been a game session with no game behind
  it. The port had carried `spawnTerminal`'s type check and missed the route's.

| Sabotage | Observed |
| --- | --- |
| the door never closes a connection it answered | `red-mcp did not start: no answer from 127.0.0.1:51625 for /api/state: Resource temporarily unavailable` |
| a host does not learn of panes it did not start | two specs red: the extended routes and the lifecycle feed, both on `Unknown session.` |
| `/api/terminal` accepts a game | `Missing expected rejection` in the games suite, where `/game` is the only way to launch one |

The HTTP/1.0 half of the close rule — a 1.0 client that does not say `close` still gets its
connection ended — is covered by a unit test rather than end to end, because every Rust client in
this workspace says `close` explicitly. Recorded rather than claimed as proven.

## Gates

`npm test` — **326 of 326**, zero services left behind. `cargo test` — all crates. The native
`native-front-door`, `native` and `native-sessions` specs.

## What this unlocks

`main.mjs`'s store routes, session routes, `/api/state`, the desktop routes and the `/events` socket
are now **dead in every path** — production and suite alike. Deleting them is the next commit, and
it is the first JavaScript this epic can actually remove.
