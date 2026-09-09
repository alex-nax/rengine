# Proposed roadmap

Status: **draft for owner review, revised after the library-base clarification**.
[features.proposed.json](features.proposed.json) contains the proposed acceptance slices;
it becomes `features.json` only after review. All features remain non-passing. The existing
bootstrap is setup infrastructure; shared libraries and real integrations have not been
implemented by rEngine yet.

## Product direction

The owner selected a quality library base as the primary value: AI can help build individual
implementations around a game's needs, using dependable components. Our first recommendation of
leading with a shared command runner is superseded. The proposed path now establishes library
quality and proves actual adoption; supporting harness work follows concrete needs.

The owner confirmed curated upstream plus our own gaps and iklib proven in both games first.
Its host tasks already exist and retain their ownership and acceptance criteria. A verified
pinned capability meets the powered-by minimum; the IDE and shared harness are optional.

The owner subsequently added the IDE/orchestrator and selected **desktop workspace, terminals
and a flat game rendered into a new tab as the first implementation milestone**, on macOS and
Windows from the start. The library base remains an independent product path. See the desktop
milestones below; implementation need not wait for the entire library/training charter.

The owner subsequently fixed the desktop GUI to C with microui and excluded Electron/runtime
browser overhead (D26–D27). The [native migration](specs/056-native-desktop.md) replaces the earlier
UI implementation within the same accepted feature scope. A later web client remains separate;
native desktop qualification must establish its own evidence on both platforms.

## Library and reusable harness milestones

| Milestone | Proposed features | Deliverable | Exit condition |
| --- | --- | --- | --- |
| M0 — define the base and quality bar | F1, F31 | Reviewed charter, first proof and library quality standard | Library ownership/wrapping policy, selected capability, quality criteria, target profiles and success measures decided. |
| M1 — qualify real components | F13–F17, F27 | Capability map, catalog admission, pins, iklib recipe and infra-vr packaging work | First selected component has verified contracts, consumption examples, resource requirements and a concrete host integration path. |
| M2 — prove value inside games | F18–F21 | iklib adoption in reSource and reLith, separate finger follow-up and per-game evidence | Actual host behavior/gates hold; obsolete duplicated implementation is removed; integration cost, resource behavior and rollback are recorded. F20 fingers is a follow-up, not a prerequisite of the core proof. |
| M3 — support composition and maintenance | F2–F12, F26 | Reusable verification/evidence tools, minimal harness templates and resource coordination | Tools address observed integration needs and preserve the native host outcomes, local authority and independent upgrades. |
| M4 — connect work to learning | F22–F25 | Report/repro evidence and explicit training intake bridge | Eligible evidence reaches training validation; held-out/hidden/tampered examples are rejected. No training run implied. |
| M5 — validate breadth and maintainability | F28–F30 | Independent host fixture, scoped powered-by records and quality audit | Adoption remains independent and evidence-backed; next base expansion follows measured consumer needs. |

The first proposed product proof combines the chosen M1 library with its M2 real-game adoption.
The separate infra-vr recipe and finger migration need not delay that first proof unless selected
as part of its scope. The larger table remains a planning inventory, not a requirement to finish
all entries before rEngine delivers value. M3 is not a prerequisite for M1/M2: existing native
checks and host harnesses can establish the first library's evidence.

F26's reservation work precedes shared-device or concurrent runner claims. This does not grant
authority to launch a device or require a distributed scheduler for local library work.

## First library proof, concretely

Owner-selected library: iklib. It already has portable solvers, integration presets and pending
host migrations. Define the [quality standard](library-quality.md), recheck the current seams,
pin one revision, and complete the selected adoption work using native host gates and recorded
behavior. The integration plan keeps reSource core, NOLF parameter parity, separate reSource
fingers and per-game reLith evidence distinct.

Measure what the base contributes: duplicated implementation retired, effort needed to integrate,
correctness/behavior preserved, representative resource costs and the ability to upgrade/revert
one game independently. Set tolerances and budgets before executing the proof. A small package
fixture establishes consumability; a working real host establishes adoption.

The [pilot draft](specs/001-library-pilot.md) scopes the first proof to existing core IK in both
games. F21 depends on F18/F19; F20 fingers contributes a separate later evidence update. This
keeps the graph consistent with the original separate-finger scope and the two-game core proof.

## First desktop release and later workspace capabilities

The [orchestrator spec](specs/002-orchestrator.md) records the owner decisions and detailed
workflow. The first useful desktop release includes the O0/O1/O3 path through **F48**; an empty
shell or terminal-only app does not complete it. F43 is a real host-owned game integration.

| Milestone | Proposed features | Exit condition |
| --- | --- | --- |
| O0 — qualify the implementation | F32–F33 | Pin the selected NOLF baseline and scope; prove terminal/editor/game-surface feasibility on macOS and Windows before selecting the stack. |
| O1 — workspace and retained sessions | F34–F38, F54 | Splits/tabs, real terminals, tree/previews/basic editor with optional Vim, independent sidecar, persistence and session browser work on both desktops. |
| O3 — live game and tool views | F42–F45 | Cooperative surface contract and actual host output/input; F43 supplies the first flat game, F44 adds reSource and F45 another tool separately. |
| O5 — desktop v0 complete | F48 | Actual empty-to-split/edit/terminal/game-tab workflow, moves, detach/browser/reattach, GUI restart and explicit stop, on both desktops. |
| O2 — CLI agent onboarding | F39–F41 | Bash selector/installer recipes and project MCP bootstrap work visibly and independently of the GUI. |
| O2 (extended) — agent protocol | F113–F114 | One declared agent recipe registry replaces four private tables, then an ACP session kind for the agents that speak it natively; Claude stays on PTY and `/ide` because its SDK forbids third-party subscription login (D46). |
| O4 — optional native XR control | F46–F47 | Native runtime compatibility and real session-specific Operator proof; no assumed Unity scene support. |
| Q0–Q2 — Quest 2D client | F49–F52 | Delivery decision, paired desktop link, real editor/terminal access and live game stream on a headset with each desktop sidecar. |
| A0 — external-app feasibility | F53 | Finite Mac/Windows app matrix for capture/control and optional Windows reparenting, with honest view-only/interactive limitations. |
| T0 — tests attached to tasks | F115–F117 | A task shows the evidence that backs it, a project declares a tests manifest rEngine reads and never runs, and a verdict on a test is filed as a task in the project that owns it (D47). |
| H0 — the game-driven harness | F118–F119 | An agent drives and observes a running game through the surface transport the workspace already ships, closing KI-024's missing state oracle; a scenario produces a recording manifest and a human verdict, never a boolean (D48). |
| R0 — GPU renderer core and OpenGL | F56–F57 | Backend-neutral draw list with the SDL_Renderer reference adapter, then an OpenGL adapter matching it within recorded tolerance and measured budgets (macOS landed; Windows evidence is F62). |
| R1 — Metal and Vulkan adapters | F58–F59 | Each adapter matches the reference on its platform with the same comparisons and measurements. |
| R2 — theming update on the GPU renderer | F60 | The Claude Design cards are matched natively with presets, theme files and live reload; existing gates stay green. |
| R3 — rendering library candidacy | F61 | Library-quality record, conformance checks and one game adoption through an adapter. |

The O/Q/A names identify independent branches; their numbers do not override dependency order.
F32 is independently selectable ahead of the broader library-charter feature F1. The owner
selected flat NOLF first and VtMB second; exact host revisions, native builds and scope are
established in F32 and the later F44 spec. The [desktop acceptance draft](specs/032-desktop-v0.md)
records the confirmed workflow and remaining qualification inputs. F44 is a later second-engine adapter,
not a reason to postpone the first NOLF workflow or a claim that NOLF evidence covers VtMB.

Closing tabs/windows detaches views, while the sidecar retains sessions. The session browser is
required in v0. Workspaces support multiple project/worktree roots with explicit session bindings;
the desktop proof exercises identical filenames and similarly named sessions across roots.
Basic editing includes the agreed optional Vim subset; a full IDE language-server
or debugger ecosystem is not part of that requirement. Unsaved edits survive as local recovery
drafts; working files change only on explicit Save. Agent installation, Quest distribution,
external apps and XR automation have distinct gates after the first desktop proof. The ordering
of those later gates relative to the first library proof remains a prioritization decision.

Quest uses the shared 2D workspace first; independently placed spatial panes follow later.
Official [feasibility research](research/quest-and-app-surfaces.md) supports Android/PWA delivery
options. A package, remote input/stream and native Quest-game coexistence must each be tested
before claims are made. macOS/Windows support is required from the first desktop release.

## Planning precision

IDs remain stable across this unapproved draft's revision; milestone membership, priorities and
dependencies reflect the library-first direction. Each feature has an owning workspace,
dependencies, acceptance criteria and output. Accepted feature history has not been rewritten.

A host-owned migration requires the referenced host feature, current seam and workspace authority;
a green local dependency graph alone cannot satisfy those prerequisites. `tools/features.py next`
only offers approved work owned by this checkout. External rows are handoffs.

Before starting a feature, write its spec with:

- Current source identity, affected interfaces/files and external prerequisites.
- Consumer result, selection tradeoffs and evidence that would falsify the design.
- Commands, fixtures, baseline, resource budgets and required manual/device observations.
- Component/consumer owner, version policy and rollback method.
- Maximum initial slice; discoveries become explicit follow-up work.

Near-term entries describe implementation slices. Later discovery entries end in decisions and
bounded follow-ups. Calendar dates and effort estimates await the selected proof and resources.

## Open decisions

- iklib pilot profiles, detailed quality bar and per-component conventions.
- Desktop toolkit, NOLF build baseline, root/draft persistence details, initial Vim subset and resource budgets.
- Later agent recipes/Windows Bash environment, Quest packaging and runtime-control ownership.
- Adoption-record format for the confirmed pinned-capability minimum and independent upgrades.
- infra-vr's product relationship and the meaning of the two streams.
- In-game inference scope and training data boundaries. **Automation authority is now partly settled**: D48 puts agent-driven
  input and recording behind the existing explicit, token-gated launch path, and a run records evidence only.
- Whether the graphics-API abstraction becomes a bundled pack, and what a game would actually adopt: D48 names the
  consumer need, and spec 114 records that our draw list is 2D UI and our Vulkan backend is SDL-surface-bound, so
  adoption means extracting a device layer that does not exist yet.
- Renderer details (spec 066): icon set and license, UI font policy, owned control layer versus a
  microui fork, OpenGL floor, first Vulkan platform, and whether R0 starts before F48.

## Expansion requires a consumer need

A common ECS, universal game object model, package-hosting service, general distributed
scheduler, custom model runtime or training cluster has no approved deliverable here. The workspace
renderer is the exception since D29 (spec 066): a workspace deliverable and library candidate, never
a renderer imposed on games.
The workspace/basic editor is now explicitly requested; its earlier blanket deferral is superseded.
Curating implementation for a specific rendering or ECS need remains possible without selecting
it for every project.

Generate the graph from the active reviewed inventory or the clearly labeled proposal:

```sh
python3 tools/features.py graph > docs/roadmap-graph.md
```
