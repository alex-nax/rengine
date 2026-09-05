# Combined native workspace qualification — macOS

Date: 2026-09-05. Scope: F55 normal-launch workflow; no complete feature/release claim.
The desktop is C11/microui/SDL2. The separate existing Node service owns files and processes;
no browser application runtime participates in this check.

## Consumer path and result

`RENGINE_NOLF_ROOT=/absolute/built/checkout npm run test:workspace` invokes the actual
`npm start -- --project DIR --state DIR --agent codex --launch-game --inspect-ui` command,
including CMake configuration/build, sidecar startup and session creation. Native stdin inspection
reports clipped control rectangles; the test clicks/types/scrolls through ordinary SDL events.
It does not create initial sessions through test-only service setup or invoke GUI actions directly.

The combined test passed in 15.06 seconds. It verified:

- Live actual NOLF frames, shell execution producing `COMBINED_SHELL`, and installed Codex
  0.153.4 displaying `/mcp` with the root-bound rEngine server connected and eight tools.
  No coding prompt was submitted; this proves CLI/MCP connection and interaction, not agent work.
- Adding the actual NOLF source root through the native textbox, scrolling its directory listing
  and opening `README.md`. The working file remained byte-for-byte unchanged while retaining a
  recovery draft and moving that dirty editor into the other pane.
- A separate temporary root with another `README.md`: Unicode explicit Save, external-write
  conflict rejection and Discard, without retargeting the source editor or sessions.
- NOLF Enter input reaching the Single Player menu, with rendered evidence inspected visually.
  Detaching its view retained the running process; Attach in the session browser restored frames.
- Closing and reopening the GUI through the same normal command retained the sidecar instance,
  all three session IDs/PIDs, source draft and continuing game-frame sequence.
- Stop in the native session browser exited NOLF while the shell and Codex remained running.
  Final test cleanup then stopped its own service and sessions; all four recorded PIDs were
  confirmed absent. The source checkout's pre-existing Git status remained unchanged.

The check exposed an event-driven hover bug: microui resolves its hovered root using the preceding
frame, so a first click after entering another container could miss. The host now schedules one
settling frame when the next hovered root differs. Static workspaces do not repaint continuously.
The regression reproduced the failure when adding a source project and passed after this fix.

Other checks: 19 service tests passed (4.34 s); both CTest layout/editor tests passed (0.46 s);
both existing native GUI tests passed (7.64 s), including Unicode Save/draft recovery, retained
PTY identity and SDL game capture/held-key release on Escape.

## Local evidence and pins

The game test copied the real executable and linked only REZ archives into its isolated runtime.
Game configuration/save writes, private service credentials, CLI logs and rendered images stay
under ignored `.cache/native-workspace-FCfKr2/`. Only evidence descriptions/hashes are committed.

NOLF source revision: `9ec64e5c4682b29dc0d60f9af735b76ff3e90a8d`.
NOLF binary SHA-256: `85761e577b977919cbfb61b72e2c8d8f4f22cb8625f4174e34dd0797f220365e`.
Native GUI: 784,552 bytes, SHA-256
`ac34f7ddfbf4f7f05d9592da866fc9dd59ee028b76421125b8c82ed53cadd93a`.
Executable size is not a memory/performance qualification.

| Local PNG | SHA-256 |
| --- | --- |
| `agent-mcp.png` | `4ea8b58b81543315d95175064307355a091a61fced8c90c64a31b15c454ecee7` |
| `game-input.png` | `456c381a4521c0814053dcbaf76613e01c4961093da4e4e40fe7d86b618763be` |
| `sessions-stop.png` | `34d5464502c3c3803e2560b011ea204537c41bbd056180ce440978153a11477f` |

Windows, native previews/terminal breadth, in-level aiming and input/DPI mapping, recovery,
packaging and resource budgets remain open. Tab overflow and native field/status refinements
observed in these screenshots are tracked in KI-023. The pending Windows source-transfer
rejection remains in force; this local qualification made no remote source transfer.
