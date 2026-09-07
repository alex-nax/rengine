# Live capability updates for a running workspace (F97)

Date: 2026-09-07. Status: recorded from owner direction, given after being told on several occasions that
layered updates were in place and then finding that a new route could not reach the running editor at
all. Parent: [spec 065](065-layered-workspace-updates.md), which made the session host a retained layer
and the workspace worker the replaceable one. Related: [spec 078](078-project-game-declaration.md) and
KI-043 for the lesson this repeats, [spec 083](083-task-tracking.md) for the routes used as the proof,
[spec 098](098-replace-session-host.md) for the deliberate host replacement this does **not** need.

## What was measured before anything was written

Everything below was read from the live machine, read-only, on 2026-09-07 around 12:40.

| Probe | Answer |
| --- | --- |
| Session host `main.mjs --state .cache/orchestrator-development`, PID 33465, since 2026-09-06 00:03 | `GET /api/state` capabilities `{handoff: 1}`; 17 retained sessions across 3 roots; `GET /api/tracker?rootId=…` → `404 Unknown workspace endpoint.` |
| `.cache/runtime/e9c3dbfd-…/runtime.json` | names supervisor PID 44390 (`runtime/supervisor.mjs`, since 2026-09-06 10:28) bound to that host's instance, at `127.0.0.1:60742`, `connectorGeneration: 11` |
| Supervisor `GET /api/update-status` | workspace worker PID 79969 (`runtime/worker.mjs`, started 2026-09-06 23:22 by the last `workspace`-layer job), one managed desktop PID 88067 |
| Desktop PID 88067 (`--control`, launched by the supervisor at 12:34 today) | `RENGINE_WORKSPACE_URL=http://127.0.0.1:60742` — the owner's editor talks to the supervisor, which forwards to the worker, which forwards what it does not serve to the host |
| Worker `/health` | `{"protocol":1,"worker":79969}` |
| Supervisor `GET /api/state` capabilities | `handoff, desktopActions, layeredUpdates, scriptActions, formatRegistry, dashboard, projectGame, recordings, projectDevices, projectWindows` — no `tracker` |

So the premise "no worker serves this workspace" was wrong: the layered mechanism is installed and has
been used eleven times on this host. What is true is narrower and worse. The tracker routes (`GET
/api/tracker`, `POST /api/tracker/signin`, `POST /api/tracker/signout`) were added to
`orchestrator/server/main.mjs` — the host — and nowhere else. The worker forwards any route it does
not serve to the retained host, and the retained host is a process from before the routes existed.
No number of `update_workspace` calls can change what that host answers. This is KI-043 again, with a
different route: **a capability served only by the retained host cannot be delivered by a layered
update**, and every route that needs no PTY, no surface and no store state belongs in the worker.

### The connectors bound to this host

Three kinds of MCP server process are alive against the same host, and they differ in what can be done
for them. `mcp.mjs` became a stable facade over a replaceable `mcp-worker.mjs` in `fffc0be` (2026-09-06
08:26); before that it was one process with eight tools.

| Kind | Processes (parent CLI) | What it can do |
| --- | --- | --- |
| Pre-facade, eight tools (`workspace_info, list_files, list_sessions, read_file, session_output, stop_session, nolf_preflight, launch_nolf`) | 93041 under `claude` 92680 (2026-09-06 08:06); 20159 under `codex` 20121 (2026-09-06 07:37) | Nothing. The code it runs was loaded before the facade existed and has no refresh path. Spec 065 said so: *"An existing connector loaded before this mechanism cannot retroactively acquire new tools."* The CLI must reconnect the server (below). |
| Facade + worker | 27212/27238 under `codex` 27046; 52144/88078 under `claude` 52094 (nolf-improved root); 11302/80386 under `claude` 11225 (vtmb-vr root) | Replaces its tool worker when `connectorGeneration` changes and sends `notifications/tools/list_changed`. Before this spec it noticed the change only on its next request. |

### What the clients do with `notifications/tools/list_changed`

- **Claude Code 2.1.263** (installed): the documentation states *"When an MCP server sends a
  `list_changed` notification, Claude Code automatically refreshes the available capabilities from that
  server"* (support arrived in 2.1.0; before 2.1.214 a failed refresh emptied the list). Measured here
  as well, not taken on trust: a throwaway server that registers `step_two` inside the call to
  `step_one` and sends the notification was driven by `claude -p --model haiku`; the wire log shows a
  second `tools/list` in the same millisecond as the notification and `tools/call step_two` three
  seconds later, **in the same turn**, and the reply was `step_two`'s text. Its `/mcp` menu has
  **Reconnect** per server, which respawns the server command — for a pre-facade connector that is the
  only way to a current tool set, and it costs neither the conversation nor the pane.
- **Codex 0.153.4** (installed): does not refetch `tools/list` on the notification. openai/codex issues
  #10105 (feature request, 2026-01), #19155 and #33266 (2026-07, reporter on 0.144.1, open at the time
  of writing) all describe the same thing: the notification is parsed and ignored. A Codex session
  therefore never sees a new tool *name* until the CLI is restarted. It does see new *behaviour* behind
  an existing name, because the facade forwards calls by name to the current worker.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | The tracker routes are served by the workspace worker from its own checkout, importing `server/tracker.mjs` and `server/tracker-auth.mjs`; the worker advertises `tracker: 1` itself. The host keeps serving them for a caller that reaches it directly, exactly as `game-config` is shared. | Recommended; KI-043 applied |
| 2 | The worker learns the host's state directory from the host's own `/api/state` (`stateDir`, new in this spec) when the host says it, and otherwise from the process table: the `main.mjs --state DIR` row whose `DIR/sidecar.json` names the host's **instance**. The URL is never the key — the worker may be given a proxy's URL — and the first host row is never taken on trust, because this machine runs a dozen. A worker that finds neither serves the local backend and says why a remote one cannot be read, rather than reporting "not signed in" about a token it never looked for. | Recommended |
| 3 | The facade watches the runtime descriptor (`runtime.json` mtime, polled once a second on an unreferenced timer) and refreshes its worker when the connector generation changes **without waiting for a request**, then sends `list_changed`. A CLI that honours the notification has the new list before its next turn; before this, the first call after an update went to a worker chosen for the previous generation. | Recommended |
| 4 | A call naming a tool the current worker does not have is answered with the way back, not the SDK's bare `Tool X not found`: the connector generation, the current tool names, and that Claude refreshes on the notification while Codex must be restarted. | Recommended; the owner asked for a useful error from a stale tool |
| 5 | `list_tasks` is the MCP tool behind the tracker, gated on `tracker: 1`, read-only, so an attached agent has a concrete new capability to observe arriving. | Recommended |
| 6 | The host's `/api/state` says `stateDir`. This is the minimum host change for next time: a worker above a host started from this checkout needs no process table to find the state directory. It cannot help the running host, which is the point of decision 2. | Recommended |
| 7 | The path that delivers this to the owner's running editor and connectors, once merged to `main`, is the existing one: `node orchestrator/runtime/client.mjs update --context "$RENGINE_WORKSPACE_CONTEXT" --layers workspace,connector` from any pane shell (the variable is in every pane's environment), or `update_workspace` from a facade connector. No host restart, no supervisor restart, no session stopped. | Spec 065's own fallback; restated because it was not used |

## What is genuinely impossible without a restart of something

Stated plainly, so nobody is told a third time that something works when it does not.

- **A pre-facade MCP server process cannot be changed.** PIDs 93041 and 20159 will answer the eight
  old tools until they exit. The Claude session reconnects it from `/mcp` (Reconnect) and keeps its
  conversation and pane; the Codex session restarts its CLI in the pane (`codex resume <id>`). Neither
  touches the host, the supervisor or any retained session.
- **A Codex session cannot gain a new tool name without restarting Codex.** That is the client, not
  rEngine. It gains new behaviour behind stable names (`update_workspace`, `update_status`,
  `workspace_info` are stable since `ca44dd5`), and the stale-tool answer of decision 4 tells the model
  what happened.
- **Supervisor routes** (`/api/update-status`, `/api/project-windows`, `/api/open-desktop`, and the
  capabilities the supervisor adds: `projectWindows`) change only with a supervisor restart. That
  closes the managed desktop windows — the supervisor kills its children on the way out — while every
  session stays running on the host and the windows reopen against the same host. Cheaper than a host
  replacement, not free; nothing in this spec needs it.
- **Host state cannot move**: PTYs, the store (`/api/tree`, `/api/file`, `/api/save`, drafts, layout,
  roots), the `/events` fan-out, `/api/terminal`, `/api/game`, `/api/agent-restart`,
  `/api/agent-conversation`. A capability that needs them (`agentConversations` today) reaches a
  running workspace only through `--replace-host` (spec 098), which ends the sessions.
- **The desktop's `/events` socket stays on the worker it was opened through** (spec 065 lets streams
  finish where they started), so a replaced worker's event-side behaviour reaches an open desktop only
  when that socket is reopened. HTTP requests — the tracker fetch, sign-in — go to the current worker
  at once.
- **Whether a refresh lands within the current turn is the client's affair.** With 2.1.263 it did
  (above); older reports (anthropics/claude-code #13646 on 2.0.65) describe the list refreshed only for
  the next turn. Decision 3 makes the point moot for an idle agent, which is the common case: the
  notification is sent when the update lands, not when the agent next speaks.

## Verification

| Check | Establishes |
| --- | --- |
| `hot-update.test.mjs` — the tracker above a retained host | a real `main.mjs --state DIR` child host behind a proxy that answers `/api/tracker*` with `404 Unknown workspace endpoint.` and strips `stateDir` (the live host's shape); the real supervisor and worker above it answer `GET /api/tracker` with the local rows and advertise `tracker: 1`; `POST /api/tracker/signin` names that host's `trackers/oauth.json`, proving the directory was found through the process table; `list_tasks` returns the same rows through the real facade |
| `hot-update.test.mjs` — a host that says where its state lives | an in-process host (no process-table row at all) still yields a worker whose sign-in names the right directory, because `/api/state` carries `stateDir` |
| `hot-update.test.mjs` — the descriptor's instance is the key | with two hosts in the table, the one whose `sidecar.json` instance matches is chosen even when it is not the first row and the worker was handed a proxy URL |
| `hot-update.test.mjs` — an idle facade | after `update-workspace {layers: ['connector']}` issued directly to the supervisor, with **no** request through the facade, `notifications/tools/list_changed` arrives, `tools/list` then shows the new worker's tools (`list_tasks` present, the old worker's tool gone) and `update_status` reports a new tool-worker pid |
| `hot-update.test.mjs` — a stale name | calling the old worker's tool after the switch is refused with the generation, the current tool names and the client guidance |

Each regression is verified by breaking the implementation in the specific way the test claims to catch,
observing that only its own assertion goes red, and restoring; the sabotages and what they produced are
recorded in `docs/evidence/live-capability-updates-2026-09-07.md`.

**Live, against PID 33465, read-only:** a worker from this checkout started in-process against the
running host answers `/api/tracker` for all three roots and names the live state directory in the
sign-in setup, while the same route through the live supervisor still returns the host's 404; a
supervisor, worker and facade from this checkout started in a scratch runtime directory against the
same host offer `list_tasks` and deliver a `connector` update to an idle facade. No process of the
owner's was signalled, stopped or restarted, and nothing was written under the workspace state.

**Not done here, deliberately:** merging to `main` and running the update on supervisor 44390. The
supervisor forks `orchestrator/runtime/worker.mjs` from the main checkout's working tree, which other
lanes are editing at the time of writing; the first live run belongs to whoever merges, with the
command in decision 7.
