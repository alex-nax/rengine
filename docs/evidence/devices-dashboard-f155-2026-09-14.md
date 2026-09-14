# F155 — devices, the dashboard and the game preflight, in Rust

2026-09-14. `devices.mjs` 166 → 76, `dashboard.mjs` 82 → 60, `games.mjs` 166 → 90: three thin
clients of `red_project::{devices,dashboard,games}`, judged against the answers the JavaScript gave.

## The record

`orchestrator/tests/devices-corpus.json` — 22 cases through `projectDevices` and `dashboardActions`
with `inspectGame` as the preflight, recorded while those modules still answered. Every refusal word
for word, because an unreachable device's sentence is what a person reads in the Devices tab and an
action's `missing` list is why a button will not press. Two things are folded so the record is the
same on any machine (the project path and `checkedAt`); the **probe count** each case leaves behind
is compared exactly.

The Rust matched all 22 on its first run. Four sabotages confirm the comparison is real rather than
vacuous: a reachability sentence reworded by one word; `requires`/`tools` no longer short-circuiting
before the probe; the implicit local device not offered; a reason the device already carries restated
under every target bound to it. Each fails, and passes again on restore.

## What the corpus could not catch, and the suite did

**`refresh` meant "ask again", not "ask again every time you are asked".** The JavaScript got that
by *not* passing its options into the dashboard resolution it triggered, so only the devices
listing's own per-device calls refreshed. Written as a field on a shared context, it refreshed once
per lookup instead — three actions on one box probed it three times. The corpus has one device and
no actions in its refresh case, so it recorded 1 either way; `devices.test.mjs` found it at 8 probes
where 2 were expected. It is now a property of the word: a key is dropped once per run.

**`controls` was a function, and a function is not nothing.** `projectDevices` carried the controls
and targets bound to each device only when the caller handed it a `resolve` function; there is
nothing to hand in now, so it is a flag, and a caller that only wants to know which boxes answer
still gets the lighter payload it always got.

**An external declaration was not threaded through.** A root registered with a declaration file of
its own would have been read from the project's file instead. `external-declaration.test.mjs`
found it.

## Two things built rather than translated

**A Rust command runner.** There was none: a declared command is the one path by which anything here
executes something a project chose — a format preview, a device probe, a dashboard capture — and the
bounds are the contract. It runs in its own process group, so a timeout takes what the command
started with it: `probe-hang.sh` backgrounds a writer and sleeps, and the difference is invisible in
an exit status, so it is a test.

**A probe cache that outlives its process.** The JavaScript kept one in memory and joined probes
already in flight, which is what made one listing cost one probe per device rather than one per
action. A per-call implementation can keep the first half and not the second, so the cache is on
disk under the same TTL, keyed by the project root — a device's reachability is a fact about this
machine and that box, not about who asked. Two invocations racing can still both probe; one extra
probe is the cost of not being one process, and it is bounded by the probe's own timeout.

What is preserved exactly is the half that matters: **both listings come from one run**, so three
actions on one device cost one probe, and a second listing inside the TTL costs none.
`devices.test.mjs` asserts both, and a Rust test asserts the cross-process TTL directly.

## What stayed in JavaScript, and why

- `present` and `onPath` — the two local prerequisites, still called by the capture path.
- `declaredDevices`, `deviceFor`, `isLocal`, `boundTargets`, `LOCAL`, `THIS_MACHINE` — pure lookups
  over a declaration, needed without a process. `red-project` holds the same rules; the JS copy
  carries a breadcrumb to the Rust sidecar so the two are known to be a pair.
- `dashboardAction`, `dashboardRunPayload`, `dashboardCapture` — running and capturing.
- The `Games` class — launching, which keeps the session host's process state.

Twelve sidecar entries moved with the code they describe, to `devices.rs`, `dashboard.rs` and
`games.rs`; `devices.mjs` has no sidecar left because nothing non-obvious stayed in it.

## Gates

`npm test` 335/335 · `cargo test` 89/89 · `./init.sh` · `features.py validate`.
JavaScript on the app path: 6,086 → 5,906.
