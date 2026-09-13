# F183 (F181b) — the ring on a long-lived stream, resumed from a cursor (2026-09-13)

Spec 128 decision 2, KI-099. The transport half; F182 was the contract. With this, **F141 is
complete**.

## One behaviour, not two

`/red/1/feed` is a stream, not a request and an answer. A subscriber opens it, writes one
`FeedSubscribe` naming the root and the cursor it last saw, and the façade opens the workspace's own
`/feed?rootId&after=N` — which replays the ring from that cursor and then **stays open with live
frames on the same socket**. The façade pumps one into the other, translating each frame on the
way.

That is why replay-from-cursor and stay-live are one claim here rather than two: the workspace has
always served them on one connection, and a façade that split them would be inventing semantics the
thing behind it does not have. The test asserts both on one stream for the same reason — a test
that only replayed would pass over a request-and-answer that closed, and a test that only watched
live frames would prove nothing about the cursor.

## What the test does

A real workspace (session host + worker), a relay, and a façade that listens only through it. The
fixture contests the token on a free root (which claims it), writes a task and releases — three
frames in the ring before anything subscribes. Then:

- a subscriber asks from `after=0` for one more frame than the ring holds;
- it is given the ring, in the workspace's own order, matched sequence by sequence against what
  `/api/feed` says the ring is;
- a task is written **after** it subscribed, and that frame arrives on the same stream;
- sequences are checked to be increasing and never repeated;
- and a second subscriber, resuming at the first frame's sequence, is given the frame *after* it —
  not the one it already had.

## Sabotages, each observed failing for its own reason

| Sabotage | Observed |
| --- | --- |
| the façade ignores the cursor and always asks from 0 | `a subscriber resuming at 1 is given the frame after it, not the one it already had — 1 !== 2` |
| the façade closes the stream after each frame (request/response framing) | `red-link feed exited (1) before that it replayed the ring up to the cursor: the lifecycle stream ended: unexpected end of file` |

The second is the one that matters: with a closing write the first frame still arrives, and every
assertion about *content* would have passed. What fails is the claim that there is a stream at all.

## Two things the façade refuses to do

**Translate loosely.** A frame that the contract cannot carry whole ends the subscription with the
disagreement named, rather than delivering a half-read frame. F182 made drift loud in a test; this
makes it loud on the wire.

**Forward the workspace's token.** The worker authenticates its feed socket from the query string,
so the URL the façade builds carries the token — and that URL never leaves the process. The
contract deliberately does not carry the `socket` field the feed response includes for the same
reason (F182).

## Gates

`npm test` — **312 of 312**. `cargo test -p red-link -p red-core` — 12 tests.
`python3 tools/features.py validate` — 134 features.

## F141 is complete

| criterion | where |
| --- | --- |
| a client forbidden any direct connection completes the v0.1 read surface through circuit-relay v2 | F180 — the façade opens no direct listener at all |
| feed events arrive in order with monotonic sequence; a reconnect resumes from a cursor | this row |
| the session host and every existing consumer are untouched; npm test stays green with red-link running | F180 — three consecutive runs with a relay and a façade up |

What F141 does **not** give anyone: trust. Pairing, identity and revocation are F142, and until
that lands anyone who can reach the relay and name the façade's peer id can ask it these questions.
`red-link` is a development tool today, not something to point at the internet.
