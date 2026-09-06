# Native scroll controls and agent desktop actions — macOS

Date: 2026-09-06. Specs [061](../specs/061-pane-scroll-controls.md) and
[062](../specs/062-agent-desktop-actions.md) refine the authorized native desktop scope.
All 15 feature gates remain false; no Windows runtime or completed NOLF goal is claimed.

## Regressions and implementation

The existing terminal negated `SDL_MOUSEWHEEL_FLIPPED`. Pinned SDL 2.32.10 Cocoa already
applies the system preference to signed wheel deltas and carries inversion as metadata;
negating again undid the preference. The corrected C assertion failed on the old implementation
(exit 134, `.cache/session18-direction-red.log`) before the fix. Terminal, editor and microui
list scrolling now use delivered precise signs and fractional accumulation. See the primary
source links and correction rationale in spec 061.

Native terminal history has a vertical bar; the editor shows vertical/horizontal overflow
bars. Drag endpoints and track paging clamp to content; scrollbar events are consumed before
PTY input or editor selection. Tree/session lists retain pristine upstream microui bars.
Native pointer tests navigate both editor axes, terminal oldest/live history, fractional
FLIPPED events and overflowing trees. They assert unchanged file bytes and editor revision,
no terminal input from bar actions, no-overflow hiding and retained PTY identity. The shared
upstream list bar is exercised through an overflowing tree, not a separate session-overflow run.
Existing terminal checks still cover output anchoring, alternate screen, resize and view reload.

A real MCP stdio tool-list check failed before `list_desktops` and `reload_desktop` existed
(`.cache/session18-mcp-red.log`). The new authenticated broker tracks ephemeral native socket
IDs and declared project/session bindings. It rejects foreign roots, stale/unsupported targets,
concurrent requests and mismatched acknowledgements, with bounded timeout/disconnect handling.
Reload uses the existing native save/build/reattach routine. Acceptance is distinct from build
completion; observing a replacement desktop ID supplements the actual launcher build evidence.

## Consumer verification

- `npm run test:desktop`: seven passes, 41.12 s, including native scrollbars, terminal history,
  burst/reconnection, file/tree/PTY editing, pane navigation, game fixture and handoff/reload.
- `ctest --test-dir .cache/desktop --output-on-failure`: three passes, 0.62 s. The terminal C
  check also covers both-axis million-unit bar endpoints and out-of-track drag/release.
- `npm test`: 21 passes, 4.30 s; actual MCP stdio excludes a foreign desktop and rejects its ID.
- The focused native handoff check also passed (9.71 s). It first uses the keyboard shortcut,
  then actual MCP discovery/reload against the normal native launcher, observes two rebuilds,
  dirty draft restoration, one CLI invocation and the same retained CLI PID. A stale desktop
  ID is rejected. The CLI executable/session metadata are instrumented isolated fixtures;
  this test does not reopen a real provider conversation or qualify exact editor insertion position.
- Native screenshots were inspected: the editor reaches its last lines/right edge with both
  bars visible; terminal history shows its bar and position label. The handoff image shows the
  restored unsaved draft and retained interactive CLI output. Tests clean only owned fixtures.
- `./init.sh`, inventory status/next, repository sidecar validation and `git diff --check` pass.
  Accepted criteria/inventory and the generated roadmap graph are unchanged.

## Live workspace boundary

The real `RENGINE_ORCHESTRATOR_SESSION` still identifies the same running agent and root-bound
MCP workspace for `/Users/alex/rengine`. The current retained service and installed MCP process
predate desktopActions version 1. A fresh MCP stdio client against that service correctly reports
that explicit service management is required to upgrade; it does not start a replacement sidecar.
The actual agent PID 20049 and original shells 33500/39735 remain running.

The production desktop was identified as PID 62416 under launcher 19761. One targeted invocation
of Cmd+Shift+R through System Events failed with macOS error 1002: `osascript` is not allowed to
send keystrokes. This is an OS Accessibility denial, not an automatic approval-review rejection.
No OS settings were changed, service/agent stopped, or live reload claimed. The tested binary is
ready for the native shortcut. The new MCP mechanism needs no OS keystroke injection once its
service/connector versions are loaded; loading those versions is a separate explicit operation.
No new coding conversation/goal, sibling changes, source transfer, training or data export occurred.

## Local artifact hashes

Artifacts remain in ignored local storage. SHA-256:

| Artifact | SHA-256 |
| --- | --- |
| `.cache/desktop/bin/rengine` | `70a490734a94af5e44749fa1b632beaebe180823dd97a2e1e7433f318a0aa13c` |
| `.cache/evidence/native-scrollbars.png` | `98714efa86ca452d5cf0fbda18142fdb270bf5386aa93bf136236982ad03dd15` |
| `.cache/evidence/native-handoff.png` | `5eb84c19e84d8fef08282e51a07b529a409958fc6348bdc914ec9ceb0502f3ec` |
| `.cache/session18-desktop.log` | `87dd40189993825881e42bf822b0f46dcf0b249fa86acef56beb71d84fed3760` |
| `.cache/session18-service-final.log` | `2b984ceec9cb579d6b40b4725a090a65f5fb2be5c643fb0fb545752336c193bd` |
| `.cache/session18-actions-native.log` | `1f2b3861a24daf82fccc6e739107dce250667d1edda819a836a7dcc48f61aebf` |
| `.cache/session18-direction-red.log` | `a2fd54d114eafcf2cd68969db13f109ab90847fab3ced61cce950b2013231626` |
| `.cache/session18-mcp-red.log` | `8fdf2e5d290c32cded9dba8367fd599ea370aba0f0f083e4c9e4e1ab9f04b1e7` |
