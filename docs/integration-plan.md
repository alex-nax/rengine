# Integration plan

Status: **proposed**, pending the charter interview. This document plans host-owned work; it does
not authorize or claim modifications to the reference workspaces. Task IDs below are rEngine
proposal IDs unless prefixed with an external repository name.

The owner clarified that the library base is primary (charter D07). The tables below describe
independent capability paths, not a requirement to complete R-L1–3/R-S1–3 harness adoption before
runtime work. The owner-selected first library proof uses the existing iklib migrations and native
host gates; shared runner implementation can follow a demonstrated need. Exact pilot profiles
remain to be specified; the owner confirmed iklib in both games. See
[quality proposal](library-quality.md).

The owner then selected the desktop orchestrator as the first implementation milestone, with
macOS/Windows, terminals and actual flat-game output in a new tab. Its F42 surface contract and
F43/F44 host adapters are independent of the library migrations and earlier harness-adoption
rows below. Flat NOLF is the owner-selected first workspace target; reSource follows through its own
adapter. [Orchestrator scope](specs/002-orchestrator.md) includes retained sidecar sessions, the
session browser, basic editing/Vim and the later Quest 2D client.
The [desktop v0 acceptance draft](specs/032-desktop-v0.md) separates the confirmed workflow from
host revisions, native commands and performance budgets that still need to be established.

## Shared acceptance rule

Every adoption names the consumer repository, game target, reviewed component/tool revision,
host commit and any dirty-tree patch hash, build profile, commands, actual results, and artifact
hashes. A supported-platform claim requires evidence on that platform. Pending device judgment,
missing assets and infrastructure problems remain visible and prevent the relevant claim.

Before integration, recheck the dated [source inventory](source-inventory.json). For a changed
seam, record the current behavior and freeze a replay/oracle before replacing it. Shared code
must pass its own tests and the consumer's existing acceptance gates.

## reLith — staged by game

| Stage | Owning workspace | Change | Required evidence / rollback |
| --- | --- | --- | --- |
| R-L1: observe | rEngine | Describe the native commands and inventory/progress locations in a tool adapter | Read-only command plan distinguishes NOLF, AVP2 and NOLF2; no build or game launch while inspecting. |
| R-L2: first workflow | rEngine + later host task | Wrap one approved native check and preserve its raw log/status | Same command succeeds/fails identically with and without the wrapper; timeout and skip remain non-passes. Remove wrapper to return to native workflow. |
| R-L3: harness adoption | `nolf-improved` | Pin a reviewed tool release and add a small local adapter | Existing feature IDs/logs/rules remain authoritative; clean checkout works without sibling directories; rollback changes the pin/adapter only. |
| R-L4: IK parity | `nolf-improved`; coordinates with `iklib:F130` | Resolve V2 parameter differences; adopt iklib at one existing arm seam | Old/new recorded outputs match within a predeclared tolerance; host tests pass; obsolete solver is removed only after parity; revert the migration commit/pin for rollback. |
| R-L5: shared-game check | `nolf-improved` | Exercise every game whose source/build closure was affected | Record separate NOLF, AVP2 and NOLF2 results. For a target without the capability, prove unaffected build/runtime behavior; an untested target is pending. |
| R-L6: new capability | `nolf-improved`; `iklib:F132` | Optional fingers after arm migration | Separate behavior-change task; no retroactive expansion of the parity migration. |

Observed native entry points include `./init.sh`, `cmake --build build`, `ctest --test-dir build`,
lint/format targets, `relith-nolf --selftest`, `scripts/world_smoke.py`, and `ctest -L smoke`.
Resolve the exact active configuration and per-game target from the current build files before
execution. The current repository has additional scoped gates; the adapter must not silently
replace them with a shorter generic command.

NOLF is the proposed first reLith pilot because the owner reports it working. This is a planning
recommendation, not a claim that AVP2 or NOLF2 are blocked from selective harness adoption.

## reSource — preserve its own architecture

| Stage | Owning workspace | Change | Required evidence / rollback |
| --- | --- | --- | --- |
| R-S1: observe | rEngine | Describe native commands and project-local verification tiers | Adapter distinguishes ordinary CTest, relevant slow tests, data/oracle checks and manual VR results. |
| R-S2: first workflow | rEngine + later host task | Run the same shared tool capability as R-L2 around a native reSource check | Raw results agree with direct invocation; no assumption of reLith's executable names, SDL or asset layout. |
| R-S3: harness adoption | `vtmb-vr` | Pin tool version with local policy overrides | Standalone checkout and rollback proven; local instruction/progress authority retained. |
| R-S4: IK parity | `vtmb-vr`; `iklib:F131` | Replace `src/vrik` with library-backed implementation and thin necessary glue | Existing IK tests plus recorded-pose equivalence; verify allocation and host contract; remove duplicate solver source. |
| R-S5: finger parity | `vtmb-vr`; `iklib:F133` | Replace the separate engine finger solver | Dedicated finger recordings and collision-provider behavior; no assumption F131 already covers it. |
| R-S6: capability sign-off | `vtmb-vr` | Record the precise adopted rEngine capabilities and supported profiles | Only tested platform/mode combinations listed; human/device judgment retained where required by the host. |

Observed build targets include `vtmb`, `vtmb-vr`, and `vtmb-vr-android`. The ordinary gate in
`AGENTS.md` is `ctest --output-on-failure -LE slow`; changes covered by slow tests require that
tier as well. `src/app` composition, Source entity/Python seams, Jolt integration, and host
coordinate policy remain local.

iklib's own roadmap recommends the VtMB core migration before NOLF. Preserve that order for the
selected IK branch unless current host recon provides a reason to change it; this does not force
the same order on the desktop adapters or shared-tool pilots. F21 records the F18/F19 core proof;
F20 fingers updates the evidence separately and does not delay that core adoption claim.

## iklib — integrate, do not duplicate

The catalog entry should point to a reviewed immutable iklib revision, its native `iklib` CMake
target and integration guide. Source-tree consumption is supported; a nonexistent install/config
package must not be advertised. The package proof uses two minimal consumers with different host
frames/scales and demonstrates that unrelated tests, downloads and target names do not leak into
consumer builds.

The real migrations remain the authority of `iklib:F131`, `F130`, `F133`, and `F132` plus matching
host features. rEngine records links to their evidence; it neither invents replacement solver work
nor flips their feature flags. Adding a future framework such as flecs should require a host-side
adapter, not edits to the portable core merely to recognize that framework.

## infra-vr — existing infrastructure boundary

First decide its desired relationship to rEngine during the interview. The proposed default is
an independent catalog provider for reporting, launcher and distribution services.

The first technical task is a packaging reconnaissance: identify the minimum embeddable target
closure, target/option collisions, microui ownership, optional HTTP transport and platform needs.
Then propose a pinned consumption recipe exercised by both host shapes. Preserve the current
report transport and UI behavior; packaging should not require operating its production backend.

Report/save intake is a later explicit bridge. Define report IDs, game/build identity, archive
hashes and reproduction steps. Test with synthetic or appropriately local fixtures; real uploaded
reports, credentials and user-owned assets are not copied into this repository during setup.

## Agent-training handoff

Keep three activities separate:

1. Normal development records immutable task/run evidence.
2. An explicit bridge classifies and exports eligible records with source/tool hashes.
3. The training repository validates splits, isolates candidate/grader material, selects rubrics,
   runs evaluations, and decides model-training readiness.

Proposed first bridge proof: a synthetic record accepted end to end by the current schema path,
plus negative cases for held-out identity, hidden-fix material, missing provenance and tampered
hashes. A successful export does not mark a task solved or authorize a LoRA run. Real-record
adoption requires a training-owned task and its normal review gates.

The proposed rEngine check envelope must preserve all raw training-verifier fields or use an
explicit versioned adapter. It must not flatten infrastructure failures into ordinary failures
or reward values. Fix-test overlays remain grader-only; their implementation is not moved into
the normal development runner.

## Upgrade and rollback protocol

1. Component owner releases a reviewed revision with a changelog and supported contract version.
2. Each engine separately selects a pin and records its baseline/gates.
3. Adopt one capability, run component and host checks, retain immutable evidence.
4. Record the verified compatibility row for that specific engine/game/platform/profile.
5. Prove rollback to the preceding pin or migration commit using the same relevant gate.

Do not require synchronized releases or migrate both engines in one unreviewable change. Temporary
old/new comparison code may exist in an isolated parity test; a completed migration removes the
obsolete production implementation. If host-specific policy overwhelms the shared API, stop the
extraction and document the evidence rather than expanding the common runtime indefinitely.
