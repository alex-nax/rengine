# Combined NOLF launch qualification

Exercise `npm start -- --project DIR --agent codex --launch-game` through the real development
launcher, sidecar process, desktop and native NOLF executable. The qualification runner supplies
isolated application state and an explicit `--inspect-ui` flag, which enables native SDL event
automation over the process's stdin/stdout. Ordinary launches expose no debugging endpoint.
The flag does not replace launch/session code, game output, CLI output or user interaction.
Inspection may report the clipped rectangles of visible controls and accept native wheel events.
Controls are clicked through ordinary SDL pointer events; inspection must not invoke their actions.
This metadata is allocated only for explicit inspection, capped at 512 visible controls per frame.
The test drives the actual npm launcher over inherited stdin/stdout, including its build step.

Before starting terminal/agent sessions for `--launch-game`, check the selected game's prerequisites.
A missing build/data/adapter must produce a visible error without orphaning newly launched sessions.
Reject `--launch-game` without an explicit project before starting a sidecar.

The combined check must observe one real shell, one installed Codex session with the connected
rEngine MCP tools, and one live NOLF surface. Browse the real NOLF tree and open its README;
retain a draft without writing that project's source. Use a separate temporary project for actual
Save/conflict checks. Close and reopen the GUI through the same command and state directory;
assert identical sidecar/session IDs and PIDs, retained draft and continued game frames. Stop the
game in the session browser and confirm the terminal and agent remain alive. Clean up only the
test-owned processes and state. Store rendered/log evidence locally; commit evidence hashes only.

This macOS check does not close Windows, full gameplay, DPI, packaging or performance gates.
