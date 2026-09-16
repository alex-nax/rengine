# Spec 144 — red-supervisor: the layer that performs updates

Owner goal, 2026-09-15: *"finish remaining js"* (charter D57, spec 129; F159).

Status: **done, and `runtime/supervisor.mjs` is deleted.** `ensureRuntime` starts `red-supervisor`;
every suite that drove the module drives the binary, including the four desktop specs. What is left
of F159 is the launchers — `replace.mjs`, `restart-supervisor.mjs`, `headless.mjs`, `bootstrap.mjs`
— which are their own commands rather than this layer.

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

`tests/desktop-launch-corpus.json` is the record, and it is taken by launching a real
child through the real `launchDesktop` and asking it what it received — which is the only way to
record an absence, because the object handed to `spawn` cannot show one. Six sabotages, including
the two that collapse an absence into an empty string.

## The record

`tests/window-store-corpus.json` — 47 cases, run as **one sequence against one store**
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
7. **The launchers.** `replace.mjs`'s **decisions** are `red_supervisor::replace` (below); what is
   left of it is the orchestration, which waits on a Rust `ensureSidecar`. Then
   `restart-supervisor.mjs`'s confirm prompt with no non-interactive bypass and its read-only
   `--plan`, `headless.mjs`, `bootstrap.mjs`.
8. ~~**Cut over and delete.**~~ Done: `ensureRuntime` spawns the binary, and
   `runtime/supervisor.mjs` (434), `runtime/windows.mjs` (109) and `runtime/desktop.mjs` (47) are
   gone with the two record tests whose subject they were (F173). `runtime/protocol.mjs` stays until
   `discovery.mjs` does, which is the same rule: a module retires with its CALLER.

## One service per directory, and the race that was not

F159's third criterion asks for **one** ensure path. `red_core::descriptor::ensure` is it: take a
lock, spawn, wait for the thing to publish itself. Two callers asking together get one process.

Writing it found a live defect in shipped Rust. A lock file is **created and then written**, so for
an instant it exists and names nobody — and `service::start_service` read that as "nobody holds it",
removed the winner's lock while the winner was still spawning, took it, and spawned a **second
service**. The token ledger, the PTY service and the store all start through that path. Only a lock
that is readable and names a process that is **gone** is reclaimed now; an unwritten or unreadable
one means somebody is starting.

The JavaScript did not have this bug — it caught `SyntaxError` separately from "missing" and waited
— and the port had flattened the two into one `.ok()`. Driven by two callers in one process, and
sabotage-verified three times running.

## The third criterion, met

F159 asks that *"the sidecar request/ensure path the remaining Rust binaries use is one shared
implementation."* There were **four** copies of "is this descriptor mine, and is its process alive?"
in the Rust tree. There is one:

- `red_core::descriptor` is the implementation, with `red_core::http` underneath it and
  `descriptor::ensure` as the start path.
- `red-mcp`'s private copy is gone, and it had a real defect: it asked the process table by
  **shelling out to `kill -0`**, which reports a live process the caller may not signal as *dead*.
  Every agent pane's tool routing went through that check.
- `service::start_service` uses `descriptor::ensure` instead of its own lock loop — which is how the
  race above was found.
- `red-agents::bind` uses it too, and its copy was the **weakest**: it asked `/health` and threw the
  answer away, so it would have bound an agent to anything answering on that port. `red-agents` takes
  the `red-core` dependency its manifest had avoided; the note there says why, and no binary in the
  crate grew when it did. Measured before taking it, not after.

That last one had no case until a sabotage of it passed. It has one now: a state directory whose
descriptor points at a live host and claims another instance — the shape a stale descriptor takes
when a port is reused — and binding refuses it by name.

## What this does not change

The supervisor keeps its protocol with everything around it: the descriptor's fields and its
`layeredUpdates` capability, the `/health` answer, the stdin control channel to the worker
(`{"type":"retired"}`, `{"type":"close"}`), exit code 75 as the desktop's "I detached for an
update", and the `RENGINE_*` environment a desktop is launched with. A port that changed any of them
would be a protocol change wearing a port's clothes.
