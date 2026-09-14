# 132 — The project token ledger and its feed, in Rust (F157)

Status: implemented 2026-09-14. Written the same day, after porting `formats.mjs` and
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
`readDesktop` and `segmentFrame` exactly as `token.mjs` exports them today.

**Correction, on implementing it.** This section said `worker.mjs` would not change. It has to, and
the reason is worth writing down rather than working around: the JS ledger's `status`, `refusal`,
`seen`, `frame` and `segment` were SYNCHRONOUS reads of an object in the same process, and a socket
has no synchronous read. The thin-client pattern that carried `store-client`, `pty-client` and
`agents-client` untouched works because those modules' surfaces were already promises. Here nine
call sites in `worker.mjs` gain an `await`, and two of them get better in the process: `gate` and
the token-status answer each become ONE call (`gate`, `callerStatus`) that settles, notes the
caller, asks for the refusal and persists — where four separate calls would also be four moments
another attached host could move the ledger between.

Three things stay in JavaScript in the client because they are neither state nor a question for the
service: `readIdentity`, `readDesktop` and `segmentFrame`. `segmentFrame` in particular is applied
by a RETIRED worker to another worker's status relayed over HTTP, so it cannot live behind this
service. `red-token` holds the same three for the day red-host answers these routes; the JS copies
die with `worker.mjs` (F158).

The workspace preferences are PUSHED rather than polled, and the client keeps a copy, because
`tokens.window()` is read inside a response the worker builds synchronously. The service announces
every change, so a second host that changed it does not leave this one stale.

## Determinism, and what has to move first

The ledger mints ids with `randomUUID()` and reads the clock with `new Date()` directly. Two
implementations cannot be compared while either does that, so — before the port —
**the mint and the clock travel as data**, the way `agent_pane_composition` already takes them
(F148: "a pane's plan is a function of its inputs and a test never depends on a draw"). The defaults
keep today's behaviour exactly; the seam exists so a transcript can be recorded.

### What recording it found

Two bugs in the JS surfaced before any Rust was written, and one gap surfaced when the Rust was
judged:

- **`status()` settles nothing.** The ledger's own comment says settling is "applied before every
  read and every call", but `status()` is a synchronous read; the worker awaits `settle()` before
  every answer. A transcript of `status` alone would have recorded a view no caller ever sees, and
  would have let a replacement skip the settle. Both views are recorded (`rawStatus` and `status`).
- **`status()` handed out the ledger's own cooldown map.** Every other field it returns is already a
  copy — the contest is spread, the identities are `Object.values`, the history is a slice — and
  this one was live. The first Rust run disagreed on four steps, all of them this field, because the
  record had captured forty views of the map as it looked at the END of the run. Fixed in the
  JavaScript (`{ ...this.state.cooldown }`) and re-recorded; the regeneration changed five values
  and nothing else, which is the proof it smuggled nothing in.
- **Two rules had no case.** Sabotaging `settleRejection`'s `cooldown: false` — charging a contester
  for an assign it did not ask for — left the transcript green, because every assign in the script
  met a free token. So did re-timing a running contest from the current preference, because the
  window never changed. Six steps were added and the record regenerated while the JavaScript still
  existed; the first forty steps came back byte-identical.

Then the record: a **transcript**, not a set of independent answers. The ledger is a state machine,
so the corpus is a sequence — contest a free token, contest it again from another agent, reject,
contest under cooldown, let a deadline pass, release under an open contest, assign from the desktop,
revoke, retire — and the record is each step's answer, the status after it, and the frames it wrote.
`docs/evidence/` gets it the way `declaration-fixtures.json` was got: recorded from the JavaScript
while the JavaScript still exists.

And then the recorder goes with the module it recorded. `token-transcript.mjs` keeps the script, the
constants and the frozen answers; its `transcript()` function was deleted in the same commit as
`token.mjs`, because a recorder that replayed the REPLACEMENT would be judging it against itself.
The script and the record are frozen together: a step added now would have no recorded answer to be
right or wrong about.

## Why this is the row that matters next

Every remaining `orchestrator/server/*` module is kept alive by `worker.mjs` (KI-107), and the
worker cannot move until the ledger and the feed it reaches through have (F158 depends on F157).
After it, `main.mjs`, `sessions-client.mjs`, `store-client.mjs` and `pty-client.mjs` — 1,250 lines —
go together, because nothing else imports them.

## What the service does that the object could not

- **One writer, by construction.** KI-061's collision was two workers each persisting one root's
  ring. The retirement suite watched for it by reading pids off the temporaries
  (`<file>.<pid>.<write>.tmp`). There is now exactly one process that writes a state directory's
  ledger — the service — and both workers are its clients, so the assertion changed from "only the
  worker that owns the ledger wrote it" to "neither worker writes it at all".
- **Liveness is the service's own question.** `alive` was a function the worker passed in, and a
  function does not cross a socket; the service asks `kill(pid, 0)`, which is what
  `launcher/sidecar.mjs` asked. So is `lookup` for a desktop assign — what it would have answered
  travels with the request instead.
- **The timer is a sweep.** The JavaScript armed one `setTimeout` per contest. The service settles
  every open ledger every 250ms, which is the same optimisation: every call settles first, so a
  deadline is resolved from the file's absolute wall time whether or not anything fired.

## What this row must not do

Get the arbitration subtly wrong. This ledger is what stops two agents writing over each other's
work: a refusal whose wording changed, a cooldown charged to the wrong contest, a deadline that
re-times when a preference changes, or a holder that reads as gone because liveness followed the
process rather than the session (spec 095, Identity) are each a silent correctness bug in the one
mechanism the workspace has for keeping agents out of each other's way. That is why the transcript
comes first and why every refusal in it is compared word for word.
