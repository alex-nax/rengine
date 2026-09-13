# Charter D62 — the pane record becomes the service's, and the door answers input (2026-09-13)

KI-104, specs 129/131, F189's second slice. The store routes moved at the door earlier today
(`red-host-store-routes-f189-2026-09-13.md`); the session routes hit the same wall one level down.

## The wall

D60 gave the PTY *process* one owner per state directory. The pane's **record** — state, title,
conversation, task, the handoff gate and whether it has been released — stayed in whichever host
spawned it. The service carried a `meta` blob, but it was written **once at spawn and never
updated**: it existed so the next host could name what it adopts, and `sessions-client.mjs` said so
in a comment — *"Handoff gates and drafts are deliberately absent: they belong to the launch that
made them."*

That is KI-103 one level down, and the failure is worse than a stale read. `/api/input` refuses with
`Session is not running.` (409) and `Handoff is waiting for its native view.` (409). A door
answering from a spawn-time photo refuses a pane the person is already typing into, or lets
keystrokes into one whose native view has not appeared. Owner decision (KI-104): **the record
becomes the service's, live** — D61's answer applied to the thing D60 already made a service.

## What that took

- **`describe(id, patch)`** on red-pty: merge into the record, broadcast the pane to every attached
  host, `null` removes a key — a pane that cannot forget a conversation would offer to resume the
  wrong one. A 64 KiB bound, because these records outlive the hosts that write them.
- **A spawn is announced**, like an exit. Found by a sabotage that went red one assertion too early:
  removing the host's write-through made the door answer `Unknown session.`, which meant the door
  learned a pane existed only because a host happened to describe it afterwards. The service owns
  the record, so the service says when there is one.
- **The protocol number goes to 2.** A host speaking 2 expects `describe`; a protocol-1 service
  would answer `Unknown pty method describe.` to the first record a host changed. The spec that
  pins the refusal message now reads the number from `pty-client.mjs` rather than repeating it.
- **`sessions-client.mjs` writes through and applies.** `changed()` became two halves: `changed`
  (this host learned something — tell the service) and `announce` (tell this host's clients), which
  is all a host does when it is applying somebody else's change. A host never answers a broadcast
  with a write.
- **Adoption keeps its old behavior, explicitly.** The gate travels now, so the host that adopts a
  gated pane releases it and records that: the native view it was waiting for went with the host
  that died. What the spawn-time `released: true` used to do implicitly is now a decision with a
  name and a comment.

## What the door owns now

`/api/input` and `/api/resize`, answered from the same record the JS host answers from, in the JS
host's own order of refusals — `input` names an unknown session before it judges the data;
`resize` judges the dimensions before it looks the session up. Swap them and a caller sees a
different status for the same mistake, so the order is asserted.

`red_core::service::Client` grew the other half it was missing: **a reader thread**. A client that
only read while waiting for an answer would learn what it holds at its next request — for a door
deciding whether a pane accepts input, exactly one request too late.

## The check, and why parity could not be it

Three processes on one state directory: the JS host, the door, and a plain client standing in for
whatever host learns something next. The client puts the pane behind a handoff gate; **both** the
door and the host that spawned it then refuse input in the same words. The host releases the gate
through its own `presented()` — writing the gate file, as the native view does — and both accept
again, with the keystrokes arriving at the shell. Then the backend is stopped: input still answers,
because the pane and its record both belong to the directory.

| Sabotage | Observed |
| --- | --- |
| the host ignores another host's record (`described` returns early) | `and so does the host that spawned it, which learned the same way` — the door saw the gate, the spawning host did not |
| the host never writes its record back (`record` returns early) | `the door sees the release (not within 15s)` |
| the door ignores the handoff gate | `the door sees the gate (not within 15s)` — it never refuses |
| the door stops recording the service's lines | `the door answers input for a pane it did not spawn: 404 !== 200` |
| the service does not announce a spawn | `the door learned of a pane nothing described to it (not within 15s)` |

The fifth one **passed at first**, because the host's write-through announced the pane as a side
effect. The test now spawns a pane through a client that describes nothing, which is the only way
the announcement is the thing under test.

## Two suite defects fixed on the way

- **Cleanup ran after the directory was deleted.** After-hooks run in registration order;
  `headless.test.mjs` records the trap in a comment. `endStateServices` now also reads the process
  table, because a service whose descriptor was never written — or was already removed — is
  invisible in the directory and still holds a port and a PTY.
- **The specs built over each other.** Cargo uplifts a binary by removing the destination and
  hardlinking the new one, and two builds of one package with different `--bin` selections re-link
  on every alternation: `spawn red-agent-env ENOENT` for a file that exists before and after. The
  suite already builds every binary in `pretest`, so `tests/cargo.mjs` skips the in-spec build when
  `RENGINE_SUITE_PREBUILT=1` says somebody already has. A spec run alone still builds what it needs.
  This is the second form of the defect `suite-prebuild-2026-09-13.md` records; the first was
  `existsSync`.
- The two `launcher.test.mjs` budgets went from 15s to 60s: each starts a real sidecar, which since
  D60/D61 also starts the directory's PTY and store services, and the suite runs its files
  concurrently.

## Gates

`npm test` — **321 of 321**, three runs, zero services left behind. `cargo test` — all crates.
`./init.sh`. `python3 tools/features.py validate`.

## The pane as an answer: `/api/session` and `/api/stop`

With the record shared, the snapshot the JS host answers with can be assembled anywhere, and the
door assembles it. Three things had to be right.

**Absence is meaningful.** `exitCode`, `signal` and `endedAt` are *missing* while a pane runs, not
null: the JS host leaves them undefined until it has an ending to report, and a client that asks
whether the field is there would read a null as an answer. Sabotaging this — always reporting an
ending — shows up as `+ exitCode: null, + signal: null` against the host's own answer.

**The scrollback cannot travel through a Rust `String`.** Spec 060 counts the history in JS string
characters and the service ships UTF-16 for exactly that reason: a chunk boundary can leave a lone
surrogate in it, which is a legal JS string and not a legal Rust one. So `output` is written into
the answer from the UTF-16 units, each non-ASCII unit as its own `\uXXXX` escape, which `JSON.parse`
turns back into the same JS string. The spec prints an emoji into the pane and compares both
answers; with the field built as a Rust string instead, the astral pair comes back as `?? fire`
against the host's `🔥 fire`.

**Two more fields turned out not to be the host's.** A resize through the door changed the terminal
and the JS host went on describing the pane at its old size, because the service never announced a
resize — the same gap as the spawn announcement, found the same way, by two hosts disagreeing about
one pane. A resize is announced now, and a host applies the dimensions it is told rather than only
the ones it set. And `endedAt` moved into the service: the host used to stamp its own arrival time,
which is fine while one host watches a pane and is two different deaths when two do.

While they were being announced, the events themselves got smaller: a broadcast carries the pane
without its history. Nothing that reads those lines reads the scrollback — a host keeps its own, a
door asks for it when somebody wants it — and a snapshot per resize with a megabyte of history in it
would be a service shouting its whole memory every time a person drags a pane edge.

`stop` also learned to answer the ending it caused rather than `stopping`: it SIGKILLs and then
waits for its own watcher, instead of handing the caller a death it has already arranged and leaving
it to poll for the news. The door's `/api/stop` answers `state: 'exited'` with the service's
`endedAt` and, like the JS host's, without the scrollback.

| Sabotage | Observed |
| --- | --- |
| the scrollback written as a Rust string | `?? fire` where both hosts should say `🔥 fire` |
| a running pane reports an ending anyway | `+ exitCode: null, + signal: null` against the host's answer |
| a resize is not announced | `+ cols: 90, - cols: 100` — the door resized it, the host never heard |
| `stop` answers before the ending it caused | `+ 'stopping', - 'exited'` |

## What this does not claim

- **F189 is not finished.** `/api/terminal`, `/api/agent-restart`, `/api/agent-conversation`,
  `/api/state`, desktops, surfaces and both sockets are still forwarded, and nothing is deleted.
  Spawning a pane is the interesting one left: it composes an agent's launch, which is red-agents'
  work, and it is where `/events` will have to follow.
- **The door's record cache never forgets an exited pane**, which matches the JS host's `items` map
  — but the JS host is restarted often and a door is not. If a door ever runs for weeks, that is
  the first place to look.
