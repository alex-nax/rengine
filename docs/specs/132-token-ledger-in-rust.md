# 132 — The project token ledger and its feed, in Rust (F157)

Status: designed, not implemented. Written 2026-09-14 after porting `formats.mjs` and
`recordings.mjs`, when the next module turned out to need a different shape.

## Why this row is not a thin client

`images.mjs`, `recordings.mjs` and `readDeclaration` moved with the pattern `store-client.mjs`,
`pty-client.mjs` and `agents-client.mjs` established: the implementation becomes Rust, the module's
API stays, and every caller — including `runtime/worker.mjs`, which serves these capabilities from
its own checkout under spec 065's layering — is untouched. Each of those is a question with an
answer: read this project, list these recordings.

The token ledger is not. Three things make it stateful in a way a one-shot binary cannot serve:

1. **The feed keeps its frames in memory.** `Feed` holds `frames` and `sequence` and rewrites the
   whole ring on every emit. A second writer in another process would not see the in-memory tail and
   would hand a monitor a sequence it had already seen — which is the one thing
   `runtime/feed.mjs`'s own comment says must never happen.
2. **The worker emits frames that are not the ledger's.** `note()` reaches through
   `tokens.ledger(rootId).frame(...)` for `task.added`, `agent.spawned`, `capture.committed` and the
   rest, so the ring has two producers already and they are one process today.
3. **Watchers are pushes, not polls.** `ledger.watch()` feeds the desktop's status segment and the
   `/feed` socket; a desktop learns a contest resolved without asking.

So F157 is a **service**, the shape `red-store` and `red-pty` already take, not a binary a client
runs per call.

## What the service is

`red-token-serve`, one per state directory, discovered through a `token.json` descriptor with the
loopback-plus-token discipline `red_core::service` provides (charter D60's machinery, already shared
by two services). It owns:

- the per-root ledgers under `<state>/tokens/<rootId>/token.json`, and the workspace preferences
  (`tokenWindowMs`, `generation`) beside them;
- the per-root feed ring (`feed.json`), with `emit`, `after(cursor)` and the frame-type allowlist;
- the deadline timers — which remain, as the JS says, **an optimisation**: every call settles first,
  so a service restarted mid-contest still resolves at the original wall time from the file alone;
- the pushes: a status for every watcher and a frame for every feed subscriber, over the
  service's existing emitter.

`orchestrator/runtime/token-client.mjs` keeps `Tokens`, `Ledger`, `UUID`, `readIdentity`,
`readDesktop` and `segmentFrame` exactly as `token.mjs` exports them today, so `worker.mjs` and the
specs that import them do not change.

## Determinism, and what has to move first

The ledger mints ids with `randomUUID()` and reads the clock with `new Date()` directly. Two
implementations cannot be compared while either does that, so — before the port —
**the mint and the clock travel as data**, the way `agent_pane_composition` already takes them
(F148: "a pane's plan is a function of its inputs and a test never depends on a draw"). The defaults
keep today's behaviour exactly; the seam exists so a transcript can be recorded.

Then the record: a **transcript**, not a set of independent answers. The ledger is a state machine,
so the corpus is a sequence — contest a free token, contest it again from another agent, reject,
contest under cooldown, let a deadline pass, release under an open contest, assign from the desktop,
revoke, retire — and the record is each step's answer, the status after it, and the frames it wrote.
`docs/evidence/` gets it the way `declaration-fixtures.json` was got: recorded from the JavaScript
while the JavaScript still exists.

## Why this is the row that matters next

Every remaining `orchestrator/server/*` module is kept alive by `worker.mjs` (KI-107), and the
worker cannot move until the ledger and the feed it reaches through have (F158 depends on F157).
After it, `main.mjs`, `sessions-client.mjs`, `store-client.mjs` and `pty-client.mjs` — 1,250 lines —
go together, because nothing else imports them.

## What this row must not do

Get the arbitration subtly wrong. This ledger is what stops two agents writing over each other's
work: a refusal whose wording changed, a cooldown charged to the wrong contest, a deadline that
re-times when a preference changes, or a holder that reads as gone because liveness followed the
process rather than the session (spec 095, Identity) are each a silent correctness bug in the one
mechanism the workspace has for keeping agents out of each other's way. That is why the transcript
comes first and why every refusal in it is compared word for word.
