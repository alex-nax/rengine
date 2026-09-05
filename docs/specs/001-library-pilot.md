# First library proof: iklib in reSource and reLith

Date: 2026-09-05. Status: **pilot draft; F1 remains proposed and incomplete**.
Owner decisions: charter D08/D09/D23/D24. The library is selected; no new host migration or
runtime verification is claimed. [Integration plan](../integration-plan.md) records source seams.

## Confirmed outcome and proposed slice

Curate upstream libraries and author demonstrated gaps. First prove iklib in both games, preserving
their independent architectures. A pinned curated capability with passing game integration checks
meets the powered-by minimum; neither the IDE nor the shared harness is required.

Proposed first slice: migrate the existing core IK paths in VtMB and NOLF, preserving behavior.
Follow iklib's existing order: reSource core (`iklib:F131`, rEngine F18), then NOLF parameter parity
and adoption (`iklib:F130`, rEngine F19). This is separate from NOLF-first desktop integration.
ReSource fingers (`iklib:F133`, F20) and new NOLF fingers (`iklib:F132`) are separate capabilities;
their incompletion must not block an evidence-backed claim about the selected core solver.

## Concrete delivery sequence

1. Recheck the active host seams and iklib contract; record reviewed revisions and any working
   patches. Declare supported solver inputs, basis/units/pose space, quaternion layout, ownership,
   thread use, allocation behavior and host parameters. Do not standardize the games' internal types.
2. Curate the actual supported source-tree CMake consumption path at an immutable pin. Build two
   small fixtures with different frames/scales and test namespace/options isolation. No nonexistent
   installed package or implicit sibling lookup belongs in the recipe.
3. In the VtMB workspace, bind a host-owned task to F131. Establish old/new pose comparisons and
   existing host gates, migrate the selected core path, remove replaced production duplication and
   verify rollback. Record required runtime/device observations under that host's rules.
4. In the NOLF workspace, resolve F130's V2 parameter comparison before changing solver behavior.
   Use explicit host parameters where needed, apply its existing gates and check every reLith game
   whose shared source/build closure changed. Record pending targets separately from passes.
5. In rEngine F21, link both host migration commits and immutable evidence. Record integration
   effort, retired duplication, correctness, representative resource costs and independent rollback.
   F20 later adds finger evidence without expanding the meaning of the already-proven core rows.
6. Produce scoped powered-by records (F29). ReSource and reLith can remain on different reviewed
   revisions when their own compatibility evidence supports those pins; release cadence stays local.

## Proposed quality and rejection criteria

| Area | Required before accepting the pilot |
| --- | --- |
| Correctness | Predeclared tolerances and representative recorded poses; native regression gates detect meaningful failures. |
| Behavior parity | Separate parameter differences from solver differences; no new finger behavior smuggled into the core migration. |
| Composition | Minimal host fixtures and actual consumers work without unrelated engine libraries, target collisions or hidden downloads. |
| Resource behavior | Measure representative solve time and contractually relevant allocations with reproducible fixtures and machine/profile identity. |
| Agent usability | Short contract entry point, executable example, host adapter recipe, actionable diagnostics and exact verification commands. |
| Maintenance | Owned upstream/host changes, independent pins, known limits and tested rollback; remove obsolete production solver copies after parity proof. |

Reject or narrow the proposed extraction if preserving host policy requires game internals in the
portable core, if parity cannot be demonstrated, or if the reusable API costs more than the local
implementation without a measured benefit. Record failures and revise the bounded slice; do not
enlarge rEngine into a required common runtime to force adoption.

## Inputs still required before implementation

- Reviewed library/host source identities, matching host tasks and current external F130/F131 status.
- Exact core solver coverage, old/new pose fixtures, numerical tolerances and behavior oracle.
- Claimed platform/flat/VR profiles, reference hardware, native commands and required manual checks.
- Per-capability resource thresholds and a bounded effort budget before the extraction starts.
- Applicable provenance/license/maintenance requirements from the library-quality proposal.

F1/F31 capture these inputs; naming iklib alone does not complete either. Cross-project rows are
executed from their owning workspace, and rEngine records their evidence without changing external
feature flags. No training export or model run follows automatically from a successful integration.
