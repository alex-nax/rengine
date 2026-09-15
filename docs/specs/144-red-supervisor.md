# Spec 144 — red-supervisor: the layer that performs updates

Owner goal, 2026-09-15: *"finish remaining js"* (charter D57, spec 129; F159).

Status: **in progress.** The project-window store is Rust and judged against a frozen record of what
the JavaScript said. Nothing is deleted yet: a module retires with its caller, and the caller is the
supervisor process itself.

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

## The order the rest comes in

1. ~~**The window store.**~~ Done.
2. **The descriptor and discovery.** `checkConnection`, `runtime.json`, and the startup lock that
   makes two callers asking together produce one supervisor. Shares its shape with
   `launcher/sidecar.mjs`'s ensure path, which F159's third criterion asks be **one** implementation.
3. **The desktop child.** Snapshot, launch, the newline-framed control channel, `--plan`-style
   inspection. `runtime/desktop.mjs` and the `nativeControl` half of `runtime/windows.mjs`.
4. **The worker child and the job.** `startWorker`'s identity/capability check, `perform`'s ordering,
   and the recovery that is used once.
5. **The server.** Routes, forward, tunnel — `red_core::head` already frames all three, and
   `red-worker` is the working example of doing it against a child.
6. **The launchers.** `replace.mjs`'s process-table scan, `restart-supervisor.mjs`'s confirm prompt
   with no non-interactive bypass and its read-only `--plan`, `headless.mjs`, `bootstrap.mjs`.
7. **Cut over and delete.** `discovery.mjs` spawns the binary where it forks the module — the same
   fork-versus-spawn seam the supervisor itself grew for `red-worker` — and the eleven JavaScript
   files retire together, with their caller.

## What this does not change

The supervisor keeps its protocol with everything around it: the descriptor's fields and its
`layeredUpdates` capability, the `/health` answer, the stdin control channel to the worker
(`{"type":"retired"}`, `{"type":"close"}`), exit code 75 as the desktop's "I detached for an
update", and the `RENGINE_*` environment a desktop is launched with. A port that changed any of them
would be a protocol change wearing a port's clothes.
