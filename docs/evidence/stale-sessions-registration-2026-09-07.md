# A desktop that cannot register because its layout outlived a host (spec 098, KI-064)

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

Each fix broken in the way its test claims to catch, the red read, then restored. Because the three
layers are deliberately redundant — that is the point of the layer table — a single-layer sabotage
often leaves the end-to-end test green: another layer still drops the ids. The combinations below say
which layer carries which configuration, so nothing here is a green claimed for the wrong reason.

| # | Sabotage | Test run | Result |
| --- | --- | --- | --- |
| 1 | **host**: `Desktops.register` re-throws the 404 instead of dropping the id | `stale-sessions.test.mjs` | **red** — `Unknown session.`, the original refusal. Test 3 (through the worker) stayed **green**: the worker's filter carries that configuration on its own, which is the "old host behind a new worker" case |
| 2 | **worker helper**: `withoutEndedSessions` returns the frame unchanged | `stale-sessions.test.mjs` | **red** — the filter test only; the ids it should have removed are still in `frame.sessionIds` |
| 3 | **worker call site**: `desktops.register(client, data)` unfiltered | `stale-sessions.test.mjs` | **green** — `Desktops` still drops them. The layer is redundant *by design*; row 4 is the configuration where it is not |
| 4 | **1 + 3 together**: neither server layer drops | `stale-sessions.test.mjs` | **red** — test 1 `Unknown session.`, test 3 `Timed out: desktop registered`. Two layers, each sufficient alone |
| 5 | **desktop**: `register_desktop` advertises stale ids again | `native-stale-sessions.spec.mjs` | **green** — the server layers drop them, so the binding is still `[live]`. Row 7 is where this layer is the only one left |
| 6 | **desktop**: `restore` does not mark the view ended | `native-stale-sessions.spec.mjs` | **red** — *"nothing was attached for it"*, actual `false`, expected `undefined`: a terminal was opened against a session nobody has |
| 7 | **1 + 3 + 5**: no layer drops the ids | `native-stale-sessions.spec.mjs` | **red** — tests 1 and 3: `Replacement desktop did not register before timeout. last registration refused: Unknown session.` The original live failure, reproduced end to end — and the new `waitView` message naming it |
| 8 | **1 + 3 only**, desktop layer intact | `native-stale-sessions.spec.mjs` | **green** — the desktop's own filter is sufficient: this is a desktop reload against a host that has not been replaced |
| 9 | **supervisor**: `waitView` throws the old bare message | `native-stale-sessions.spec.mjs` | **red** — *"the timeout names the refusal instead of only the silence: Replacement desktop did not register before timeout."* |
| 10 | **KI-065**: `writeAtomically` back to one temporary per process | `atomic-write.test.mjs` | **red**, both tests, in 3 of 3 runs: seven of eight writes rejected with `ENOENT: no such file or directory, rename .../preferences.json.<pid>.tmp` |

Row 7 is the one that matters: with every layer's fix removed the suite reproduces the owner's exact
failure, and the improved timeout message is what identifies it.

## Gates

Run in this worktree, macOS, after the merge of `origin/main` at `7a1d6c5`.

| Gate | Result |
| --- | --- |
| `npm run build` | clean, zero warnings (the picky C flag set is unchanged) |
| `npm test` | 170/170 green (165 on `origin/main` plus the five added here) |
| `npm run test:desktop` | 51/51 green, `native-render` included |
| `orchestrator/tests/token-retirement.test.mjs`, five consecutive runs | 5/5 green (it flaked about one run in three before KI-065) |
| sidecar `check` for the four annotated files this touched | clean after `--fix-anchors` and `stamp` |

One desktop test failed on an earlier, pre-merge run for an environmental reason, unrelated to
anything here: `GPU adapters match the SDL reference` reported `opengl: resident memory delta 33728
KiB exceeds 32768 KiB` — 2.9% over the ceiling of spec 068 decision 6, measured while the unit suite
was running concurrently on the same machine. It is the KI-039 / KI-045 shape, and it passed in the
uncontended run above. Before the surface adapter was built in this worktree (`npm run build:surface`,
which populates `.cache/native`) the two recorder specs also failed on a missing fixture; that is a
prerequisite of the suite, not a result.

## What is not proved here

The live `--replace-host` on the owner's workspaces is not re-run here: this session runs inside one
of them and decision 3 of spec 098 refuses it. What this branch proves is that the three layers agree
on a stale registration in a real host + real supervisor + real desktop, under a layout persisted the
way a replaced host leaves one. The first live run after the pin bump — `~/hirebase-v2.command
--replace-host`, then `GET /api/desktops` through the runtime answering non-empty — closes KI-064 on
the owner's own machines.
