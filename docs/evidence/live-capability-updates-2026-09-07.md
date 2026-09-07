# Live capability updates — macOS, 2026-09-07

F97, spec 100. Branch `feat/live-hot-update`, cut from local `main` at `8bd0aab` in the worktree
`.claude/worktrees/agent-ae5d37dac407a7432`. No process of the owner's was signalled, stopped or
restarted; nothing was written under the workspace state directory; `update_workspace` was not run on
supervisor 44390.

## What was measured before writing anything

All read-only, around 12:40.

| Probe | Answer |
| --- | --- |
| `ps` | host `main.mjs --state /Users/alex/rengine/.cache/orchestrator-development` PID 33465 since 2026-09-06 00:03; supervisor `runtime/supervisor.mjs` PID 44390 since 2026-09-06 10:28; worker PID 79969 under it since 2026-09-06 23:22; desktop PID 88067 (`--control`) under it since 2026-09-07 12:34 |
| `.cache/runtime/e9c3dbfd-…/runtime.json` | pid 44390, host `127.0.0.1:64556` instance `e9c3dbfd…`, url `127.0.0.1:60742`, `connectorGeneration: 11` |
| desktop 88067 environment | `RENGINE_WORKSPACE_URL=http://127.0.0.1:60742` (the supervisor), `RENGINE_WORKSPACE_CONTEXT=…/integrations/046c207b-….json` |
| host `GET /api/state` | capabilities `{handoff: 1}`, no `stateDir`, 17 sessions, 3 roots |
| host `GET /api/tracker?rootId=…` | `404 {"error":"Unknown workspace endpoint."}` |
| supervisor `GET /api/state` | capabilities `handoff, desktopActions, layeredUpdates, scriptActions, formatRegistry, dashboard, projectGame, recordings, projectDevices, projectWindows` |
| supervisor `GET /api/update-status` | workspace pid 79969, last `workspace` layer job `999b2ed9` at 2026-09-06 23:22, ten `desktop` layer jobs since, all succeeded |
| MCP servers against this host | 93041 (pre-facade, under `claude` 92680), 20159 (pre-facade, under `codex` 20121), 27212+27238, 52144+88078, 11302+80386 (facade + worker) |
| `git show bdae7a3:orchestrator/agents/mcp.mjs` | the pre-facade file: exactly `workspace_info, list_files, read_file, list_sessions, session_output, nolf_preflight, launch_nolf, stop_session` |
| Claude Code 2.1.263 | documentation: refreshes on `list_changed` (2.1.0+; before 2.1.214 a failed refresh emptied the list); `/mcp` → Reconnect respawns a server |
| Codex 0.153.4 | binary carries the notification's name only as a serde constant; openai/codex #10105, #19155, #33266 (open, 2026-07): not acted on |

## The live probe, from this checkout, after the change

`.cache/live-probe/probe.mjs` (not committed), against host 33465 with the owner's integration context.

| Step | Result |
| --- | --- |
| host `GET /api/state` | unchanged: `{handoff: 1}`, `stateDir: null`, 17 sessions |
| through supervisor 44390 (worker generation 11) `GET /api/tracker` | **404 `Unknown workspace endpoint.`** — the defect, still there because the live worker is from 23:22 yesterday |
| `startWorker(host)` from this worktree, in-process | capabilities `… projectDevices: 1, tracker: 1` |
| that worker `GET /api/tracker` rEngine root | `provider: local`, 50 rows, first `F32 ready/unstarted` |
| nolf-improved root | `provider: local`, 1315 rows |
| vtmb-vr root | `provider: local`, 526 rows |
| that worker `POST /api/tracker/signin` rEngine root | `ok: false`, setup step 3 names `/Users/alex/rengine/.cache/orchestrator-development/trackers/oauth.json` — the live state directory, found from the process table by instance, since the host does not say it |
| `startRuntime` from this worktree in a scratch directory above the same host | runtime.json with `connectorGeneration: 1`, `toolWorker: …/orchestrator/agents/mcp-worker.mjs` |
| facade (`agents/mcp.mjs` from this worktree) `tools/list` | 27 tools, `list_tasks` among them |
| facade `list_tasks` | the same 50 rows |
| `update-workspace {layers: ['connector']}` to the scratch supervisor, then nothing through the facade | job succeeded in 166 ms; `tools/list_changed` arrived at the idle facade **914 ms** later; `update_status` then reports generation 2 and a new tool-worker pid (93981 → 93997) |
| facade `launch_nolf` (the name the owner's pre-facade connector still lists) | `isError`, "launch_nolf is not in this workspace’s current tool set (connector generation 2) … Current tools: … Claude Code refreshes on tools/list_changed … Codex does not …" |
| host `GET /api/state` afterwards | 17 sessions, 9 running — as before |

## Does the installed Claude CLI act on `tools/list_changed`?

Not taken from the documentation alone. A throwaway MCP server (scratchpad, not committed) starts with
`step_one`; calling it registers `step_two` and sends the notification; every method reaching the
server is logged with a timestamp. Driven by `claude -p --model haiku --mcp-config … --strict-mcp-config
--allowedTools mcp__probe__step_one mcp__probe__step_two`, prompt on stdin, from a shell with the
nested-session variables cleared. The reply was `SECOND_TOOL_ANSWERED_7731`, and the wire log:

```
11:23:30.804Z request tools/list
11:23:35.639Z request tools/call
11:23:35.640Z call step_one
11:23:35.641Z sent tools/list_changed
11:23:35.641Z request tools/list        ← re-listed in the same millisecond
11:23:38.632Z request tools/call
11:23:38.632Z call step_two             ← same turn
```

Claude Code 2.1.263 refreshes on the notification and used the new tool in the same turn. Codex was
not probed here; its behaviour is documented by its own open issues (spec 100).

## Failing first, then the sabotages

Before the implementation, `hot-update.test.mjs` was red for its own reasons: test 1 at `capabilities.tracker` (`undefined !== 1`), test 2 at the missing `stateDir`, test 4 at "first generation" (the facade ran the checkout's worker, not the probed file). Test 3 is the unit the others rest on and was green from the start, so it was verified by sabotage only.

Every sabotage was applied by a runner that backs the file up, applies one replacement, runs the one test and restores; the working tree was confirmed clean of markers after each.

| # | Test | Sabotage | Red for |
| --- | --- | --- | --- |
| S1 | tracker above a retained host | the worker keeps advertising `tracker: 1` but forwards `GET /api/tracker` to the host (KI-043's exact shape) | `error: 'Unknown workspace endpoint.'` at the route request, after the capability assertion passed |
| S2 | a host that says where its state lives | `stateDir` dropped from the host's `/api/state` | the host-level assertion — **masked**: the worker-level one was not reached |
| S2b | same | same sabotage with the host-level assertion lifted | `The workspace state directory is unknown to this worker: the session host does not say where its state lives, and no main.mjs --state process serves instance 7d61858f-…` from the sign-in route |
| S3a | keyed by the descriptor instance | the URL compared instead of the instance | `stateDir: null`, reason names the instance (the worker holds a proxy's URL) |
| S3b | same | the first host row taken on trust | `stateDir: …/b`, `pid: 100` instead of `…/a`, `pid: 200` |
| S4 | an idle facade | the descriptor watcher no longer refreshes | `Timed out: tools/list_changed reaching an idle facade` |
| S5 | a stale name | the facade passes the SDK result through | `actual: 'MCP error -32602: Tool old_tool not found'` against the guidance regex |
| S6 | first generation | the facade runs its sibling worker instead of the probed file | `first generation: workspace_info, …, list_tasks, …` — `old_tool` absent |

## One existing test changed, and why

`runtime.test.mjs` breaks its tool-worker wrapper file on disk to prove a failed probe keeps the
previous worker, then kills that worker to prove a crash is recovered on the next request. The facade
now recreates a crashed worker from the file the supervisor published — that wrapper — so the recovery
step ran broken code and failed with `SyntaxError: Unexpected identifier 'is'`. The wrapper is restored
before the kill: a crash while the file is still broken is the source edit's failure, not recovery's,
and the assertion the step makes (a new pid after a crash) is unchanged.

## Gates

Recorded in `Codex-progress.md`, session 52.
