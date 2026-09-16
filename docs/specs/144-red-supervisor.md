# Spec 144 — red-supervisor: the layer that performs updates

Owner goal, 2026-09-15: *"finish remaining js"* (charter D57, spec 129; F159).

Status: **the binary serves, and the desktop layer is driven.** `red-supervisor` is a process: it
starts a worker, answers its own routes, forwards the rest, publishes the descriptor, opens and
updates desktop windows, and relays their automation protocol — all proved end to end against a real
session host by `supervisor-cutover.test.mjs`. Nothing is deleted yet; the launchers and the cutover
itself are what is left.

`docs/js-retirement-status.md` is the whole picture this row sits in. Spec 143 is the worker one
layer below, and its device is the one used here: **record the old implementation's answers before
deleting it, then judge the replacement against the frozen record** (F173).

## What the supervisor is, and why it cannot update itself

Every other layer in this workspace is replaceable while it runs. The session host keeps the PTYs,
the worker is swapped on a layered update, the desktop is relaunched from a snapshot, the connector
is rebuilt and probed. The supervisor is the process that *does* all of that, so it is the one layer
a layered update cannot replace — its code changes when it restarts, and restarting it costs the
managed desktop windows and nothing else.

That shape is what makes the port delicate. `runtime/supervisor.mjs` is 436 lines and almost all of
what is hard about it is **process lifecycle**: a candidate worker that must start, identify itself
and pass a capability check before anything is switched to it; a desktop that must detach with exit
code 75 and come back on the prepared binary; a failed job that must put the previous worker back
and tell the rejected one it was retired — in that order, because a worker told it was retired while
it is still current would forward requests to itself.

None of that can be judged by comparing answers. It is judged by the suites that already drive it:
`runtime.test.mjs`, `hot-update.test.mjs`, `replace-host.test.mjs`, `headless.test.mjs`,
`restart-supervisor.test.mjs` and four desktop specs.

## The measurement that shapes the port

Thirteen routes, and they are not one kind of thing:

| routes | what they need | lines |
|---|---|---|
| `POST /api/layout`, `GET /api/project-windows`, `POST /api/project-window-open`, `POST /api/project-window-action`, `POST /api/integration-report`, `GET /api/integration-inbox` | a durable store and a native control channel | ~145 |
| `GET /api/update-status`, `POST /api/update-workspace`, `POST /api/desktop-action` | the worker and desktop lifecycles | ~105 |
| `GET /api/state`, `GET /api/desktops`, `POST /api/open-desktop`, `/health` | a child process to ask | ~80 |
| everything else | forwarding and tunnelling to the current worker | ~15 |

**Six of the thirteen are a store.** A window is a row, a layout is a document the desktop hands
back, and a report is a letter. There is no process in any of it, which is why it is the part that
can be frozen exactly — and it is where the port starts.

## The addressing rule, because it is the part worth getting wrong loudly

A project window links **two roots**: the origin that opened it and the project it opened. A report
sent across it always goes to *the other one*. Everything else this store refuses follows from that:

- A root on neither side cannot read the window, and gets the same refusal for a window that does
  not exist — the two are the same fact from where it stands, and distinguishing them would tell a
  stranger which window ids are real.
- The originating agent may report **as** the project it opened (`fromProject`), and is then
  answered in its *own* inbox, because the sender was the project side.
- The project side may never speak as the origin.
- The permission is checked loosely and the sender chosen strictly, so a caller that sent something
  other than `true` is answered as itself and still cannot claim the origin's side.

And a retry key is a promise rather than a name: the same key with the same content is the same
report, so a client that timed out and asked again gets one letter; the same key with *different*
content is refused rather than allowed to rewrite what the recipient may already have read.

## The other contract: what a desktop is launched with

`runtime/desktop.mjs` hands a window a handful of `RENGINE_*` variables and one argument, and the
native side reads them at startup to learn which workspace it belongs to, which window it is, and
what to open in it. Getting one wrong does not crash: it produces a window that starts and is
quietly bound to nothing, or that resumes an agent nobody asked to resume.

**The absences carry as much as the values.** JavaScript drops an `undefined` from a spawn
environment entirely, so an ordinary desktop has no `RENGINE_WINDOW_ID` **at all**, while a desktop
with no terminal has `RENGINE_INITIAL_TERMINAL=""` — two different facts, and a port writing `""`
for both would tell the native side that this desktop *is* a project window whose id happens to be
blank. `Option` is that distinction on the Rust side.

`orchestrator/tests/desktop-launch-corpus.json` is the record, and it is taken by launching a real
child through the real `launchDesktop` and asking it what it received — which is the only way to
record an absence, because the object handed to `spawn` cannot show one. Six sabotages, including
the two that collapse an absence into an empty string.

## The record

`orchestrator/tests/window-store-corpus.json` — 47 cases, run as **one sequence against one store**
rather than as independent answers, because most of what this module decides depends on what it was
told before. `red_supervisor::windows`'s replay matched it on the first run; five sabotages confirm
the comparison, each observed failing at its own case:

| sabotage | the case that went red |
|---|---|
| the report goes to the side that sent it | *the origin reports to the project side* |
| a bound counts bytes instead of UTF-16 code units | *a bound counts what JavaScript counted* |
| a retry key overwrites instead of refusing | *the same key with different content is refused rather than overwritten* |
| the listing carries the layout | *the origin lists the windows it is on either side of* |
| `hasMore` asks from the old cursor | *the project side reads what the origin sent it* |

Two rules no record could carry are unit tests beside the code: a refused write leaves the file
byte-identical (the write path applies to a copy and keeps it only once it is on disk), and the
store survives a supervisor restart, which is the whole of what makes this transport durable.

**UTF-16 again.** Every bound here was written against `String.prototype.length`, which counts UTF-16
code units. A port that counted bytes would refuse a summary of 1,100 accented characters the
JavaScript accepted — the same text, a different answer, and no way for the person who wrote it to
tell why. This is the second time this epic has hit it (F156b was the first).

## Completion is not acceptance, and the refusals are ordered

Asking for an update answers **202** with a job id and a sentence that names where the outcome will
be. A caller that treated the 202 as success would report a failed update as a working one, so the
queued answer says so in words: *"Update queued. Read update_status for completion or failure."*

The refusals come in a fixed order — root, layers, desktop, then whether another update is running —
because a caller that named a bad layer *and* a desktop on another project must get the same
sentence every time, not whichever check happened to be cheapest. A recovery in flight counts as
running: a worker being put back is the same kind of busy as an update, and switching one out from
under the process restoring it is the failure that ordering prevents.

A job **never ends in `recovering`**. That state means the switch failed and the previous state is
going back; by the time the job is finished it is `failed`, because a caller polling a job that
stayed `recovering` forever would be waiting on a word that is not an outcome.

Two shapes that look like details and are not: an absent `desktopId` is an **absent field** rather
than a null (`JSON.stringify` drops an `undefined`, so a workspace-only job has never carried the
key), and the job list keeps the newest thirty-two rather than the first thirty-two — it exists so a
caller polling after a failure can still see what failed.

## The order the rest comes in

1. ~~**The window store.**~~ Done.
2. ~~**The descriptors.**~~ Done: `red_core::descriptor` is `runtime/protocol.mjs`'s
   `checkConnection` and the discovery half of `launcher/sidecar.mjs` and `runtime/discovery.mjs`.
   What is left of this piece is the **ensure** half — the startup lock that makes two callers
   asking together produce one process — which waits for a Rust caller to have.
3. ~~**The desktop child.**~~ Done for the two halves that can be judged: what a window is
   launched with (`red_supervisor::desktop::environment`, against a record taken from a process that
   actually received it) and the control channel it is asked things over. What is left is the
   snapshot and the prepared-build step, which spawn a build and belong with the job below.
4. **The worker child and the job.** The caller's half is done — `red_supervisor::jobs` is what
   may be asked for, in what order it is refused, and the status a caller polls. What is left is
   `startWorker`'s identity/capability check, `perform`'s ordering, and the recovery that is used
   once.
5. ~~**The server.**~~ Done. `red-supervisor --state DIR --host URL --host-token TOKEN` binds a
   loopback port, announces itself on stdout as one JSON line, writes `runtime.json`, and serves —
   its own thirteen routes, everything else forwarded to the worker, `/events` and `/surface`
   tunnelled byte for byte. `--worker`, `--connector`, `--desktop`, `--port`, `--inspect-ui` and
   `--initial` are the flags that replace what `startRuntime` took as injected functions.
6. ~~**The automation relay**~~ — done (below), and with it the desktop layer is driven end to end.
7. **The launchers.** `replace.mjs`'s process-table scan, `restart-supervisor.mjs`'s confirm prompt
   with no non-interactive bypass and its read-only `--plan`, `headless.mjs`, `bootstrap.mjs`.
8. **Cut over and delete.** `discovery.mjs` spawns the binary where it forks the module — the same
   fork-versus-spawn seam the supervisor itself grew for `red-worker` — and the eleven JavaScript
   files retire together, with their caller.

## The third criterion, and the one thing standing in its way

F159 asks that *"the sidecar request/ensure path the remaining Rust binaries use is one shared
implementation."* There were **four** copies of "is this descriptor mine, and is its process alive?"
in the Rust tree. Two are now one:

- `red_core::descriptor` is the implementation, with `red_core::http` underneath it.
- `red-mcp`'s private copy is gone, and it had a real defect: it asked the process table by
  **shelling out to `kill -0`**, which reports a live process the caller may not signal as *dead*.
  Every agent pane's tool routing went through that check.

Two copies are left, and both are in `red-agents`, which **deliberately has no `red-core`
dependency**: its manifest says so, because the hand-rolled TOML parser exists to accept exactly the
grammar the JavaScript parser accepts. Taking the dependency would pull prost, rustls and tokio into
a crate whose binaries are spawned per pane, to read one JSON file.

- `red-agents::bind::discover` is `discoverSidecar` again, with a **weaker** health check: it
  ignores the `protocol` and `instance` a `/health` answer carries, so it would bind an agent to
  any process answering on that port.
- `red-agents::bind::http_get` is a fifth hand-rolled HTTP client.

The choice is between taking the dependency and extracting the descriptor reader into a crate small
enough for `red-agents` to depend on. It belongs with the rest of F159 rather than before it, and
it is written down here so the criterion is met on purpose rather than declared.

## What the binary is, and what proves it

    red-supervisor --state DIR --host URL --host-token TOKEN
                   [--worker PATH] [--connector PATH] [--desktop PATH]
                   [--port N] [--inspect-ui] [--initial JSON]

It binds a loopback port, announces itself on stdout as one JSON line — the same shape `red-worker`
announces one layer down — writes `runtime.json`, and serves. The flags are what `startRuntime` took
as injected functions: a suite that handed in a `workerFile` hands in `--worker`, one that handed in
a `toolWorkerFile` hands in `--connector`.

`orchestrator/tests/supervisor-cutover.test.mjs` drives it against a real session host: the
descriptor it publishes, `/health` without a credential, the refusals for a missing credential and a
foreign origin, the composed `/api/state`, a forwarded `/api/feed` (the one route nothing but a
worker can serve), the update status, the refusals **in order**, and a whole layered workspace update
— candidate started, checked against this host, switched in, the previous worker retired and closed.
It passed on the first run; four sabotages confirm it:

| sabotage | what went red |
|---|---|
| the layers are judged before the root | a bad root with bad layers answered about the layers |
| `update-status` is forwarded rather than answered | *Unknown workspace endpoint* |
| a foreign `Origin` is accepted | the 401 that is not one |
| the previous worker is never closed | *Timed out: the replaced worker drained and closed* |

## The automation relay, which is what the cutover turned on

A supervisor that is a **process** cannot hand a test the desktop's pipes, and three desktop specs
depend on exactly that. `native-updates`, `native-project-windows` and `native-token-e2e` pass an
`onDesktop` callback into `startRuntime`, take the child, and drive the window over its stdin and
stdout with the automation protocol — clicks, keys, state reads.

What made that work was worth noticing, because it was also the answer: **the supervisor and the
test were already two speakers on one stream, split by the sign of the id.** The control channel
numbers its requests DOWN from -1; the automation protocol numbers its own UP from 1; each ignores
what is not its own. In JavaScript they simply both attached a listener to the same pipes.

So the supervisor **relays** that stream rather than owning it. `GET /automation?owner=…` with an
`Upgrade` header, under `--inspect-ui` only, answers `101` and then carries newline JSON both ways:
every line the control channel did not ask for goes out unchanged, and every line that comes back
goes down the desktop's stdin under the same lock the channel's own writes take. Nothing is
interpreted on the way through — the other protocol is not this one's business. A running workspace
serves no such route at all.

The alternative — proxying each click as an HTTP call — was rejected: the automation protocol is
interactive and per-frame, and a route that exists only for tests and is slow enough to change what
they observe is worse than no route.

## The desktop layer, driven

`orchestrator/tests/fake-desktop.mjs` is a window as far as the supervisor is concerned: it
registers itself through the workspace, answers the control channel, exits 75 when told to reload
and 0 when told to close, and answers the automation protocol on the same stream. That is the whole
of what a supervisor requires of a window, and it is what lets the choreography be driven without a
built native binary.

With it, `supervisor-cutover.test.mjs` proves: a window opens and **`open-desktop` does not answer
until it has registered** (a supervisor that answered on spawn would hand a launcher a window that
may never arrive); the same binding is the same window rather than a second one beside it; the relay
carries the other protocol; a desktop-layer update tells it to reload, sees the 75, and brings it
back as a different process; and a window that detaches **on its own** — the person pressing its
update key — comes back too.

Two of those rules had no case until a sabotage of each passed, which is the shape
`docs/evidence/blind-regressions-2026-09-06.md` records:

- **Exit 75 read as a close** changed nothing, because a window that goes during an update is
  classified `Expected` and the update checks the code itself. The `Detached` classification is only
  reached by an UNSOLICITED 75 — so the fixture grew a `detach` op, and now it is.
- **A detach while an update is running** queued a second job with no complaint. Two `perform`
  threads would each believe they were the active one. It is driven now by declaring a slow desktop
  build, which holds an update in its prepare phase — where the window is not yet marked updating —
  and landing the detach inside that window.

The second one also settled a question the code did not answer out loud: the queued update then
**fails**, by name, because the desktop it was told to replace let go of its registration on the way
out. That is right rather than unfortunate — the person asked for the same window twice at once and
got the answer to the second ask.

## What this does not change

The supervisor keeps its protocol with everything around it: the descriptor's fields and its
`layeredUpdates` capability, the `/health` answer, the stdin control channel to the worker
(`{"type":"retired"}`, `{"type":"close"}`), exit code 75 as the desktop's "I detached for an
update", and the `RENGINE_*` environment a desktop is launched with. A port that changed any of them
would be a protocol change wearing a port's clothes.
