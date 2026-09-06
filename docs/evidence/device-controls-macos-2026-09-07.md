# The Devices tab against the live vtmb-vr declaration — macOS, 2026-09-07

F80, spec 082 (section *Controls on the device*). Branch `feat/device-controls` in the
`.cache/worktrees/device-controls` worktree, cut from `origin/main` at `5a0bc38`. Built to that
worktree's own `.cache/desktop`, never the shared one, which holds another session's uncommitted
native work. No live orchestrator, sidecar, connector or agent session was replaced;
`update_workspace` was not run from here, and neither consumer repository was edited.

## Why the real declaration is the fixture that matters

`vtmb-vr` is the only contract-4 consumer: two declared devices, eleven dashboard actions, two game
records, and — the motivating case for the whole feature — `remote-rengine`, a `script` action bound
to `pcvr` whose job is to install a headless rEngine on that box. Its value is that it is the thing
you press *next to the device it acts on*, and it was previously reachable only from the Dashboard,
where nothing says which machine it concerns.

## The listing this branch produces

Resolved through `projectDevices` with the same `dashboardActions` and `inspectGame` the routes use.
The Windows box was powered off and the headset was attached over USB, so this is the mixed case the
tab exists for. Each probe ran once.

```
# local  reachable
    [run]   flat           · game
    [run]   flat-newgame   · game
    [run]   editor-check   · script
    [run]   dist           · script
    [ready] vtmb-flat      (game record)
# pcvr   UNREACHABLE — Windows PCVR box (pcvr) is not reachable: the probe failed (exit 255):
#                     ssh: connect to host 192.168.31.217 port 22: Operation timed out.
    [----]  pcvr           · script  · blocked by: device
    [----]  remote-rengine · script  · blocked by: device
    [there] vtmb-vr        build/vtmb-vr on Windows PCVR box (pcvr), not on this machine
# quest  reachable
    [run]   quest          · script
    [run]   quest-log      · log
    [run]   quest-screen   · capture
    [run]   quest-deploy   · script
    [run]   quest-data     · script
```

Three properties are visible in that output and are each asserted by a fixture:

1. **One reason.** The ssh timeout is written once, on the `pcvr` row. Both controls bound to it are
   disabled and say nothing further — their `missing[0].type` is `device`, which the tab reads as
   *the row above already said it*. Nine actions across three devices, three reasons at most.
2. **Bootstrap is gated, not exempt.** `remote-rengine` is disabled while the box is down, beside the
   ordinary `pcvr` action, with no special case. Spec 082 carries the reasoning; the short version is
   that the wizard's own first stage is *Check this machine can reach the box* and aborts when `ssh`
   fails, so an enabled button would buy a worse version of the same sentence.
3. **A remote target never reads ready.** `vtmb-vr`'s preflight is `ready: true` — the device answered
   nothing is missing locally — but it carries a refusal, because rEngine does not launch on a remote
   device. The row says where it runs instead.

`nolf-improved` is contract 3 and declares no devices: it reads clean and unchanged, gets the
implicit `local` device, and its fourteen actions all appear under it as runnable controls.

## What a control does when pressed

`re_app_dashboard_run` → `POST /api/dashboard-run` → `dashboardAction` resolves availability again and
dispatches by kind — exactly the Dashboard's path, not a copy of it. The native fixture presses a
`script` action from the Devices tab and requires the retained session that appears to be titled
`Script · say.sh` and to have printed the action's declared argument, which only that route produces.

## Two findings from the sabotage pass, recorded as they happened

**A reason count that passed while the defect was present.** The first assertion on *one reason, not
one per control* counts reasons exactly equal to the device's own sentence. It did **not** catch the
sabotage that restates the device reason under every bound control, because the restated line wraps
the reason (`Unavailable: missing device Silent box (silent-box) is not reachable: …`) rather than
repeating it verbatim. The substring count beside it — every reason naming `silent-box`, expected
once — is the load-bearing assertion, and it caught it at 3 !== 1. Both are now labelled for what
they actually check. This is the blind-assertion shape this repository has now met six times, and it
surfaced from sabotaging rather than from reading the test.

**A sabotage whose failure mode is a livelock, not a red.** The honest sabotage for *drawing a
control probes nothing* is a probe issued from inside a control's draw. Doing that turns the desktop
into a refresh storm — every frame requests a refresh, every refresh redraws — and the suite hangs
instead of failing; a modulo-limited variant (a probe every tenth frame, which is the forbidden
*timer*) hangs it too. The assertion therefore could not be driven red by sabotaging the code. It was
calibrated instead by making the extra probe happen for real: replacing the thirty idle frames with an
explicit Refresh turns it red at *thirty more frames of the same section probed nothing*, 2 !== 1. So
the assertion is live and correctly wired to the probe counter; what remains unproven is only that the
specific code path could produce that count, and the reason is written down rather than glossed.

## The input seam, after merging 1a9c591

`origin/main` gained *give the shell back its control chords, and the menu its keyboard* while this
branch was gating. A Devices control is a focusable control in a pane, so two questions sit exactly
between the lanes and neither fixture asked them: can a control take a chord the workspace owns, and
can one act on a key an open menu wants. Added to `native-devices.spec.mjs`:

- the platform chord (`Cmd`/`Ctrl` + `T`) pressed with the pointer over a runnable Devices control
  opens a shell rather than running the control — sabotaged by swallowing `SDLK_t` in the chord
  dispatch, which fails at *the platform chord opened a shell over the Devices section*;
- `Return`, `Space`, a letter and typed text over the section start nothing, because a control here
  submits on a mouse press and holds no keyboard focus — sabotaged by making a control fire on
  `MU_KEY_RETURN`, which fails at *typing over the section started nothing*, 3 !== 1;
- a popover opened over the section stays open under typing, changes no setting, starts nothing on
  the device beneath it, still answers its own control, and leaves the section running when it is
  actually pressed.
