# rEngine

rEngine is the shared development harness, curated library collection, and tooling for
independently maintained game reimplementations. reLith and reSource are its first intended
consumers. The eventual name is **realEngine**.

**Status: initial design interview and harness setup.** The project boundary is established by
the owner's brief; the first deliverable, adoption contract, and implementation order are still
under review. No engine has been migrated by this repository.

The aim is to make game work easier for people and coding agents: discover the right tools,
make bounded changes, reproduce behavior, retain trustworthy verification evidence, and feed
eligible work into the separate agent-training project.

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
| [Project reconnaissance](docs/reconnaissance.md) | Evidence from the existing repositories |
| [Roadmap](docs/roadmap.md) | Proposed milestones and their exit conditions |
| [Integration plan](docs/integration-plan.md) | reLith, reSource, iklib, infra-vr, and training handoffs |
| [Known issues](known-issues.md) | Current gaps and uncertainties |

## Current ecosystem

| Project | Relationship |
| --- | --- |
| `nolf-improved` / reLith | NOLF working per owner; AVP2 and NOLF2 in progress; first engine-family consumer |
| `vtmb-vr` / reSource | Independently maintained Bloodlines reimplementation; second consumer |
| `iklib` | Independent portable C++17 IK library; candidate for the curated collection |
| `infra-vr` | Existing shared reporting/launcher/backend project found through both engine builds |
| `vr-port-agent-training` | Independent dataset, rollout, evaluation, and post-training authority |

Local paths used during reconnaissance are conveniences, not required dependency locations.
The checked-in inventory is a dated observation, not a lockfile or compatibility guarantee.
