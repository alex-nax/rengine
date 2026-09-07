# Replacing a workspace's session host on purpose (F94)

Date: 2026-09-07. Status: recorded from owner direction, given after three restarts of the hirebase-v2
workspace changed nothing they could see. Parent: [spec 065](065-layered-updates.md), which made the
session host a retained layer and said only that replacing it "requires quiescence" without saying how
a person reaches that state. Related: [spec 090](090-headless-workspace-start.md) for the launcher
shape, [spec 096](096-agent-session-resume.md) and [spec 097](097-agent-conversation-persistence.md)
for the two changes the owner could not see.

## The situation it answers

The hirebase-v2 session host (`orchestrator/server/main.mjs --state ~/.local/state/redit/hirebase-v2`,
PID 68944) has run since 09:16:13. Between then and 11:23 three pieces of work merged into `main`: the
`NO_COLOR` drop in 096, conversation persistence in 097, and the Linear tracker with its browser
sign-in. The owner restarted the workspace three times and saw none of them, because a Node process
holds the modules it imported at start and every restart reused the same process. Measured against the
live host, read-only, before anything was written here:

| Probe | The 09:16 host answers | The checkout would answer |
| --- | --- | --- |
| `GET /api/tracker?rootId=…` | `404 Unknown workspace endpoint.` | the tracker rows, or `Not signed in to Linear.` with a sign-in offer |
| `GET /api/state` capabilities | no `agentConversations`, no `conversations` key | both |
| `GET /api/dashboard?rootId=…` | `$ has unknown key tracker` — **the whole declaration refused** | the dashboard groups |

The third row is the one nobody predicted. `formats.mjs` reads `contracts/project-v1.schema.json` once
at module load, so the schema is frozen in the host's memory too; when the declaration gained a
`tracker` block at 11:11 the old host began refusing the entire file, and with it the dashboard and
formats for that root. That is not a tracker bug. It is the same staleness, reaching a surface that had
worked in the morning.

Three facts make this a product defect rather than a person forgetting a step.

1. **The host survives everything by design.** It is spawned detached (its parent is init), it
   outlives the window, the desktop and the agent, and spec 065 forbids the update path from
   restarting it. All of that is right: it is what keeps a PTY alive across a desktop rebuild.
2. **The launcher reuses it, silently.** `ensureSidecar` discovers a live descriptor and returns it.
   Re-running the generated `hirebase-v2.command` therefore starts a fresh desktop against the same
   old host and prints nothing about the host's age.
3. **The obvious hand remedy does not work on macOS, and says nothing.** `pkill -f main.mjs` typed in
   a pane inside the workspace matches nothing, because that pane's shell is a descendant of the host
   and macOS `pgrep`/`pkill` exclude the caller's own ancestors by default — `man pgrep`: "`-a` Include
   process ancestors in the match list. By default, the current pgrep or pkill process and all of its
   ancestors are excluded." Verified here: `pgrep -f server/main.mjs` lists thirteen other hosts and
   not 68944; `pgrep -a -f server/main.mjs` lists it; `ps -A -ww -o pid=,ppid=,command=` shows it
   plainly. `pkill` exits 1 for no match and prints nothing, so the incantation looks like it ran.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | Replacement is an **explicit launcher flag**, `--replace-host`, on `orchestrator/launch.mjs`. The generated `.command` forwards unknown flags, so the single command for the owner's workspace is `~/hirebase-v2.command --replace-host`, with the project, declaration and state directory already bound. It works with `--headless` too. | Owner ("a supported way ... so this never again requires an incantation"); the flag over an `actions/` script because the launcher is the thing people already run |
| 2 | The host is found through **its own descriptor and the process table, never `pgrep`**. `sidecar.json` names the PID; `ps -A -ww -o pid=,ppid=,command=` confirms that PID is `server/main.mjs --state <this directory>`. A PID that is not a session host, or that serves another state directory, is **refused by name and nothing is signalled**. `pgrep`'s ancestor exclusion is exactly the trap; a tool that used it would inherit the trap. | Recommended; the refusal is what keeps vtmb-vr's and nolf-improved's hosts safe when they share the machine |
| 3 | The launcher **refuses to replace the host it runs inside.** If the host PID is among the launcher's own ancestors, a pane inside the workspace is asking to end itself half-way through; the message says to run it from a terminal outside rEngine. | Recommended; the same ancestry that defeats `pkill` |
| 4 | **Supervisor first, then host; graceful, then forceful.** The update supervisor bound to the host's instance is found through its `runtime.json` (host identity matched, PID confirmed as `supervisor.mjs`) and receives `SIGTERM`, which closes its desktops and workers; then the host receives `SIGTERM`, which stops its sessions; each gets `SIGKILL` only if it ignores the first signal past a deadline. Direct children of a force-killed host are swept. Stopping the supervisor first means nothing tries to recover a worker against a dying host. | Recommended |
| 5 | The old port must be **confirmed released** before a new host starts: a connection to the descriptor's URL must be refused. The stale descriptor is removed only then, so `ensureSidecar` cannot mistake a reused PID for the old host. | Recommended |
| 6 | The new host starts through **`ensureSidecar` from this checkout**, the same path a normal start uses, so the replacement is the ordinary host and not a special one. | Recommended |
| 7 | The report says **what was stopped and what was started**: the old PID, instance, URL and start time; each running session that ended, by type and title; every process signalled and how it went; the new PID, instance and URL. Conversations are persisted (097), so the ended agent panes are resumable from the pane. | Owner ("report clearly what it stopped and started") |
| 8 | A normal start **says when the host is older than the code.** If `sidecar.json` (written at host start) is older than the newest file under `orchestrator/server`, `orchestrator/launcher`, `orchestrator/agents`, `scripts` or `contracts`, the launcher prints which file changed and names `--replace-host`. It never replaces on its own: a retained host holds live sessions, and ending them is the person's call. | Recommended; turns the silent no-op into a sentence |

## What a replacement leaves behind (KI-064)

Decision 4 ends the old host's sessions on purpose. What it cannot end is the **desktop's saved
layout**, which lives in the workspace store (`<state>/workspace.json`) and outlives every process:
its tabs still name the session ids of the host that is gone. The first thing a desktop does against
the new host is restore that layout and register the bindings it restored, so **the first
registration after `--replace-host` advertises sessions the new host has never heard of.**

Measured twice on 2026-09-07, on two different projects (rEngine's own workspace, and hirebase-v2
replaced at 12:22): the saved layout named six session ids, four of them the dead host's.
`Desktops.register` validated each with `sessions.snapshot(id)`, which fails `Unknown session.` (404)
on the first stale one, so the **whole** registration was refused — the host answered
`{ type: 'error', error: 'Unknown session.' }` and the desktop, whose `desktop_registered` flag is set
by a successful *send*, never retried. `GET /api/desktops` answered `[]` while the desktop ran; the
supervisor's `waitView` never saw the view in `runtime-desktops` and gave up with "Replacement desktop
did not register before timeout."; the runtime supervisor exited with an empty `runtime.log`, because
that failure travels over IPC and never reaches the file. The workspace came back with **no runtime
layer at all** — no layered updates, no desktop actions, no token ledger — and on one of the two
machines the desktop process was gone with it. The same desktop binary registered normally as soon as
its layout named no stale session.

So a registration that names sessions the host does not have is not an invalid frame. It is the
expected first frame after a deliberate replacement, and all three layers have to agree on it:

| Layer | What it does | When a live workspace gets it |
| --- | --- | --- |
| **Host** — `server/desktops.mjs`, `Desktops.register` | Drops ids `sessions.snapshot` answers 404 for, keeps the different-root refusal for ids the host *does* have, keeps `Invalid desktop bindings.` for a malformed frame, registers the desktop, and names the dropped ids as `unknownSessions` in the `desktop-registered` frame. | **Only at the next `--replace-host`.** A Node process holds the modules it imported at start (the premise of this whole spec), so the running host keeps the old `Desktops` until it is replaced. |
| **Worker** — `runtime/worker.mjs`, the `desktop-register` interception | `withoutEndedSessions` filters `sessionIds` against the `/api/state` it just refreshed and hands the removed ids to `Desktops.register` as `dropped`, so they reach the desktop in the same frame. The worker also remembers the last registration it refused and publishes it on `/api/runtime-desktops`. | **At the next `update_workspace`** — this is the replaceable layer, so it reaches a running workspace without touching the host or its PTYs. |
| **Desktop** — `native/app.c`, `register_desktop` | Advertises only session ids present in the `state.sessions` it already holds (fetched by `OP_STATE` before registration). A restored tab whose session is absent is marked ended: it is not attached to anything, `re_app_inspect` reports `sessionEnded`, and the status bar says how many views are in that state and that Sessions offers the conversation back (spec 097/099). No new widget — the tab stays where the person left it. | **At the next desktop reload/update.** |
| **Supervisor** — `runtime/supervisor.mjs`, `waitView` | On timeout, names the last registration a worker refused and what the desktop process printed, instead of only that it did not register. | With the worker layer. |

The layers are deliberately redundant: each is reachable on a different schedule, and the one that
reaches a running workspace soonest (the worker) is not the one that owns the store (the host).

## What this does not do

It does not replace the host automatically, ask a confirmation question, or offer the action over
MCP — an agent inside the workspace is a descendant of the host by construction and would be refused by
decision 3. It does not do Windows: the process table there is `tasklist`/WMI, the host is a different
shape, and the flag refuses by name rather than half-working. It does not replace the supervisor of
another checkout's runtime directory; only supervisors whose `runtime.json` names this host's instance
are stopped. The age notice is a heuristic on file times and says so.

## Verification

| Check | Establishes |
| --- | --- |
| `replace-host.test.mjs` — process table | the table is parsed from `ps` output with paths containing spaces; the host for a state directory is the descriptor's PID **only if** that PID is `server/main.mjs --state` for that same directory; a PID that is another directory's host (vtmb-vr, nolf-improved), a supervisor, or a preflight worktree's host is refused by name; a dead PID is reported stale, not refused |
| `replace-host.test.mjs` — ancestry | a launcher whose ancestor chain contains the host PID is refused; one that does not is not |
| `replace-host.test.mjs` — supervisors | only a `runtime.json` naming this host's instance, whose PID is alive and is `supervisor.mjs`, is selected |
| `replace-host.test.mjs` — signals | `SIGTERM` that is honoured is the end of it; `SIGTERM` that is ignored is followed by `SIGKILL`, in that order |
| `replace-host.test.mjs` — a throwaway host | against a real sidecar started for the test: the old PID exits, its port refuses connections, the descriptor names a new live PID with a new instance, the report lists the session that ended, and a doctored process table claiming that PID serves another directory leaves the real process running |
| `replace-host.test.mjs` — the launcher | `launch.mjs --headless --replace-host --state DIR` comes up with a different PID than the host that was there; `--replace-host` is not refused by `--headless` |
| `replace-host.test.mjs` — the notice | a descriptor older than the code is stale, one newer is not |
| `stale-sessions.test.mjs` — the host | a registration carrying one live and two unknown ids registers, is listed bound to the live one alone, and is told the two in `unknownSessions`; a malformed frame is still `Invalid desktop bindings.`, and a session the host *does* have on another root is still refused |
| `stale-sessions.test.mjs` — the worker filter | `withoutEndedSessions` keeps the live ids in order, carries the dead one out separately, leaves the rest of the frame alone, and passes a malformed frame through untouched so `Desktops` refuses it by name |
| `stale-sessions.test.mjs` — through the worker | a real host and a real worker: a desktop registering one live and one dead id is registered, listed on `GET /api/desktops` bound to the live one, told the dead one, and sent no `error` frame |
| `native-stale-sessions.spec.mjs` — the desktop | a layout persisted before the desktop starts, naming a live session and a dead one: the real desktop the real supervisor launches registers, **`GET /api/desktops` through the runtime is not empty** and `update_status` answers, the live view is attached to its PTY, and the dead one is still in the layout with `sessionEnded` and nothing attached |
| `native-stale-sessions.spec.mjs` — `waitView` | under the same layout, a desktop-layer replacement succeeds: the second desktop process registers, the runtime layer is listed again, and the replacement restores the same layout with the same view marked ended |

Each regression was observed failing for its own reason by breaking the implementation in the way the
test claims to catch, confirming the red was that and not something earlier, then restoring — recorded
in `Codex-progress.md` Session 48.

**Not verified here, deliberately:** the live replacement of PID 68944. This session runs inside that
host and would be refused by decision 3; more to the point, the owner's work is in it. The first run
belongs to the owner, from a terminal outside rEngine:

```
~/hirebase-v2.command --replace-host
```

The record of that run — the report it prints, and that the tracker tab, terminal colour and
conversation offer then match the checkout — closes this feature under `docs/evidence/`.
