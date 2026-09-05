# rEngine

rEngine is a quality library base for AI-assisted development of purpose-built game engines.
Its curated components, integration knowledge, tools and harness support independently maintained
projects. reLith and reSource are its first intended consumers. The eventual name is **realEngine**.

The planned IDE is a tab-and-pane orchestrator: arrange terminals, project/file views, coding
agents, live game output and integrated tools in one workspace. An initial agent terminal will
run a Bash selection/installation launcher and bootstrap that agent's project integrations.

**Status: desktop implementation in progress.** The active NOLF workspace goal authorizes the
desktop and agent scope in [F55](docs/specs/055-nolf-workspace-goal.md). The sidecar file/session
services, standalone agent launcher and desktop tree/editor/terminal workflow have automated
macOS tests. A native adapter now renders the actual NOLF menu into a movable game pane and
accepts input; the full Mac/Windows workflow remains in progress.

With Node 22.12 or later installed:

```sh
npm ci
npm run build:surface
npm start -- --project /absolute/path/to/nolf-improved --agent codex --launch-game
```

This opens the project tree, a shell, the installed agent and live NOLF. Omit `--agent` to use the saved
preference or the terminal selection menu; Manage agents offers explicit install/download and
update actions. Windows agent launching requires Git Bash (`RENGINE_BASH` can select its path).
On macOS, Launch NOLF opens the project's existing `build/relith-nolf` with `nolf/NOLF.REZ` and
its normal local game configuration. Omit `--launch-game` to launch the game later from its button. Building
the native adapter requires CMake, SDL2 2.32.10 development files and platform OpenGL. Windows
host integration is still pending. Agents launched from the workspace receive a project-bound
rEngine MCP connection. Codex was verified interactively; Claude/OpenCode/Gemini overlays have
configuration tests and still need their own runtime qualification. Custom executables receive
an `RENGINE_MCP_CONFIG` file path for their own integration recipe.

The sidecar retains sessions when the desktop closes; use Session browser to attach or Stop.
State defaults to `~/.local/state/rengine`; `--state DIR` selects an isolated workspace. Working
files change on Save; unsaved text is checkpointed locally and flushed before normal GUI exit.
PNG, JPEG, GIF and WebP open as read-only image previews with fit/actual-size and Refresh controls
(8 MiB encoded, 16 megapixels, maximum 8,192 pixels per dimension).
Run `npm test` for services/launcher checks and `npm run test:desktop` for the real desktop test.
With the native adapter built, `node --test orchestrator/tests/sdl.spec.mjs` exercises a real
SDL/GL producer. `RENGINE_NOLF_ROOT=/absolute/checkout npm run test:nolf` exercises the actual
local game, menu input, pane moves, GUI restart, reattachment and Stop. Game assets remain local.
`node --test orchestrator/tests/game-input.spec.mjs` checks native mouse release and focus loss.
For sustained macOS gameplay inspection, use the isolated
[gameplay probe](docs/evidence/gameplay-input-macos-2026-09-05.md); native mouse locking requires
an unlocked console and has a separate qualification command.
`RENGINE_NOLF_ROOT=/absolute/checkout node --test orchestrator/tests/agent-desktop.spec.mjs`
boots the installed Codex CLI and checks its connected rEngine tool list without sending a
coding prompt. Keep credentials and generated runtime evidence local.
`RENGINE_NOLF_ROOT=/absolute/checkout npm run test:workspace` checks the combined launch command,
two-root editing, agent tools and reuse after GUI exit. It opts into `--inspect-ui`, which enables
an ephemeral local Electron debugging endpoint; ordinary launches leave debugging disabled.
See the [combined workflow evidence](docs/evidence/nolf-workspace.md) for the current scope.

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
