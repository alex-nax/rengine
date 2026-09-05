# rEngine

rEngine is a quality library base for AI-assisted development of purpose-built game engines.
Its curated components, integration knowledge, tools and harness support independently maintained
projects. reLith and reSource are its first intended consumers. The eventual name is **realEngine**.

The planned IDE is a tab-and-pane orchestrator: arrange terminals, project/file views, coding
agents, live game output and integrated tools in one workspace. An initial agent terminal will
run a Bash selection/installation launcher and bootstrap that agent's project integrations.

**Status: initial design interview and harness setup.** The project boundary is established by
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
No engine has been migrated and no IDE implemented by this repository.

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
helper validates the proposal and reports that execution has not been activated.

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
