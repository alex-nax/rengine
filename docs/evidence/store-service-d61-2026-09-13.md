# D61 — the store belongs to the state directory (2026-09-13)

Charter D61, KI-103. Not a feature row of its own: the prerequisite every route migration into
red-host needs, and the answer to a question the epic had assumed away.

## The question

Moving a route into red-host moves the state it owns. `store-client.mjs` **spawns its own**
`red-store-serve` per host process, so a front door serving `/api/tree` or `/api/save` from its own
store while the JS backend still held the same state directory would be two in-memory owners of one
set of files: stale reads on one side, lost writes on the other. The epic sequenced red-host after
the store and PTY moved, which is true of the **crates** and not of the **processes** during a
strangler transition.

The owner chose the answer that was already proven: give red-store the shape red-pty has under D60
— a descriptor in the state directory, one long-lived service, every host attaching to it.

## What was built

**One implementation of the service, not two.** The descriptor (`store.json`/`pty.json`, tmp+rename,
0600), the `attach` handshake with its token and protocol number, the client list, and the idle
reaper are now `red_core::service`, used by both. What each service keeps is what is actually its
own: the dispatch, and what *holding* means.

- **red-pty holds and never reaps while it does.** A shell is not on disk.
- **red-store holds nothing.** Its state is on disk, so an idle store reaps itself and the next
  attach reads the same state back. That difference is one method on the shared trait.

**Two hosts stay in step.** Each client keeps a snapshot — `root()` is a lookup in it, not a call —
so one owner is only half the answer: the service pushes its new state to every attached host after
any change, and a host that added a root sees it immediately while another host sees it within a
round trip. That is the honest shape of two processes sharing one store, and it is asserted rather
than assumed.

**`replace.mjs` leaves both.** Its retained list was one service and is now the pair, named by the
descriptors they publish. Stopping either would take from the next host exactly what these decisions
gave it: the panes in one case, the state in the other.

## Sabotages, each observed failing for its own reason

| Sabotage | Observed |
| --- | --- |
| the service stops telling other hosts the state changed | `Unknown project root.` — the second host refuses a root that exists |
| the client always starts a service instead of reusing one | **passed** — the startup lock's double-check catches it, so the assertion counts `red-store-serve --state <dir>` processes rather than comparing what two clients found |
| a protocol mismatch answered 401 instead of 409 | the pty suite's own refusal test, which is what kept the two statuses distinct through the extraction |

## A leak the suite found immediately

91 stray services after one suite run. A test that starts a **real** host, kills it and deletes its
directory leaves the directory's services behind — and a PTY service holding a shell never reaps,
which is exactly D60's promise. Two answers, both applied: `npm test` runs with a five-second idle
so an unheld service goes away on its own, and a test that owns a state directory ends its services
(`tests/state-services.mjs`). After: **zero**.

## Gates

`npm test` — **320 of 320**, and nothing left running afterwards. `cargo test` across the workspace
— 22 suites. `python3 tools/design.py check` clean.
