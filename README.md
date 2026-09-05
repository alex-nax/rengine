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

**Cmd/Ctrl+Shift+R** flushes drafts/layout, rebuilds the C desktop and reconnects to the same
running sessions. A build failure leaves those sessions retained; rerun the launch command after
fixing it. Reload covers the desktop; it does not replace a running service or coding agent.

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
