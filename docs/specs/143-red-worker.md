# Spec 143 — red-worker: what the root-bound worker actually is

Owner goal, 2026-09-15: *"finish remaining js"* (charter D57, spec 129; F158).

Status: **the supervisor can run `red-worker`, and does not yet by default.** 15 of 17 routes are answered, both sockets are served, and the host's own stream is followed. Two things stand between here and the default: the project routes above a RETAINED host, and F154's two tracker routes.

## The measurement that shaped this

`runtime/worker.mjs` is 733 lines and reads like the biggest port left. It is not, because it is a
**dispatcher**: it serves 32 `/api/*` routes and **19 of them are already answered by `red-host`**.
They reach it by being forwarded. Of the 13 that are its own — 15, once the two `/api/tracker/*`
paths a slash-blind survey missed are counted — five sit on `red-token` and `red-ide`, crates that
exist. The feed itself has been `red_token::feed` since F157.

So this is a server around work that is already done.

## What makes it safe to port a route at a time

`serve::own_route` is the **contract**: the routes that are the worker's, checked against
`worker.mjs` by reading it. `serve::implemented` is **how far the port has got**. A route moves
between them when its evidence lands, and until then it is forwarded — so a half-ported worker
behaves exactly like the whole one, and the JS worker can be deleted on the day the two tables meet
rather than on the day a single enormous commit is reviewed.

## The routes, and what each still needs

| route | needs | state |
|---|---|---|
| `GET /api/feed` | the ledger service | **done** |
| `GET /api/token` | the ledger service | **done** |
| `POST /api/token-action` | the ledger service | **done** |
| `GET /api/agents-menu` | — | **done** |
| `POST /api/task` | — | **done**; the tracker is read back **through the door**, which answers a local one itself and forwards a remote one, so the worker needs none of its own |
| `POST /api/agent-spawn` | — | **done** |
| `POST /api/script-open` | — | **done** |
| `GET /api/diagnostics`<br>`POST /api/ide-mention`<br>`POST /api/ide-selection` | — | **done** |
| `POST /api/session-view`<br>`GET /api/runtime-desktops` | ~~the desktop registry~~ — **the door's** (below) | **done, and not here** |
| `POST /api/update-workspace` | — | **done** |
| six gated routes<br>(`/api/game`, `/api/stop`, `/api/agent-restart`, `/api/dashboard-run`, `/api/dashboard-capture`, `/api/desktop-action`) | — | **done** — the door answers, the worker gates |
| `GET /api/state`<br>`POST /api/preferences`<br>`POST /api/recording` | — | **done** — the door answers, the worker composes |
| `POST /api/tracker/signin`<br>`POST /api/tracker/signout` | **a TLS decision** — rustls, hyper and hyper-util are already linked through libp2p, but the workspace has no root-certificate store. Forwarded meanwhile, and the door forwards them to the backend, which serves both: the gap is a RETAINED host that is too old, which is what the worker's copy existed for | F154 |
| the `/feed` socket | — | **done** |

The four that landed together are one shape, and it is worth naming because the next ones are it
too: **resolve the project, ask the gate, do the work, tell the feed.** The gate is
`red_token`'s `gate` call — settle, note the caller, ask for the refusal, persist, in one round trip
rather than four — and a request with no agent header passes it, because the header is arbitration
among cooperating agents and the person at a desktop is never gated. A worker with no ledger also
passes, for the same reason an unidentified caller does: there is nothing to be refused *by*.

Two things are deliberately not the worker's:

- **The tracker read.** `POST /api/task` answers with the tracker as the write left it, and asks the
  door for it. The door answers a local tracker itself and forwards a remote one, so nothing here
  waits on F154's TLS decision.
- **Showing the pane.** `script-open` and `agent-spawn` both end by showing what they started, and
  that is the door's `/api/session-view` (above). A failure to show is REPORTED, never retried: the
  pane is already running and retained, so a caller that tried again would start a second one, and
  the answer says so in words.

## The two kinds of socket, and why the difference is the worker

`/feed` is served here because nothing else can serve it: one writer, one sequence. `/events` and
`/surface` belong to whoever answers the session routes, so they are tunnelled byte for byte — a
client that reached the worker for a pane's bytes gets the host's, and never a second opinion.

The feed's contract is the ORDER: **the subscription is taken before the replay.** A watcher that
subscribed first and replayed second would see a frame twice; one that replayed first without
holding the subscription would miss whatever happened in between. The watcher de-duplicates on the
sequence it has been sent, so the overlap is invisible and the gap is impossible.

That contract needed a case built for it. A test that waits for the replay to settle before writing
anything passes under either order — the evidence is a frame minted in the instant between the
socket opening and the history being read, which the correct order delivers and the reverse drops.

The fan-out's root filter needed one too, and for a subtler reason: **a sequence is per-ledger and
every ledger starts at 1**, so a stranger's frame carries a number the watcher has already passed
and its own de-duplication drops it whether the filter fired or not. The control masked the thing
under test. The other project is now run twelve frames ahead before anything crosses, and then
removing the filter costs the watcher its OWN next frame — because a stranger's higher sequence
advances the cursor past it.

## The third category the table missed

`own_route` and the forwarder look like a complete split, and they are not. There is a third kind of
route: one the **door answers** and the worker must not simply hand on.

The parity test above hides them by construction — it skips any route whose path appears in the
door's source, as "not the worker's". Six of those are still the worker's to **gate**. Stopping a
pane, restarting an agent, launching a game, running or capturing a dashboard action, reloading a
desktop: the door answers all of them and has no token gate of its own, and must not grow one
(spec 065). A worker that forwarded them unchanged would be a workspace with no arbitration at all,
and nothing about it would look broken.

Three more are **composed**: the door answers, and the worker adds to the answer.

| route | what the worker adds |
|---|---|
| `GET /api/state` | the capabilities having a worker adds, and the token window, which lives beside the ledger |
| `POST /api/preferences` | the window is kept beside the ledger; the rest goes to the store |
| `POST /api/recording` | the desktop's frame is a FEED frame, so it is the feed owner's however it arrives |

`serve::gated` is now the table, and `every_gate_the_javascript_worker_asks_for_is_asked_for_here`
reads `worker.mjs` for its `gate(req, …)` calls and requires each one to be in it. That test is what
found the gap; without it the cutover would have shipped a workspace whose token did nothing.

Three rules came out of writing them:

- **A pane route is gated on the PANE's project.** Only the pane's own record says which project it
  runs in; a caller's claim about it would let an agent gate itself against a project it is not in.
- **The ledger's three capabilities ride together.** `agentToken`, `taskWrites` and `agentSpawn` are
  all token-gated and all announce on the feed, so a worker with no ledger promises none — the
  caller is refused by name rather than calling a worker that would pass every gate because it has
  none (spec 078's asymmetry).
- **`projectGameLaunch` is the HOST's promise**, stripped and only repeated when the host beneath
  actually declared the game half. `projectGame` the worker does promise: the preflight is its own.

The recording route refuses in the opposite order from a token action, and both are the
JavaScript's: WHO before what here, because a frame from somebody who is not a desktop is theirs to
be refused rather than one this worker cannot mint; the other way round there, because a worker with
no ledger says so whoever is asking.

## What the registry decision left at the door, and what it retires

The desktop's view of the token lives on the desktop's socket, and that socket is the door's. So the
door attaches to the ledger service too — the worker owns the token's ROUTES, the door owns the
desktop's view of it:

- **The pinned segment**, pushed when a desktop registers and after every `token.*` frame. That is
  what lets the status bar never poll.
- **`token-action` on the socket**, which is the person at the desktop acting. A desktop has more
  actions than an agent does, so the ledger judges which; the door judges that the frame came from a
  registered desktop bound to the project it names.
- **`recording`**, because the recorder lives in the desktop (spec 081) and a capture frame is a
  feed frame.

An assign resolves an agent id against the conversations this project remembers, and a function does
not cross a socket — so what the worker's `lookup` would have answered is looked up at the door and
travels with the request.

**This retires spec 095's retirement relay.** It existed so a retired worker could keep pushing
segments to desktops it still held, by following the current worker's feed. With the registry and
the push at the door, a worker being replaced is not something a desktop can notice. That machinery
goes with `worker.mjs` rather than being ported.

The callback that hears a `token.*` frame cannot ask the ledger for the segment: it runs on the
service client's own reader, and a call from there would be the reader waiting for itself. It names
the project and a task does the asking.

**Closed:** `red_core::service::start_service` and `serve_binary`. `attaching` still only attaches —
deliberately, because two in-memory owners of one set of files is stale reads and lost writes — so
starting one is a separate act, and it is the WORKER's: the layer that owns the ledger's routes is
the layer that makes sure there is a ledger to own. The discipline is `service-client.mjs`'s, which
is the only thing that has ever started one of these, and a Rust process that started them
differently would be a second convention for the same file.

The one-per-directory rule turns out to be held twice: by the lock here, and by the service itself,
which refuses to be a second one. That means the lock's own evidence cannot be the descriptor — the
service's refusal leaves it looking right either way — so the test counts what actually RAN. What
the lock buys beyond the service's refusal is that no doomed process is spawned, a lock whose owner
died is reclaimed rather than blocking the survivor forever, and one held by a live process is
refused by name with nothing started.

## What the default cutover still needs

Turning the default on and running the suite named it exactly, which is what a cutover spec is for.

**The project routes above a retained host.** `worker.mjs` answers `/api/game-config`,
`/api/formats`, `/api/devices`, `/api/dashboard`, `/api/tracker`, `/api/worktrees`, `/api/bytes`,
`/api/recordings` and `/api/recording` **itself**, and never asks the host — because the host beneath
may predate them. That is the whole of spec 065 and KI-043's lesson, and `capabilities.projectGame`
is the worker's promise about it: *a routine workspace update must light the capability up*.
`red-worker` forwards them instead, so above a current door they are right and above a retained host
they answer from a host that never had them. Three specs say so — `games.test.mjs`,
`dashboard.test.mjs` and `hot-update.test.mjs` — and they are requirements, not obstacles.

The answer is not a second copy. `red-host`'s `routes::answer_about_project` is that composition
already and `red-project` is a dependency of both servers, so it moves into `red-project` and both
call it. One implementation, two servers — the same shape `bash_path` and `file_uri` took when the
same question came up smaller.

**F154's two.** `/api/tracker/signin` and `/api/tracker/signout` need a TLS client. They are
forwarded meanwhile, and above a current door the backend answers them.

And one spec's SUBJECT changes with the cutover rather than its outcome:
`token-retirement.test.mjs` drives the JS worker's relay, which the registry decision retires (above).
It goes with `worker.mjs`, and what replaces it is `worker-cutover.test.mjs`'s retirement assertions.

## The cutover

The supervisor spawns the binary. Three things differ between a forked module and a process, and
those three are all the supervisor hides — everything above it asks `alive()` and `tell()` without
knowing which it has:

| | `worker.mjs` | `red-worker` |
|---|---|---|
| started with | an IPC message | arguments |
| says it is ready by | an IPC message | one JSON line on stdout |
| told to retire or close by | an IPC message | one JSON line on **stdin** |

Stdin rather than a route, because retiring is control of the PROCESS and not of the workspace; and
rather than a signal, because there is no second signal on every platform this runs on. It is also
the shape this worker already speaks to its own children with.

**What retirement now means.** The ledger is a service (F157) and both workers attach to the same
one, so there is one writer and one sequence however many workers are alive — a retired worker needs
no hand-off and keeps answering everything it can, because its streams are still somebody's pane.
What it stops is **minting**: the worker that replaced it follows the same host stream, and two
minting on one ledger would put every transition on the feed twice. Its feed watchers are told where
to go, once, and its IDE bridge is released so `/ide` lists one editor again as soon as the
supervisor has switched.

**And a close waits for that to land.** The supervisor sends `retired` and `close` back to back; a
process that went away between them would leave every watcher with a dropped connection instead of
the sentence that tells it where to resume. Feed sockets still writing are counted, and a close
waits for them — bounded, because a client that has stopped reading must not keep a replaced worker
alive.

## The pair a game leaves on the feed

A game pane is the one thing here a person starts and then watches for minutes, so the feed carries
a **pair** for it and a monitor draws a session from the two. Three things make the pair
trustworthy, and each is a thing that actually happens:

- **The host announces the new session before the launch call returns.** So who asked cannot be
  looked up by session id at that moment. The asker is queued on the ROOT first and the frame takes
  the oldest still-fresh entry; a launch the door coalesced onto a session that was already running
  takes its own entry back, and a launch that was refused takes it back too — an entry left behind
  would attach to somebody else's game ten seconds later.
- **A worker can be replaced mid-game.** The open pairs are read back out of each project's ring
  rather than kept in a map that died with the last worker, so the `ended` half still lands and a
  monitor is not left with a game that never stopped. Anything no longer running gets its ending at
  startup: the pane may have stopped while there was no worker to hear it.
- **An `output` frame is never parsed into a session.** The rule is the EVENT TYPE, not the shape —
  a worker that read whatever a frame happened to contain would turn a pane's bytes into feed frames
  the moment one of them looked like a session. That is what makes "no PTY output on the feed"
  structural rather than a filter somebody can forget, and the test sends an `output` carrying a
  complete session object to say so.

`/api/game` is therefore gated AND composed: it has to queue the asker before it calls, so it is
answered here rather than gated on the way past.

The device-action pair (`device-action.started` / `.ended`) waits on `/api/dashboard-run`, which is
still forwarded all the way to the JS backend — the frame needs the action's declared device, which
is that route's own answer.

## What a caller follows this workspace by

Three shapes, and each is the difference between a caller that can follow the workspace and one that
can only ask it questions:

- **`/api/feed` carries `socket`.** `feed_url` composes a monitor's URL out of it, so a feed
  answered without one is a feed nothing can follow.
- **`/api/token` answers the STATUS**, with the caller and the refusal beside it — not a status
  nested inside one, which is the ledger service's shape and not the route's.
- **The conversations this project remembers are folded into the identity list.** The ledger learns
  an agentId only from a header on the wire, so a lane that has not called anything yet is invisible
  to `token_status` and un-nameable. They are never minted, never override one the ledger has
  actually seen, and are marked so a reader can tell the two apart (spec 097).

And the **generation**, claimed once per worker process on the first request that is not a `/health`
or `/api/state` probe. A candidate the supervisor prepares and then discards only ever answers those
two, so a worker that never served anybody never claims one — otherwise the layer above would watch
a workspace get replaced over and over by workers nobody used.

## The two children, and the ask between them

`red-lsp-serve` holds the language servers a project declares, one process per project root, started
the first time a file under it is asked about. `red-ide serve` is the bridge a CLI connects to. Both
belong to the WORKER rather than to the state directory: a replaced worker starts its own, because a
language server is a process somebody's editing session owns and not a workspace fact that outlives
it.

They speak the same shape — a request per line in, an answer per line out — so `pipe` is one client
for both. What makes it more than a command runner is the **ask**: when a connected CLI asks the
bridge for diagnostics, the bridge asks back, because the editor pane and `getDiagnostics` read one
store (D3). A client that only wrote and read answers would deadlock the first time a CLI asked.

Two rules are worth naming because both are a pane that silently never draws:

- **`since` is asked for by PRESENCE, not by value.** `Number(null)` is 0 and a version starts at 0,
  so a caller that omitted it was being told nothing had changed since a version it never held.
- **A delivery that reached nobody is a COUNT, not a refusal.** The desktop reports a selection on
  every cursor move; a refusal there is one a person sees constantly. A worker that could not
  publish an editor at all still serves everything else and says so on stderr — a workspace that
  refused to open because another editor held the lock would be a workspace nobody could open.

Doing this found a live bug. `red-lsp` keys its diagnostic store by the URI it computes when a file
is opened, and its copy of `pathToFileURL` kept `~` where Node encodes it as `%7E` — so a project
under a path with a tilde in it had no diagnostics at all, and nothing said why. The rule is now
`red_core::text::file_uri`, one implementation, read off Node character by character; `red-lsp` and
the worker both call it, and the worker's own test asserts the two agree rather than re-asserting
the characters.

Every route's work runs on `spawn_blocking`. A CLI's `--help`, a call to the door and a project's
own write command all block, and a runtime whose workers were all inside one would stop accepting
the connection that was waiting to be told so.

## The answer: the registry is the door's

Asked before the work, and the answer was already shipped: **`red-host` has held the registry since
F189.** It serves `/events`, and a desktop says it exists by sending a frame on that socket, so the
door is the only process that can know about one. There was never a second registry to build — only
two routes over the one that exists.

So the registry is the door's, and with it:

| route | was | is |
|---|---|---|
| `POST /api/session-view` | the worker's second registry | **the door's** — `answer_session_view` |
| `GET /api/runtime-desktops` | the worker's second registry | **the door's** — `Desktops::registry` |
| `POST /api/update-workspace` | listed here as the registry's | **the worker's** — it never touched the registry; it is the token GATE and a forward, and the table above had it in the wrong row |

Two things followed from actually doing it, and both were latent gaps rather than new work:

- **`act` carried no payload.** A reload needs none — the desktop knows how to rebuild itself — so
  the one that shipped took only an action name. An attach is nothing without the session: a desktop
  told only an id would have to ask for the record back, and the one thing it must not do between
  being asked and answering is make another round trip.
- **A refusal was not remembered.** Spec 098's launcher waits for a window and has to name the
  reason one never appeared. The JS worker kept that beside its registry; the door now does, cleared
  by the next registration that succeeds, because a stale reason is worse than none.

What this buys beyond two routes: the JS worker's registry existed so it could push the pinned token
segment to a desktop over a socket it owned, and that is the whole reason spec 095's retirement has
a **relay** — a retired worker following the current worker's feed to push frames to desktops it
still holds. With the registry at the door, the desktops never belonged to a worker in the first
place, and a worker being replaced is not something a desktop can notice. That machinery retires
with `worker.mjs` rather than being ported.

While the sockets were being served, the forwarder was found reading each answer to end-of-
connection rather than by its own framing — so every forwarded route waited out the host's
keep-alive, and nineteen of them are forwards. It now frames the answer the way the door does. In
the suite that is 12 seconds a test to 15 milliseconds.

Evidence: `orchestrator/tests/red-host.test.mjs`, in the F189 registry test — the two routes
against the JS `Desktops` while it is still the record of what the answers are. Three sabotages,
each rebuilt before its run (KI-120): an attach frame with no session record, the pane's root read
from the caller's claim instead of the record, and a refusal that is never cleared.
