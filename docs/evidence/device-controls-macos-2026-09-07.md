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
