# Quality library base — proposal

Status: quality-standard recommendation for the design interview. The owner confirmed curated
upstream plus our own gaps, iklib proven in both games first, and verified pinned capability
adoption as the powered-by minimum. Detailed standards and pilot profiles remain proposed.

## What rEngine contributes

A selected library should arrive with enough verified implementation and integration knowledge
that an agent can use it in a new game without reconstructing hidden assumptions. The proposed
unit of curation contains:

- The implementation's origin, maintainer, license information and immutable reviewed revision.
- A clear capability description, selection tradeoffs and known limits.
- Explicit API, data, ownership, threading and resource contracts appropriate to that component.
- Minimal executable consumption examples and meaningful correctness checks.
- Tested integration recipes and a compatibility record scoped to actual consumers/platforms.
- Upgrade history, known failures and a way for each consumer to pin or roll back independently.

This can describe an upstream package, an independent library such as iklib, or a new component
authored to fill a demonstrated gap, following the confirmed ownership strategy. The extent of
wrapping any particular API remains a design choice. Add adapters where real integration
differences justify them.

## Proposed quality dimensions

| Dimension | Evidence to require | What must stay explicit |
| --- | --- | --- |
| Capability and scope | Named game need, public API and usage example | What the component does not implement and when another choice is appropriate |
| Correctness | Tests that detect meaningful failures; reference/replay evidence where parity matters | Numerical tolerances, malformed-input behavior and unavailable oracles |
| Composition | Standalone consumption plus real host usage; no unrelated module dependency | Lifecycle, allocation ownership, callbacks, thread use and host-side policy |
| Resource behavior | Measurements for representative workloads on the claimed platform | Latency, memory/allocation behavior, limits and test configuration; budgets set per capability |
| Portability | Actual build/runtime evidence for listed targets and profiles | Verified versus pending/unsupported platforms; optional dependencies |
| Maintenance | Source/version provenance, change history, known issues and upgrade/rollback recipe | Who owns fixes and what compatibility is promised |
| Agent usability | A short entry point, precise contracts, executable examples and actionable diagnostics | Which inputs an agent must supply and what checks establish a correct integration |

Zero allocation is appropriate to iklib's declared solve contract; it is not a blanket rule for
every parser, tool or asset importer. Likewise, the quality base does not require every library
to adopt one math type, C ABI, ECS, renderer or build generator. Composition must make conversions
and ownership visible at the actual boundary.

## Admission and proof

Recommended progression:

1. **Candidate:** source and intended capability identified; suitability still under evaluation.
2. **Qualified component:** applicable contracts, tests, consumption recipe and resource evidence
   have been reviewed. Claims are limited to the exact version and configurations tested.
3. **Verified adoption:** a named game's actual implementation uses the component and passes its
   own relevant gates. This is recorded separately for every consumer.

For the first base-building pilot, the owner selected two real game consumers. This should expose
assumptions that isolated library tests miss. It is not yet a rule
that every useful library must already be used by two games before it can enter the catalog.

## Confirmed first library: iklib

The existing source inventory identifies a portable implementation, host presets and pending
real-game migrations. The owner selected iklib in D23. The proposed success case is:

- Freeze a reviewed iklib revision and document the usable contracts/consumption example.
- Recheck reSource and reLith's current integration differences, including NOLF's unresolved
  parameter comparison and reSource's separate finger seam.
- Use native host gates and recorded old/new behavior to complete the selected migrations from
  their owning workspaces. Remove the replaced production duplication after parity is proven.
- Record integration effort, resource behavior and maintenance/rollback evidence. Judge whether
  the base reduced repeated solver work while preserving each game's architecture.

Fixtures remain useful for the package boundary; real host adoption establishes the intended
product value. The [pilot draft](specs/001-library-pilot.md) keeps core solver parity and the
separate finger migrations distinct. Naming the library does not claim that migration is complete.

## Confirmed powered-by minimum

D24 requires at least one curated capability at a pinned version with passing game integration
checks. The IDE and shared harness are optional. The record should name the capability, component
revision, host revision, game/platform/profile and evidence; a manifest format is still proposed.
Only verified rows earn the claim. A NOLF result does not certify AVP2/NOLF2 or another platform.
Games select and upgrade capabilities independently and keep their own framework and host gates.

## Coverage to map before expanding the collection

Read the actual dependency and duplication boundaries in both games, then classify the needed
capabilities: platform/input, rendering support, audio, physics/collision, math/animation/IK,
formats/assets, concurrency, diagnostics and reporting. Existing donor evidence already shows
different SDL versions, a reSource Jolt dependency, iklib, and shared infra-vr consumption.
These are source observations, not a new recommendation or a qualified package inventory.

For each capability, decide whether to curate existing implementation, extract a shared component,
author a missing piece, or leave it host-local. Avoid promising a full engine's worth of modules
before those choices and their consumer needs are established.

## Remaining design questions

- Where are common conventions worth their adapter cost, and where do they constrain a game?
- Which exact iklib revision, game profiles and parity scope will establish the first proof?
- What measured benefit and quality bar justify calling that proof successful?
- Which record format makes the confirmed powered-by minimum easy to verify and maintain?
