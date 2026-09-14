# The token ledger's transcript, frozen before it moves (2026-09-14)

F157, spec 132. The ledger is what stops two agents writing over each other's work, so the port that
replaces it is judged against a record of what it does today — recorded while it still exists.

## The clock and the mint travel as data

`Ledger` and `Feed` read `Date.now()` and drew ids with `randomUUID()` directly, and two
implementations of a state machine cannot be compared while either does that. Both now take `now`
and `mint` as options, defaulting to the real ones, the way `agent_pane_composition` already takes
them (F148: *a pane's plan is a function of its inputs and a test never depends on a draw*). Nothing
about a running workspace changes; the seam exists so a transcript can be recorded.

## A state machine's record is a transcript

`orchestrator/tests/token-transcript.{mjs,json}` is **40 steps** over one ledger: a free token
claimed at once, a second agent's contest, a third refused while one is open, a non-holder's reject
refused by name, a rejection and the cooldown it charges, a contest refused under that cooldown, the
clock passing it, the clock passing a deadline, a release that answers an open contest rather than
leaving a free token, the desktop's assign/grant/reject/revoke/free with the ids they must name, a
holder whose process left, and the refusal a tool shows in both states. Each step records the answer,
the status the ledger is left in, and — at the end — **both files it leaves behind**, because a
transcript that agreed step for step and left a different `token.json` would be a ledger that agreed
about everything except what happens next.

## What recording it found, before any Rust was written

**`status()` settles nothing.** The ledger's own comment says settling is "applied before every read
and every call", but `status()` is a synchronous read: the worker awaits `settle()` before every
answer (`worker.mjs:143`, `:233`), and that is where a passed deadline resolves. A transcript that
called `status` alone would have recorded a view no caller ever sees — and would have let a
replacement skip the settle entirely. Both views are recorded now: the raw read that still shows the
old holder, and the settled one that shows the transfer.

**And one rule had no case until a sabotage passed.** Identity is the agent's *session*, not its
process: a resumed session is the same `agentId` under a new pid, so the hold stands and liveness
follows the process running it now. Removing that rule changed nothing in the transcript, because
nothing in it resumed. Four steps were added — take the token, end the process, come back under a
new pid, and watch the next contester open a window rather than claim a token it thinks nobody
holds.

| Sabotage | Observed |
| --- | --- |
| a rejected contester is not charged a cooldown | the contest it should be refused for succeeds |
| a release under a contest leaves the token free | `- by: 'release'` — the contester waits out a window for a token nobody holds |
| a resumed holder's new pid does not follow its session | the holder keeps the dead pid and reads as gone |

## Gates

`npm test` — **330 of 330**.

## What this does not claim

Nothing is ported. This is the artifact the port is measured against, and the two findings above are
the reason it was worth writing first.
