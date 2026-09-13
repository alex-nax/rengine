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

`npm test` — **324 of 324**, zero services left behind. `cargo test` — all crates.
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

## `/events`, and the desktops that live on it

The door serves the socket itself now. `/surface` is still forwarded — it carries a game's frames
and games have not moved — so the door's own WebSocket and the splice sit side by side on one port,
which is also the proof that the splice still works.

The shapes are the JS host's: `hello` on connect, `attached` with the scrollback, `session` and
`output` fanned out to every viewer, `error` for a refusal — as a message, not a closed connection,
because a desktop that sent one bad frame should keep its panes. A viewer more than four megabytes
behind is closed with 1013 and told to reconnect, which is what the JS host does and is safe because
the scrollback it lost is in the next attach.

Two rules the socket enforces that the routes do not: `presented` is refused unless this socket
attached the pane first, and the pane record it releases is the service's (D62), so the gate a
person's view opens is a gate every host sees open.

**The desktop registry moved with it**, because a desktop says it exists by sending a frame on this
socket — nobody else can know. `/api/desktops` and `/api/desktop-action` are the door's now, with the
JS host's own refusals: a pane the host never had is *reported back* rather than refused (it ended
with the host that owned it, and the desktop's saved layout outlived that process), a second action
while one is pending is 409, a desktop that says nothing is "did not acknowledge", and an
acknowledgement from a socket that was not asked is not an acknowledgement. A closed socket takes its
desktop with it.

The spec drives **both** hosts with the same registration frame and compares what they answer,
because "the native desktop connects unchanged" is a claim about shapes and the JS host is the record
of what those shapes are.

| Sabotage | Observed |
| --- | --- |
| a pane from a previous host makes the registration fail | `both hosts registered the desktop (not within 15s)` |
| two actions to one desktop at once | `500 !== 409` |
| a closed socket leaves its desktop behind | `the closed desktop left the list (not within 15s)` |
| anyone may acknowledge another desktop's action | `a socket that was not asked cannot answer (not within 15s)` |
| the door does not pass a pane's output to its viewers | the native desktop never shows what was typed |
| the door refuses the desktop's registration | the native desktop is not in `/api/desktops` |

## `/api/state`, and what it turned out the door was not tracking

The route a desktop polls is now the door's own: the store's state (D61) and the panes the service
holds (D60/D62) are both here, so there is nothing left to forward. `stateDir` and `pid` are said
out loud for the layer above (specs 101/102) and they are THIS process's — the honest answer, since
the door is the host a client is talking to. The capability list is published verbatim, because a
client reads it to decide what it may ask for and a door that claimed less would turn features off
in a desktop that has them.

The comparison against the JS host's answer immediately found something the door was getting wrong:
a pane's `sequence` only moved when something happened *to* the pane, not when the pane *said*
something, because the door's record cache was fed by `session` events and not by output. The JS
host advances it on every chunk and a reconnecting desktop uses it to know where it is (specs
059/060). Fixed by advancing the cached pane with its own output, which is what the JS host does.

The pane list is ordered oldest-first by `createdAt`. The JS host answers in the order it learned
about its panes — creation order, for a host that started them — and a door that adopted them from
the service has no such history; the pane's own timestamp is the one order both can agree on.

| Sabotage | Observed |
| --- | --- |
| the door invents its own capability list | `- projectGame: 1` against the host's |
| a pane's sequence stops moving with its output | `+ sequence: 0, - sequence: 9` |
| the state's draft list carries the draft text | `+ text: 'a draft from the door'` |

## What a pane is called: `/api/agent-conversation`

The pane corrects the workspace. rEngine may have minted a conversation, the person at the pane may
have picked a different one from the offered list, and their own `--resume` beats both — so the
pane reports what it actually launched, and `null` means *this launch continues or forks a
conversation the CLI names itself*, which the record must claim nothing about rather than keep an id
that would resume the wrong one.

It is **two writes that must not come apart**: the workspace's record of the conversation (the
store's, shared since D61) and the pane's record of which one it is running (the service's, shared
since D62). The spec checks both, and reads the second one back through the JS host.

The title is the third thing, and it is not this crate's to invent: the short form is the CLI's own
recipe — a prefix to strip, a length — which is why every kimi id would otherwise read `session_`.
red-host links red-agents for it and resolves the registry the way `red-agents-serve` does. The spec
compares the door's title against `agentTitle` **imported from the JS host**, so the two
implementations are checked against each other rather than against a string typed twice.

| Sabotage | Observed |
| --- | --- |
| the short form is eight characters, not the CLI's rule | `claude aaaaaa` where the JS function says `claude aaaaaaaa` |
| a null report is taken as no change | the pane keeps a conversation the CLI is not running |
| the pane is told and the workspace is not | `the store remembers it: []` |

## Making a pane: `/api/terminal` and `/api/agent-restart`

The last routes F152 names. What a pane launches, which conversation it claims and what it is
offered are **not** re-implemented: that composition is red-agents' (F168), one implementation both
hosts call. What the door had to grow is the plumbing around it — the paths, the environment, the
handoff read, the record — and the spec checks it by sending the same request to both hosts and
comparing the two panes.

`readHandoff` came across with it, and every check in it is there because the alternative is worse
than refusing: a manifest naming another project would move a person's session sideways, a
checkpoint outside the project would read a file the pane has no business reading, and a session id
with no local rollout would quietly start a NEW conversation wearing the old one's name — which the
JS says out loud, *"No substitute session was launched"*, and which is the promise being kept.
`waitForPresentation` and `resumeArgs` stayed behind on purpose: they run inside the pane, in its
own launcher.

| Sabotage | Observed |
| --- | --- |
| the pane's environment is inherited rather than composed | the pane reports the session identity of the host that started it |
| the working directory is not checked against the root | a pane opens outside the project, where `400` was expected |
| the composition's minted conversation is not recorded in the workspace | `the store remembers the door's pane too: [...]` with only the other host's |

The environment one **passed at first**, which is the third time today. Nothing was checking that a
pane's environment is composed rather than inherited — KI-068's whole lesson — so the door is now
started carrying another pane's identity and a `NO_COLOR`, and the pane is asked what it was given:
the identity cleared, `NO_COLOR` dropped because `TERM` here declares colour, and the agent home
this workspace's.

**Two hosts, two pane lists, and that is correct.** The door lists every pane the service holds,
whichever host started it — it is the list a desktop reads. The JS host lists what it started and
what it adopted when it came up, which is all D60/F179 ever gave it. The asymmetry is in the
harmless direction, and it is asserted rather than assumed, because the day it matters is the day
something starts reading the backend's list again.

## The desktop itself, against the door

`orchestrator/tests/native-front-door.spec.mjs` is the criterion F189 actually asks for. It starts
the real native binary, points it at red-host with the JS host behind as the backend, and drives what
a person drives: the tree lists, a file opens, an edit becomes a draft, Save writes the working file
on disk, and what is typed into a pane comes back out of it. Then it checks the desktop registered
itself with the door.

**Nothing in `orchestrator/native/` changed for this.** That is the claim, and the way to check a
claim like that is to run the binary against the new host rather than to compare route handlers.

## What this does not claim

- **F189's routes are all moved, and the row is still open.** `/surface` is still spliced (games,
  F155), the thirteen routes F153–F156 own are still forwarded, and **nothing is deleted** — see
  KI-102 for why the deletion is at the end of the arc, and KI-106 for the other half of that gate.
  Criterion 2, the focus-eviction semantic, is preserved the only way this row can preserve it:
  `surfaces.mjs` is untouched behind a byte-for-byte splice.
- **The JS host still spawns panes**, for `games.launch` and `/api/dashboard-run`, until F155 moves
  them. Both hosts call the same red-agents composition, so what exists twice is the plumbing.
- **`surfaces.mjs` cannot move with this row.** F152's description lists it beside desktops, but the
  module belongs to `games.mjs` — it is the game viewer's frame transport, not the workspace socket —
  so it moves with games (F155). Its focus-eviction semantic is preserved here in the only way this
  row can preserve it: `/surface` is spliced byte for byte and the module is untouched.
- **The door's pane cache never forgets an exited pane**, matching the JS host's `items` map. The JS
  host is restarted often and a door is not; if one ever runs for weeks, that is the first place to
  look.
- **`native-handoff.spec.mjs` fails, and did before any of this** (KI-105). It is in the desktop gate,
  which `npm test` does not run.
