# A desktop that cannot register because its layout outlived a host (spec 098, KI-063)

Date: 2026-09-07. Branch `fix/stale-sessions-registration`, from `origin/main` at `6f61640`.
Machine: macOS, this checkout. Parent spec: [098](../specs/098-replace-session-host.md), *What a
replacement leaves behind*; layer asymmetry from [065](../specs/065-layered-workspace-updates.md).

## The defect, as measured

Found live, twice on the same day, right after deliberate `--replace-host` runs:

| # | Workspace | When | What the person saw |
| --- | --- | --- | --- |
| 1 | rEngine's own | 2026-09-07, after `--replace-host` | new host serving two sessions; `GET /api/desktops` `[]`; no layered update available |
| 2 | hirebase-v2 (its own project, its own saved layout) | 2026-09-07 12:22 | same, plus **no runtime supervisor and no desktop process at all** |

The chain, in the order the parts fail:

1. The desktop restores `<state>/workspace.json`. On workspace 1 its tabs named **six** session ids,
   **four** of them owned by the host that had just been replaced.
2. `register_desktop` (`orchestrator/native/app.c`) advertises **every** tab's `session` in
   `sessionIds`, without asking whether the state it already holds still lists them.
3. `Desktops.register` (`orchestrator/server/desktops.mjs`) validated each id with
   `this.sessions.snapshot(id)`, which `fail('Unknown session.', 404)`s on the first stale one.
   The refusal is thrown before anything is stored, so the **whole** registration is refused. The host
   answers `{ type: 'error', error: 'Unknown session.' }` — reproduced by sending such a frame to the
   live host, read-only.
4. The desktop sets `a->desktop_registered` from a successful *send*, not from the reply, so it never
   retries. It stays unregistered for the life of the connection.
5. `GET /api/desktops` therefore answers `[]` while the desktop is on screen, and the supervisor's
   `waitView` never sees the view in `runtime-desktops`: `Replacement desktop did not register before
   timeout.` The supervisor's initial `openDesktop` rejects, the process exits, and `runtime.log` is
   empty because that failure travels over IPC.

Two controls, measured before writing anything:

- the same desktop binary registers normally when its saved layout names no stale session;
- a fake registration through a **fresh worker**, carrying only live ids, succeeded and received the
  `token` push — so the worker's ledger and push path are not involved.

## The reds, each for its own reason

Observed against the unmodified tree, before any implementation.

| Test | Red | Which claim it establishes |
| --- | --- | --- |
| `stale-sessions.test.mjs` — the host | `Unknown session.` thrown out of `Desktops.register` at `desktops.mjs:10`, inside `sessions.snapshot` | the host refuses the whole frame on the first stale id |
| `stale-sessions.test.mjs` — through the worker | `Timed out: desktop registered` (the fixture waits 5 s for `desktop-registered`) | the same refusal, reached through the worker's `/events` interception, leaves the desktop unregistered |
| `native-stale-sessions.spec.mjs` — the desktop | `Replacement desktop did not register before timeout.` at `supervisor.mjs:125`, in `waitView` from `startRuntime` | **the live failure, verbatim**, from a real host + real supervisor + real desktop under a layout persisted before the desktop started |
| `native-stale-sessions.spec.mjs` — `waitView` | the same, at the same line | the replacement path is the same path |

Both native reds took the full 10 s `waitView` deadline; both pass in **0.7 s** and **1.0 s** after
the fix, which is itself the proof that the desktop now registers rather than being waited for.

## The fix, by layer

Spec 098 carries the table. In short: the host drops ids it has no session for and names them in
`desktop-registered` (`unknownSessions`), keeping `Invalid desktop bindings.` for a malformed frame
and the different-root refusal for ids it *does* have; the worker filters `sessionIds` against the
`/api/state` it just refreshed and hands the removed ids down as `dropped`, and publishes the last
registration it refused on `/api/runtime-desktops`; the desktop advertises only sessions the state
holds and marks the other tabs ended, attaching nothing to them; `waitView` names the refusal and the
desktop's stderr on timeout.

The asymmetry matters and is the reason for three changes rather than one: **the host's copy of
`Desktops` only changes at the next `--replace-host`** (a Node process holds the modules it imported —
the premise of spec 098 itself), the **worker** reaches a running workspace at the next
`update_workspace`, and the **desktop** at its next reload. The layer that reaches a live workspace
soonest is not the layer that owns the store.

## Sabotage

Each fix broken in the way its test claims to catch, the red read, then restored.

SABOTAGE_TABLE

## Gates

GATES

## What is not proved here

The live `--replace-host` on the owner's workspaces is not re-run here: this session runs inside one
of them and decision 3 of spec 098 refuses it. What this branch proves is that the three layers agree
on a stale registration in a real host + real supervisor + real desktop, under a layout persisted the
way a replaced host leaves one. The first live run after the pin bump — `~/hirebase-v2.command
--replace-host`, then `GET /api/desktops` through the runtime answering non-empty — closes KI-063 on
the owner's own machines.
