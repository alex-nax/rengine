# Existing-project reconnaissance — 2026-09-05

This is a read-only inspection of local documentation, build configuration, trackers and recent
logs. No games, builds, devices, hosted services or training jobs were run. Some worktrees were
active. [source-inventory.json](source-inventory.json) records the observation's commit IDs,
working-file hashes, and whether each file matched HEAD; revalidate before extracting code.

## What already exists

| Project | Observed design | rEngine implication |
| --- | --- | --- |
| reLith / `nolf-improved` | C++17, cmkr/CMake, SDL2 desktop layer; ILT compatibility seam; NOLF, AVP2 and NOLF2 build paths; shared source across games | Model engine family and individual game target separately; a NOLF result cannot certify AVP2/NOLF2. |
| reSource / `vtmb-vr` | C++17, cmkr/CMake, SDL3; formats and Source entity/Python interfaces; separate composition layer; Jolt in build configuration | Share tools through adapters; preserve its entity, scripting, physics and coordinate contracts. |
| `iklib` | Standalone C++17 library; explicit host frames/scales/capabilities; no required engine/math/physics/runtime dependency; host presets outside core | Curate the existing package and migration plan; avoid wrapping it in a second universal IK API. |
| `infra-vr` | Shared C99 reporting ABI, launcher, Go backend, schema fixtures; already referenced by both engine builds | Reporting and distribution have an existing owner. Scope rEngine's contribution to packaging, evidence and integration needs. |
| `vr-port-agent-training` | Versioned environment/rubric schemas, verifier tooling, isolated rollouts, frozen eval boundaries, readiness gate | Exchange evidence at an explicit boundary; preserve training ownership and isolation. |

`reLith` and `reSource` are the product-family names in this plan. Repository names, current
executable targets, and source namespaces remain as observed; this setup does not rename them.

## Concrete reusable seams

**Harness workflow.** All four named projects use an instruction file, structured feature
inventory, progress history, specs and executable checks. The game ports share substantial
feature-query and workflow patterns. Their local rules differ: progress filenames, required
runtime tiers, slow tests, and approval expectations must remain representable per project.
Sources: each project's `AGENTS.md`; reLith `docs/harness-workflow.md`; training
`docs/architecture.md`.

**Verification evidence.** reLith's `scripts/world_smoke.py` emits stable world-entry facts and
distinguishes skip exit 77 from pass. reSource's instructions distinguish its everyday
`ctest -LE slow` gate from additional relevant slow/corpus checks and visual judgment. Training's
verifier reports criteria individually and retains infrastructure failures. This motivates a
shared evidence envelope around native checks, rather than one engine-specific test runner.
Sources: those files and training `harness/verifiers/README.md`.

**Dependency adoption.** reLith `cmake.toml` around `INFRA_VR_DIR` and reSource's corresponding
block compile selected infra-vr sources directly. Both avoid its parent cmkr project because of
option/target collisions. reSource also controls microui linkage to avoid duplicate definitions.
The local path and conditional behavior deserve a packaging proof before declaring a curated
dependency reproducible. This is stronger evidence for a first packaging task than an invented
library catalog with no consumers.

**IK integration.** `iklib/README.md` documents source-tree consumption and explicitly says
presets are not completed host migrations. Its `docs/roadmap.md` and F130/F131/F132/F133 provide
the existing ownership and acceptance criteria. The pending NOLF constant comparison (V2)
must be resolved before choosing host parameters. reSource's finger solver lives outside the
main `src/vrik` extraction and needs its own follow-up.

**Training.** Recent training logs record real isolated NOLF and VtMB rollout bundles, including
graded failures. Their presence is evidence of the pipeline's work, not of solved tasks or
completed fine-tuning. F30 plus owner GO remains the training repository's stated readiness
boundary. Its held-out `uhexen2` material must stay outside training and general shared context.

## Where sharing would currently be a mistake

- A mandatory SDL, ECS, physics or renderer choice would collide with real host differences.
- A global coordinate convention would force engine churn; iklib already accepts host conventions.
- Merging the ports' trackers would obscure game-specific dependencies and completion evidence.
- Reimplementing report UI/backend or IK here would create additional authorities for existing work.
- Sharing an unrestricted project index with rollout agents could leak hidden fixes and eval data.
- Treating a clean harness check as proof of visual parity would erase the device/oracle tiers.

## Status caveats

The owner reports NOLF working and AVP2/NOLF2 in progress. Old READMEs still describe much earlier
milestones, while trackers contain pending or re-opened work. This document makes no percentage
playability claim and does not infer readiness from feature counts.

Inspection also found other local libraries/submodules, but their APIs and suitability were not
evaluated. Catalog expansion requires a named consumer and its own bounded reconnaissance task.
