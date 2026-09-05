# Proposed roadmap

Status: **draft for owner review**. The charter's first round may change the first milestone.
[features.proposed.json](features.proposed.json) contains the concrete proposed acceptance slices;
it becomes `features.json` only after review. All features are initially non-passing. Harness setup
itself is recorded in the progress log, not disguised as completed product functionality.

## Milestones and exit conditions

| Milestone | Proposed features | Deliverable | Exit condition |
| --- | --- | --- | --- |
| M0 — agree on the product | F1 | Reviewed charter and prioritized pilot | First workflow, project independence, “powered by” meaning, platform scope and non-goals decided. |
| M1 — prove a shared tool | F2–F8 | Project adapter, evidence contract, local runner, one native check per engine | Both native checks retain identical outcomes through the shared tool; artifact hashes and timeout/skip/error semantics verified. |
| M2 — adopt the harness | F9–F12 | Minimal templates, independent tool pins, upgrade/rollback proof | Each consumer adopts from its own workspace, keeps local rules, and works without sibling paths. |
| M3 — curate real components | F13–F17 | Catalog contract, pin/override rules, iklib recipe, infra-vr packaging plan/proof | One component is consumed independently by two host-shaped fixtures; unsupported profiles remain explicit. |
| M4 — prove runtime adoption (optional branch) | F18–F21 | Existing IK migrations and their host evidence | reSource core then reLith parity, separate finger follow-up, and per-game compatibility evidence. |
| M5 — connect work to learning (optional branch) | F22–F25 | Report/repro evidence and explicit training intake bridge | Eligible record reaches training's validation path; held-out/hidden/tampered examples are rejected. No training run implied. |
| M6 — validate breadth and maintainability | F26–F30 | Resource coordination, reuse assessment, new-host trial and compatibility/audit summary | Adoption and failures remain inspectable; further extraction justified by real consumers and measured cost. |

The proposed first useful product is **M1**, not completion of the whole table. M3 can follow M0
alongside the tool branch if packaging is the chosen pain point. M4 and M5 are separately scoped;
neither is required merely to build a game. F26's reservation work precedes shared-device or
concurrent runner claims; the first runner proof can use isolated CPU fixtures.

## First integration slice, concretely

Recommended pilot: wrap one CPU check from NOLF and one from VtMB using each host's native
invocation, record structured outcomes plus raw logs and source identity, and demonstrate that a
failed/skipped/timed-out check cannot be reported as passing. Use isolated prepared workspaces
when actual native commands would mutate builds. Initial source discovery is read-only.

The exact pair of checks and target platform are deliberately selected in F1 with the owner.
That selection fixes the M1 budget and avoids a generic orchestration project with no acceptance
case. The proof must include actual invocations from both engines before claiming M1 complete;
fixtures alone only qualify the runner implementation.

## Planning precision

Each proposed feature has an owning workspace, dependencies, acceptance criteria, and an output
artifact. A host-owned migration cannot become ready just because rEngine's local dependency
graph is green: confirm the referenced host feature, current seam and workspace authority first.
`tools/features.py next` only offers work owned by this checkout; external rows are handoffs.

Near-term features are implementation slices. Later discovery features end in a decision or
bounded follow-up list, not a promise to implement an unknown renderer/ECS/editor. No calendar
dates or session estimates are asserted without the selected pilot and available hardware budget.

Before starting a feature, write its spec with:

- Current source identity, exact affected API/files and external prerequisites.
- User-visible result and what would falsify the design.
- Commands, fixtures, baseline, pass/fail rules and required manual/device evidence.
- Change owner and consumer owner, version/pin policy, and rollback method.
- Maximum initial slice; new discoveries become explicit follow-up work.

## Scope choices still requiring answers

- Whether the first deliverable is shared tooling, runtime adoption or a complete training loop.
- Whether any capability is mandatory for “powered by rEngine.”
- infra-vr's product relationship, catalog admission and dependency distribution policy.
- Platform/mode priorities, available hardware, per-run budgets and automation authority.
- Whether “AI-era” includes in-game inference or focuses on the development lifecycle.

## Explicitly deferred pending demand

A new renderer, engine-wide ECS, editor, universal game object model, package hosting service,
general distributed scheduler, custom model runtime and training cluster have no approved
deliverable here. Each would need a concrete consumer problem and a separate decision.

Generate the graph from the active reviewed inventory (or the clearly labeled proposal):

```sh
python3 tools/features.py graph > docs/roadmap-graph.md
```
