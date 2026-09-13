# F180 (F141a) — the façade serves the workspace over a relay that cannot be bypassed (2026-09-13)

Spec 128 decisions 2 and 4, KI-098. The first half of F141: the read surface. The feed is F181.

## The shape

`red-link` gains three modes and they are one wire:

| mode | what it is |
| --- | --- |
| `relay` | circuit-relay v2 rendezvous on a machine the owner controls. It terminates nothing. |
| `attach` | the façade: the workspace's internal HTTP API on one side, `/red/1` streams on the other. |
| `probe` | a client, so the path has something to prove itself against before a phone exists. |

The workspace is reached exactly as decision 2 says — the internal HTTP API the worker and the MCP
connector already use — and it spans **two** processes, because the read surface does:
`/api/state` and `/api/dashboard` come from the session host (found through the `sidecar.json`
descriptor, checked the way `discoverSidecar` checks it), and `tracker`, `token` and `agents-menu`
from the root-bound worker. F140's own contract bundle already recorded that split; this is the
first thing to depend on it.

Nothing here scans for a workspace. The state directory and the worker's URL and token are
**inputs**, for the reason F173 arrived at the hard way: a component that goes looking can attach
to the wrong workspace, and the failure is silent.

## Why the relay path cannot be skipped

The criterion asks for a client "forbidden any direct connection". A rule the client is trusted to
follow would prove nothing, so the façade is built so that there is nothing to forbid: **it opens
no TCP listener at all**. Its only listen address is `<relay>/p2p-circuit`, which means the NAT
path every phone will take is the only path anything can take — on loopback, today, before any
phone exists.

The test asserts that property directly (every listen address the façade reports contains
`p2p-circuit`) and then asserts the relay's own events: a reservation from the façade, and one
accepted circuit per request. A test that only compared answers would pass just as happily over a
direct connection nobody noticed.

## A real defect the forced path found immediately

The first run failed with `Reservation(Unsupported)`, and identify explained it: the relay
advertised `/ipfs/id/1.0.0` and nothing else. `relay::Behaviour` decides whether to advertise the
hop protocol from whether it has learned an **external address** — which a relay on loopback, or
behind the owner's own NAT before anyone has told it anything, never does. So a relay that is
running, reachable and correctly configured silently is not one.

`red-link relay` now states its status (`set_status(Some(Status::Enable))`) rather than letting it
be inferred, and confirms its own listen address as external so the address it hands out is the one
it listens on. Decision 4 puts the relay on machines the owner controls and pins them; a process
that has been *told* it is a relay by being run as one should not be guessing.

## The contract grew an envelope

`red.v1` gains `Request`/`Response` with a oneof each, and `RequestError`. The oneof is deliberate
for the same reason the feed's is: a request this build does not know must be a decode error the
façade can name, never a default-constructed request it answers anyway. Drift is never swallowed —
a shape the translator could not carry whole comes back as `RequestError` naming every disagreement,
because F140's harness exists to make that loud and answering half a message quietly would undo it.

Generated types now derive `serde::Serialize` (and deliberately not `Deserialize`: JSON is never an
input to this contract — the host's JSON arrives through `translate`, which refuses what it cannot
carry, and a second unchecked way in is not wanted). That is what lets `probe` print the whole
answer instead of a hand-written summary that would be a second description of the contract.

## Sabotages, each observed failing for its own reason

| Sabotage | Observed |
| --- | --- |
| the façade also opens a direct TCP listener | `the façade has no direct address for anyone to dial: /ip4/127.0.0.1/tcp/63076, …` |
| the workspace section is answered without asking the host | `the same roots, in the same order` — `+ []` against the root the workspace has |
| a root-scoped request with no root is allowed through | `the refusal says what was missing` |
| the relay stops reporting accepted circuits | `every request crossed a relayed circuit, not a direct connection: 0 circuit(s) for 5 requests` |

The last one is there because the circuit count is the only thing standing between this test and a
green tick that means nothing: it checks that the evidence channel is load-bearing, not decorative.

## Criterion 2: the workspace is untouched

`npm test` — **311 of 311**, three consecutive runs, with a `red-link relay` and a `red-link attach`
process up the whole time. The suite starts and stops its own hosts; the façade attaches to a
workspace over HTTP and changes nothing about it, which is what decision 2 promised and is now a
run rather than a claim. `cargo test -p red-link -p red-core` — 12 tests.

One earlier run of the suite reported a failure in two files (the contract test and a game
prerequisite test) that pass alone and passed in all three later runs; it is recorded here rather
than smoothed over. The plausible cause is contention between the several test files that now build
cargo targets and start hosts at once, and it is worth watching rather than declaring solved.

## What this costs, said out loud

`cmake.toml` imports `red-link` through Corrosion, so the desktop build now compiles libp2p and its
tree — roughly 300 crates. `Cargo.lock` is the pin (spec 128's dependency policy) and it is
committed, so what entered the tree is checkable; but the C desktop's build time went up for a
dependency it does not use yet, and that is the honest cost of one build entry point (decision 3).

## What is not here

- **The feed** (F181): the host serves its event stream as a WebSocket, so that half needs a WS
  client in Rust — a handshake, masking and framing the read surface needs none of — plus ordering
  and cursor-resume evidence, which is a different test shape from a request and its answer.
- **Pairing and trust** (F142): anyone who can reach the relay and name the façade's peer id can ask
  it these questions today. That is the next row's whole subject, and until it lands `red-link` is a
  development tool rather than something to point at the internet.
- **dcutr**: the direct upgrade is built into the transport but nothing here observes it, because
  there is no second machine yet. Decision 4's evidence plan puts that on a real cellular run.
