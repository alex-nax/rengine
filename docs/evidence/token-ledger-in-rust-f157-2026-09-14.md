# F157 — the project token ledger and its feed, in Rust

2026-09-14. Spec 132. `orchestrator/runtime/{token,feed}.mjs` are deleted; `red-token` answers, as a
service of the state directory, and is judged against the transcript recorded from the JavaScript
while the JavaScript still existed.

## What was compared

`orchestrator/tests/token-transcript.json` — 46 steps of one state machine, each step's answer, the
status it leaves, and both files on disk at the end. `red-token-replay` reads the same script on
stdin (imported from `token-transcript.mjs`, not copied) and prints the same document;
`token-parity.test.mjs` diffs them, values and key order.

    46 of 46 steps identical; token.json and feed.json identical, key for key.

The first run disagreed on four steps — and the JavaScript was wrong, not the Rust. See below.

## What recording and porting it found

**1. `status()` handed out the ledger's own cooldown map.** Every other field it returned was
already a copy: the contest is spread, the identities are `Object.values`, the history is a slice.
`cooldown` was the live object. The transcript serialises at the end of the run, so all forty
recorded statuses showed the map as it looked *then* — empty, because every cooldown had expired —
while the step that charged one answered `cooldownUntil: "2026-09-14T12:01:00.000Z"` in the same
breath. The Rust, having no such aliasing, printed the truth and looked wrong.

Fixed in the JavaScript (`cooldown: { ...this.state.cooldown }`) and re-recorded. The regeneration
changed **five values and nothing else** — all of them `/steps[N]/{ok,status}/cooldown/<agentId>` —
which is what makes the regeneration safe to trust rather than a fresh capture of a moved target.

Not a live bug: the worker JSON-stringifies a status immediately. It was a latent one — a caller
that kept a status held a cooldown map that changed under it — and it made the record lie.

**2. Two rules had no case at all.** Both found by sabotage, both invisible until then:

| sabotage | before | after |
|---|---|---|
| an assign charges the contester a cooldown (`cooldown: false` → `true`) | **passed** | fails at step 41 |
| a rejection charges the current window, not the contest's | **passed** | fails at step 44, by name |

Every assign in the 40-step script met a *free* token, so `settleRejection`'s `cooldown: false`
branch — the one that exists because "the contester did nothing wrong" — was never reached. And the
window preference never changed, so "the window a contest was opened under travels with it" had
nothing to travel through. Six steps were added and the record regenerated while `token.mjs` still
existed; **the first forty steps came back byte-identical**, so the additions are additions.

**3. `status()` settles nothing** (recorded 2026-09-14 with the transcript, restated here): the
worker awaits `settle()` before every answer, so a transcript of `status` alone would have recorded
a view no caller ever sees. Both views are in the record (`rawStatus` and `status`).

## Sabotages

Five, each observed failing for its own reason and restored:

1. a release under an open contest leaves the token free → red (the contest survives in every
   later status and in `token.json`)
2. liveness follows the process rather than the session (`seen` no longer moves the holder's pid) →
   red at the resumed-session steps
3. an assign charges the contester a cooldown → **passed first**; recorded as a gap, covered by two
   new steps, red afterwards
4. a rejection charges the current window rather than the one the contest ran on → red at
   `44: and rejecting it charges the window it ran on`
5. `write_atomically` names its temporary after the process rather than the write (KI-065, ported to
   Rust with the rule) → red with `ENOENT ... rename`, which is the original failure

## What changed shape, and why it is not a regression

- **`worker.mjs` gains nine `await`s.** Spec 132 predicted it would not change; it was wrong, and
  the correction is recorded there. A socket has no synchronous read, and `status`/`refusal`/`seen`/
  `frame`/`segment` were synchronous reads of an in-process object.
- **Two of those call sites got better.** `gate` (settle, note the caller, ask for the refusal,
  persist) and the token-status answer are each ONE call now. Four round trips would also have been
  four moments another attached host could move the ledger between.
- **One writer, by construction.** `token-retirement.test.mjs` watched for KI-061's collision by
  reading pids off `<file>.<pid>.<write>.tmp`. The assertion changed from "only the worker that owns
  the ledger wrote it" to "neither worker writes it at all — the one writer is the service both
  attach to", which is a stronger statement about the same file.
- **`alive` and `lookup` were functions the worker passed in.** A function does not cross a socket:
  liveness is the service's own `kill(pid, 0)`, and what `lookup` would have answered travels with
  the assign request.
- **The recorder is gone.** `token-transcript.mjs` keeps the script, the constants and the frozen
  answers; `transcript()` went with `token.mjs`, because a recorder that replayed the replacement
  would be judging it against itself.

## The desktop gate, and a defect it did not find

The 43-spec desktop suite is not run by `npm test` (KI-105). Run here because F157 replaces the
ledger the desktop's status segment reads: **78 of 81 pass**, the token specs among them —
`the status segment reads the ledger, and the popover sends the four desktop gestures` is the
consumer path, and it passes against the Rust ledger through the same pushes. Both failures predate
this session, each verified by running the spec at `c127141`; one is KI-105's, the other is now
KI-108, bisected to `bfc0675` and half fixed.

The defect the gate did *not* find was found by reading red-store beside the new service:
`red-token-serve` held the ledger lock across `Emitter::say`, which is a blocking socket write, where
`red_store_serve` drops its lock first and says so in a comment. One client that stopped reading
would have held this directory's arbitration for every other client and for the settle sweep. The
watcher and the feed subscriber queue under the lock now and the queue is drained after it — which
is the shape red-store already had, for a ledger with two push points.

## Gates

- `npm test` — 332 of 332.
- `cargo test` — 83 of 83, of which 22 are red-token's and red-core's (8 in red-token, 14 in red-core, four of which
  are `red_core::time`, new: the ISO shape the ledger writes, its inverse, the stamps it refuses,
  and the half that rounds the other way in Rust than in JavaScript).
- `./init.sh`, `python3 tools/features.py validate`.

## Then the third copy of the attach discipline went too

`service-client.mjs` was written for the token client, but the thing it holds — find the
descriptor, refuse anything but loopback with a 64-hex token, end a service whose protocol this host
cannot read, start one under a lock whose stale owner is reaped by PID, connect — already existed
twice, in `store-client.mjs` and `pty-client.mjs`, at about eighty-five lines each. Three copies of
one security check is three chances to check the token differently, so both were collapsed onto
`findOrStart` in a second commit.

Verified by sabotage rather than by reading: disabling the protocol check *in the shared module*
turns `pty-retention.test.mjs`'s "a service that speaks another protocol is ended by name, never
adopted" red, and green again on restore — so the extracted code is the code the suite was already
exercising. `npm test` 331/331 across both commits.

| | before | after |
|---|---|---|
| `store-client.mjs` | 322 | 230 |
| `pty-client.mjs` | 288 | 189 |
| `token-client.mjs` | — | 161 |
| `service-client.mjs` | — | 199 |

## JavaScript on the app path

**6,533 → 6,275.** `token.mjs` (372) and `feed.mjs` (67) are gone, `token-client.mjs` and
`service-client.mjs` arrive, and the two older clients give back 191 lines between them. When F158
deletes `store-client.mjs` and `pty-client.mjs`, `service-client.mjs` is what stays behind.
