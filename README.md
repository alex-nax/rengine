# rEngine

rEngine is a quality library base for AI-assisted development of purpose-built game engines.
Its curated components, integration knowledge, tools and harness support independently maintained
projects. reLith and reSource are its first intended consumers. The eventual name is **realEngine**.

The planned IDE is a tab-and-pane orchestrator: arrange terminals, project/file views, coding
agents, live game output and integrated tools in one workspace. An initial agent terminal will
run a Bash selection/installation launcher and bootstrap that agent's project integrations.

**Status: native desktop implementation in progress.** The GUI is C with microui and SDL2.
Electron and embedded browser application runtimes are excluded by the owner's architectural
constraint. A later web interface will be a separate client of workspace services.

The current macOS checks cover real project files, Unicode editing, explicit Save/conflicts,
local draft recovery, movable tabs and retained PTYs. Native SDL mouse capture/Escape release
passes, and the actual NOLF menu renders and accepts input in a game tab. Windows, full gameplay,
previews, terminal/editor completeness, packaging and resource qualification remain in progress.
Earlier Electron screenshots/tests are historical evidence, not native desktop qualification.

With CMake, a C compiler, SDL2 **2.32.10** development files and Node **22.12+** installed:

```sh
npm ci
npm run build:surface
npm start -- --project /absolute/path/to/nolf-improved --agent codex --launch-game
```

The launcher builds and runs the native executable. The first CMake configure downloads a
checksum-pinned libcurl source archive; the other small C dependencies are vendored with licenses.
Node currently runs the development launcher and retained PTY/file/agent service as separate
processes. It is not linked into the GUI or either game. Service migration timing remains open.

Omit `--agent` to use the saved preference or selection menu. Manage opens the standalone Bash
agent launcher with explicit find/install/update/launch actions. Windows agent launching requires
Git Bash (`RENGINE_BASH` selects an alternate path). Agent sessions receive project-bound rEngine
MCP configuration. The combined macOS check boots installed Codex 0.153.4 through Bash and
verifies `/mcp` reports rEngine connected with eight tools in the native terminal. Existing agent
settings and credentials stay with the agent.

NOLF uses the selected project's existing `build/relith-nolf`, `nolf/NOLF.REZ`, configuration and
save directory. Omit `--launch-game` to launch it later from the NOLF button. The macOS adapter
streams live frames into a native texture; Windows host wiring remains pending.

Closing views detaches them; use **Sessions** to reattach or explicitly **Stop** a process.
Use the tab-strip arrows when a pane fills up. Drag onto a tab to reorder, or into another pane
to move it. **Merge pane** collapses the active pane into its neighbor while keeping all views
and running sessions. The selected tab becomes visible after layout changes and GUI restart.
State defaults to `~/.local/state/rengine`; `--state DIR` isolates a workspace. Working files change
only on Save. Recovery drafts are checkpointed locally and flushed before normal GUI exit.
The initial native Vim subset and current limits are in the [native desktop spec](docs/specs/056-native-desktop.md).

**Cmd/Ctrl+Shift+R** installs the layered supervisor once when upgrading an older running
launcher. Subsequent launches reuse it. Agents use **update_status** and **update_workspace**
to prepare and replace workspace, desktop and MCP tool workers while retaining live sessions.
Select a desktop ID from **list_desktops** for desktop updates; **reload_desktop** selects only
that layer. Poll the returned job until it succeeds or finishes recovery. Build/start failures
keep or restore the previous desktop and its recovery drafts.

An already loaded older connector can use the same actions without restarting its agent:

```sh
node orchestrator/runtime/client.mjs status --context /absolute/path/to/context.json
node orchestrator/runtime/client.mjs update --context /absolute/path/to/context.json --desktop <listed-id> --layers workspace,desktop,connector
```

The context is the agent's existing generated integration file; `RENGINE_WORKSPACE_CONTEXT`
can supply it instead. Original PTY-host and supervisor protocol replacements still require
quiescence. Routine updates preserve the host, CLI and conversation. See
[layered updates](docs/specs/065-layered-workspace-updates.md).

To open a game project with the current agent, run `orchestrator/actions/project-window.sh`
with explicit context, project path and retained agent ID. Each project window keeps its own
layout; root-bound tools inspect/focus/close/reopen it and exchange durable integration reports.
Agents can open interactive `.sh` flows in new retained tabs with **open_script**, then reattach
them with **show_session**. The human uses the prompts while the same host retains processes/logs.
The [dogfooding runbook](docs/runbooks/project-window-dogfooding.md) includes the shell routine,
MCP tools and older-connector CLI fallback. Project skills for `rengine-dogfood`, `wizard` and
`llm-sidecar` are available to Codex and Claude without global installs.

Terminal output waits for space in bounded receive queues. A dropped session stream reports
the loss and reconnects to the same retained processes; disconnected keystrokes are discarded.
Reattachment uses fresh terminal snapshots without launching another agent. See the
[terminal recovery checks](docs/specs/059-native-terminal-recovery.md).

Scroll over a terminal or agent pane with the mouse/trackpad. **Shift+PageUp/PageDown** browse
history; **Shift+Home/End** jump to oldest/live output. New output preserves your reading position;
typing returns to the live prompt. Each view retains up to 2,000 rows/8 MiB, rebuilt from the
sidecar's bounded output after reload. Full-screen alternate applications retain their own screen.
Scrolling follows the system trackpad direction. Terminal history has a draggable vertical bar;
editors show vertical/horizontal bars when needed, and overflowing trees/session lists retain
microui bars. Drag the thumb or click a custom bar track to page. Wheel input follows the hovered
pane without changing keyboard focus. See [pane scroll controls](docs/specs/061-pane-scroll-controls.md)
and [terminal scrollback](docs/specs/060-native-terminal-scrollback.md) for current limits.

Applications that request terminal mouse reporting, including Claude fullscreen, receive clicks,
hover/drag and wheel events in their own screen. **Shift+wheel** browses local primary-screen
history; ordinary shells keep native scrolling. Reload retains the process and restores its mouse
mode without answering historical terminal queries again. See [terminal mouse support](docs/specs/063-terminal-mouse-reporting.md).

To resume a specific Codex conversation inside an agent pane, use
`npm start -- --handoff /path/to/handoff.json`. The version-1 manifest contains `project`
(relative to the manifest), `sessionId` (the exact local Codex UUID), and `checkpoint`
(a document relative to the project). The launcher checks the matching local session, CLI and
login; the CLI waits until its native pane is attached and presented. It never picks the latest
session implicitly. A live session is reused on reload or repeated launch without another prompt.
Older services are rejected for this path; use a new state directory or explicitly stop/restart
the old service. The local prepared handoff runs with `npm run resume`; see the
[current checkpoint](docs/handoff/2026-09-05-orchestrator-resume.md). Manifest and workspace state
are local, ignored files. A fresh checkout needs its own manifest and local Codex conversation.

The GUI can also be built and run independently of the JavaScript launcher:

```sh
cmake -S . -B build/desktop -DCMAKE_BUILD_TYPE=Release
cmake --build build/desktop --config Release
build/desktop/bin/rengine --connection /absolute/state/directory/sidecar.json
```

An existing service connection is required for files and sessions. On multi-configuration Windows
builds the executable is under `bin/Release`. The GUI uses a trusted system monospace font;
`RENGINE_FONT=/absolute/font.ttf` selects another. Glyph coverage follows that font.

```sh
npm test
npm run test:desktop
RENGINE_NOLF_ROOT=/absolute/checkout npm run test:nolf
RENGINE_NOLF_ROOT=/absolute/checkout npm run test:workspace
```

Desktop GUI tests run sequentially to avoid competing for native mouse capture. NOLF qualification
copies the executable and links only asset archives into an ignored runtime directory, preserving
the original project's saves/configuration. Native `--inspect-ui` automation uses process stdin;
normal launches expose no UI debugging endpoint. See [native evidence](docs/evidence/native-desktop-macos-2026-09-05.md).
The [combined qualification](docs/evidence/native-workspace-macos-2026-09-05.md) exercises the normal
launcher, installed Codex, real source tree, isolated Save/conflict checks, draft/process recovery
and game reattachment/Stop through the native session browser. It requires installed, authenticated Codex.

The project boundary is established by
the owner's brief and library-first clarification. Curated upstream plus our own gaps and iklib
proven in both games first are confirmed. A pinned curated capability with passing game integration
checks meets the powered-by minimum; the IDE and shared harness are optional. Detailed pilot
profiles and later implementation order remain under review. Desktop IDE support starts with macOS and Windows,
using game/tool adapters first and including basic text editing with optional Vim mode. Quest
starts with the same 2D workspace backed by a desktop sidecar; delivery and external-app support
are under investigation. Views detach from retained sessions, managed in a session browser.
The first implementation milestone is desktop workspace, terminals and a live flat NOLF tab;
VtMB follows as the second game adapter. Editors retain local recovery drafts and save working
files explicitly.
Each workspace supports multiple project/worktree roots, with terminals, editors, agents and
games explicitly bound to their own root.
No engine migration or completed IDE release is claimed.

The primary value is reusable, dependable implementation that an agent can select and compose
for a game's needs. Library contracts, executable examples, host integration evidence and clear
limitations make that base usable. The harness supports its quality and maintenance; eligible
development evidence can later feed the separate agent-training project.

Each game keeps its own architecture. A project can choose flecs, another framework, or its
existing object model. Shared components must earn their place through actual consumers.

## Start here

```sh
./init.sh
python3 tools/features.py status
python3 tools/features.py next
```

The bootstrap checks this repository only and works without game assets, sibling checkouts,
network access, or a native game toolchain. While the roadmap is under review, the feature
helper uses the scoped approved `features.json`. The larger inventory remains a separate proposal.

| Document | Purpose |
| --- | --- |
| [Agent instructions](AGENTS.md) | Session workflow and sources of truth |
| [Progress](Codex-progress.md) | Latest verified work and next action |
| [Charter and interview](docs/specs/000-charter.md) | Owner decisions, recommendations, and open questions |
| [Architecture](docs/architecture.md) | Ownership and dependency boundaries |
| [Library quality proposal](docs/library-quality.md) | What makes a component dependable and practical for an agent to use |
| [iklib pilot draft](docs/specs/001-library-pilot.md) | First two-game proof, host ownership and separate finger follow-up |
| [Orchestrator specification](docs/specs/002-orchestrator.md) | Tab/pane workflow, process boundaries, agent bootstrap and open choices |
| [First desktop acceptance draft](docs/specs/032-desktop-v0.md) | NOLF workflow, recovery behavior and remaining qualification inputs |
| [Meta XR Operator investigation](docs/research/meta-xr-operator.md) | Verified upstream capabilities and unverified native-host compatibility |
| [Quest and app-pane feasibility](docs/research/quest-and-app-surfaces.md) | Quest delivery routes, desktop sidecar design and platform constraints |
| [Project reconnaissance](docs/reconnaissance.md) | Evidence from the existing repositories |
| [Roadmap](docs/roadmap.md) | Proposed milestones and their exit conditions |
| [Interactive roadmap review](docs/reviews/rengine-roadmap-2026-09-05-v1.html) | Six review branches covering all proposed feature criteria |
| [Integration plan](docs/integration-plan.md) | reLith, reSource, iklib, infra-vr, and training handoffs |
| [Known issues](known-issues.md) | Current gaps and uncertainties |

## Current ecosystem

| Project | Relationship |
| --- | --- |
| `nolf-improved` / reLith | NOLF working per owner; AVP2 and NOLF2 in progress; first engine-family consumer |
| `vtmb-vr` / reSource | Independently maintained Bloodlines reimplementation; second consumer |
| `iklib` | Independent portable C++17 IK library; selected first two-game library proof |
| `infra-vr` | Existing shared reporting/launcher/backend project found through both engine builds |
| `vr-port-agent-training` | Independent dataset, rollout, evaluation, and post-training authority |

Local paths used during reconnaissance are conveniences, not required dependency locations.
The checked-in inventory is a dated observation, not a lockfile or compatibility guarantee.
