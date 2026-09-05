# Orchestrator handoff and reload — macOS, 2026-09-05

Scope: specs 057–058 on the native C/microui/SDL2 desktop. Feature criteria and overall goal
remain open. The owner requested the next development session inside this orchestrator.

| Check | Result |
| --- | --- |
| Final `npm test` | 20 pass, 4.36 s |
| `npm run test:desktop` | Four pass, 24.23 s: native game, handoff/reload, pane navigation, editor/PTY |
| `ctest --test-dir .cache/desktop --output-on-failure` | Two pass, 0.33 s |
| Final `node --test orchestrator/tests/native-handoff.spec.mjs` after manifest snapshot hardening | One pass, 8.43 s |
| `./init.sh`, inventory validation and `git diff --check` | Pass; 15 feature gates remain false |
| Reviewed sidecar anchors, stamps and repository-wide check | Clean |
| Real installed Codex | 0.153.4; `resume --help` and `login status` succeed; exact local session metadata matches `/Users/alex/rengine` |

The handoff consumer uses an instrumented managed Codex executable and synthetic session metadata
in a temporary project, while using the actual Bash launcher, generated required MCP arguments,
retained PTY, normal desktop launcher and SDL input. It proves that a failed login creates no
session; concurrent handoff requests share one PTY; neither no GUI nor a GUI without its agent
view invokes the CLI; presentation delivers the explicit UUID and checkpoint once. Changing the
original manifest while waiting cannot change the private checkpoint snapshot used by that PTY.
Native input reaches the CLI; Cmd/Ctrl+Shift+R rebuilds/reloads and preserves its PID/output and
an unsaved editor draft. Closing/relaunching does not invoke again. Stop permits a fresh waiting
bootstrap. All temporary GUI/service/PTY resources are closed by test cleanup.

The screenshot after reload was inspected: dirty checkpoint editor on the left, retained CLI
output on the right, native pane/tab controls. The saved working file remains unchanged. This
is not evidence that the instrumented executable contacted a model or completed an MCP handshake.
Prior installed-Codex MCP proof is in `native-workspace-macos-2026-09-05.md`. The actively written
real conversation was not resumed in parallel; its continuation is the next user launch.

| Local ignored artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `.cache/evidence/native-handoff.png` | 131912 | `3a4bd358661baf62282ec976b41b03fc7f3390aa02a08bfdc3c552616f80ee7b` |
| `.cache/desktop/bin/rengine` | 784728 | `39f1a35e417ca7cab51ab0749977a9ae5f278d0676fc98f9dec6ea69b1d21e9b` |
| `.cache/handoff-final-native.log` | 215 | `94f88ae7675e344ff7101feba34e93bbb0a371bf98eba4ae278e1eb034333582` |

The earlier actual NOLF pane movement keeps frames/PID but exposes KI-024: the inspected image
after Enter still shows the main menu. The test lacks a menu-state oracle. That input issue is
preserved in the checkpoint rather than counted as a pass or fixed outside the requested handoff.
Windows runtime qualification remains outstanding; no source transfer to the unapproved Windows
destination occurred. Native reload does not hot-replace service code. Goal scheduler pause/resume
is controlled by the calling application; this environment exposes no pause operation.
