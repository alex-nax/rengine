# NOLF workspace qualification

Status: macOS combined development-launch checkpoint passes; the full Mac/Windows goal remains open.

On 2026-09-05, `RENGINE_NOLF_ROOT=/Users/alex/nolf-improved npm run test:workspace` passed in
29.3 seconds on macOS 15.7.3 arm64, Node 25.3.0, Electron 44.2.0 and installed Codex 0.153.4.
It executes the actual `npm start -- --project DIR --agent codex --launch-game` command with
temporary `--state` and Electron user data, plus explicit `--inspect-ui` for local CDP automation.
The native adapter and host/executable pins are recorded in
[native surface evidence](nolf-surface-macos-2026-09-05.md); the host remained at
`9ec64e5c4682b29dc0d60f9af735b76ff3e90a8d` with its pre-existing worktree changes preserved.

Observed through the real desktop:

- One NOLF game, installed Codex and interactive Bash session opened with the intended root.
  Native frames advanced, Codex `/mcp verbose` showed rEngine tools, and a shell command returned
  its result through the terminal pane. No coding prompt was submitted.
- NOLF's real tree and README opened. A local draft was retained without changing the working
  file. A second root with another README saved to its own path; an external edit caused the
  expected conflict and retained the draft until explicit Discard/reload.
- Selecting the second root left the NOLF, shell and agent bindings intact. Closing the GUI and
  launching again reused the original sidecar identity and all three session IDs/PIDs. The NOLF
  draft recovered; its working file remained byte-for-byte unchanged.
- Session-browser Stop exited the intended NOLF process while shell and agent remained running.
  Test cleanup stopped the test-owned sidecar and its remaining sessions.

The inspected local screenshot `.cache/evidence/launch-command.png` has SHA-256
`771647298106b82ec1e22f04c0a2a66739a148cd45eb38720ba729d73c065d81`.
Images, CLI output, tokens and game assets remain local and ignored by git.

Separate launcher tests pass missing-project and missing-build checks before any new terminal or
agent session starts, plus concurrent-launcher reuse. Earlier combined-check failures were test
selector errors (provider-named agent tab and two root-specific README buttons) and a CDP reply
race during window close. Explicit root selectors and waiting for close/exit events resolved them.

Remaining: Windows runtime/host adapter and packaged builds, full NOLF gameplay/relative aiming,
DPI and resize cases, numeric performance qualification, image previews, forced-crash/persistence
failure cases and outstanding provider qualification. This checkpoint does not mark F48/F55 or
their prerequisites complete.
