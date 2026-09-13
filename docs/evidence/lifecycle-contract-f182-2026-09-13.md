# F182 (F181a) — the contract carries the other feed (2026-09-13)

Spec 128 decision 5, KI-099. The owner's decision, taken before implementation:

> "The worker's lifecycle ring, extend the contract" — owner, 2026-09-13, choosing between that and
> carrying the host's `/events` with criterion 2 amended.

## Why there was a question at all

Two streams are both called "the feed". The **host** serves `/events` — hello, session, attached,
output, error: per-session bytes with a monotonic sequence, where a reconnect *rebuilds* from the
attach snapshot (specs 059/060). The **worker** serves `/feed?rootId&after=N` — the lifecycle ring,
which replays frames after a cursor and then subscribes live, and which `RETIRED_FEED` tells
clients to resume from. F140's contract modeled the first; F141's criterion 2 describes the second.
Only the worker's has a cursor, so implementing the host's stream and claiming that criterion would
have been rewriting the requirement to pass.

The ring is also what the companion v0.1 needs: decision 9 lists token contests and approvals and
explicitly defers the terminal to v0.2, so per-session output is not v0.1's feed.

## What the contract now carries

`LifecycleEvent` — `sequence`, `at`, `root_id`, `by`, and a oneof of fifteen frame types. The oneof
is the type: a frame this build does not know is a decode error rather than a frame with an unread
`type` string nobody notices. `Lifecycle` carries the page `/api/feed` answers — `cursor`,
`retained_from` and the frames — so a reader whose cursor fell off the end of the ring learns that
instead of silently missing frames.

Two party shapes, because the workspace has two: `Actor` is who did it (`kind` plus the identifiers
that `kind` makes meaningful), `Party` is who holds or contests the token. Collapsing them would be
the contract inventing a shape the host does not send.

The socket URL in the feed response is **deliberately not carried**: it embeds this workspace's
token, and a contract that copied it would put a credential on the wire for every client. It is
declared with `ignore`, so "we decided not to" and "nobody looked" stay different things in the
source.

## A gap in F140's contract that its own fixture could not see

The richer fixture — a token contested, claimed and released, and a task written — made the token
status carry things the old fixture never produced, and the harness immediately reported six
disagreements:

```
token.identities[0].agentId:     the host sends this and the contract does not carry it
token.identities[0].firstSeenAt: the host sends this and the contract does not carry it
token.identities[0].lastSeenAt:  the host sends this and the contract does not carry it
token.history[1].by.agentId:     the host sends this and the contract does not carry it
```

`TokenParty` had `kind`, `pid`, `id` and `label` — a guess that held only while no fixture produced
a holder, a contester or a remembered identity. It now carries `agent_id`, `since`, `first_seen_at`
and `last_seen_at` as well. **F140 was not wrong about its criteria; its fixture was thin**, and
this is the harness doing exactly the job decision 5 gave it: JSON↔proto drift fails a test rather
than a phone. The lesson is the one the session-state fixture taught in F140 itself — a fixture
that never produces the other half of a shape never tests the contract's knowledge of it.

## What the live ring actually judged, and what it did not

`red-contract` judged **15 shapes including 4 lifecycle frames** on the live workspace:
`token.claimed`, `token.released`, `task.added` and `workspace.updated` — produced by the fixture
contesting the token on a free root, writing a task and releasing.

Modeled but not exercised live, because each needs something the suite does not stand up:
`token.contested` and `token.rejected` (two agents and a wait), `agent.spawned` (a real agent CLI),
`game.started`/`game.ended` (a game), `capture.started`/`capture.committed` (a recording),
`device-action.started`/`device-action.ended` (a device that is not this machine), `task.updated`.
They are modeled from the emitters in `runtime/worker.mjs` and `runtime/token.mjs`, and the strict
translator means the first live one that disagrees will say so rather than pass quietly. Recorded
here rather than implied by a green tick.

## Sabotages, each observed failing for its own reason

| Sabotage | Observed |
| --- | --- |
| a lifecycle frame grows a field (`title` on `task.added`) | `lifecycle.frames[2].title: the host sends this and the contract does not carry it` |
| the workspace renames a frame type (`task.added` → `task.written`) | `lifecycle.frames[2].type: the workspace emitted the lifecycle frame "task.written", which the contract does not carry` |

The second one failed for the **wrong** reason first: a fixture assertion naming the expected types
tripped before the checker ran, which is the "red for something earlier" trap. The type assertion
now runs *after* the checker, so a renamed type is reported by the contract rather than by a
precondition — the same correction F140's own session-state fixture needed.

## Gates

`npm test` — **311 of 311**. `cargo build -p red-core` clean. `python3 tools/features.py validate`
— 134 features.

## What is next

F183 carries this ring over the wire: a WebSocket client against the worker's feed, a long-lived
libp2p stream, and the ordering and cursor-resume evidence criterion 2 asks for. Nothing in F182
touches the transport, and nothing in a running workspace changed.
