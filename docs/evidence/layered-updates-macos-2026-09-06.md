# Layered updates — macOS, 2026-09-06

Spec 065 adds independent native, workspace and MCP tool updates above the original PTY host.

- Red: actual MCP discovery lacked `update_workspace` before implementation (317 ms).
- `env -u RENGINE_HANDOFF_FILE -u RENGINE_HANDOFF_GATE npm test`: 23 passes, 4.66 s.
- Same environment with `npm run test:desktop`: 11 passes, 64.53 s.
- `ctest --test-dir .cache/desktop --output-on-failure`: four passes, 0.05 s, after concurrent F56 landed.
- `./init.sh`, inventory status/next: pass, 21 rows, F32 ready; broad gates unchanged here.

The real native fixture preserves an unsaved editor draft, CLI PID, root and single invocation
through all-layer MCP replacement. It exercises failed native build/start with recovered previous
view, failed workspace/tool candidates, automatic worker recovery, tool-facade recovery, retained
stream input, normal close, the CLI fallback and the unchanged launcher's native bootstrap.
Concurrent startup reuses one supervisor; an empty workspace creates no terminal or agent.
Authentication, foreign roots/desktops, changed context files and stale discovery are rejected.

Local logs are `.cache/session20-service-final.log`, `.cache/session20-desktop-final.log` and
`.cache/session20-layered-red.log`. They are private machine evidence, not portable fixtures.
An earlier CTest run hit the other session's unfinished draw-list assertion; its subsequent
commit fixed it and all four now pass. The original handoff environment isolation issue KI-031
is worked around only in test children. Windows runtime and packaged bootstrap paths remain
unqualified. The last production check retained Codex PID 20049, Claude PID 92674 and shells
33500/39735 with no production supervisor descriptor; no production reload is claimed.
