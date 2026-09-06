# rEngine charter and design interview

Date: 2026-09-05. Status: **interview in progress; recommendations are not owner decisions**.

## Owner-established requirements

| ID | Decision | Source |
| --- | --- | --- |
| D01 | Create rEngine, eventually called realEngine, as a harness, curated library and tool collection for the AI era. | Initial project brief |
| D02 | Both reLith and reSource should be considered powered by rEngine. | Initial project brief |
| D03 | Projects remain individual; a game's framework choice, including potentially flecs, must remain possible. | Initial project brief |
| D04 | Use the referenced projects' harness patterns and plan future integrations precisely. | Initial project brief |
| D05 | Conduct a probing design interview while setting up the repository. | Initial project brief |
| D06 | NOLF works; AVP2 and NOLF2 are in progress. iklib and agent-training work already exist. | Owner's status report; not a new runtime verification |
| D07 | Prioritize a quality library base for AI-assisted, purpose-built implementations. The owner sees NOLF and VtMB as evidence that individual engines can be written from scratch and questions the need for large all-in-one engines. | Owner's answer to interview question 1, 2026-09-05 |
| D08 | Curate upstream libraries and implement our own demonstrated gaps. | Owner confirmed the library-ownership recommendation, 2026-09-05 |
| D09 | Prove one library in both games before expanding the collection broadly. | Owner confirmed the first-proof strategy, 2026-09-05; D23 later names iklib |
| D10 | Include a tab-based IDE/orchestrator to improve the current Zed-plus-terminal workflow: start empty, split/resize panes and populate them with project tree, terminals, rendered tools and game output. Game views can open as tabs and move into panes. | Owner's workspace description, 2026-09-05 |
| D11 | Initially an agent tab runs a terminal with a Bash launcher that selects or installs a CLI coding agent and bootstraps integrations such as custom MCP servers. | Owner's workspace description, 2026-09-05 |
| D12 | Consider integration with tools such as Meta XR Operator. | Owner's integration suggestion, 2026-09-05; compatibility and implementation remain unverified |
| D13 | Support macOS and Windows from the first desktop release. | Owner's platform answer, 2026-09-05; supersedes the macOS-first recommendation |
| D14 | Use adapters for initial game/tool integration; also investigate support for unmodified external apps. | Owner's surface answer, 2026-09-05; arbitrary app compatibility is not guaranteed |
| D15 | Research a Quest distribution with a desktop sidecar. | Owner's research request, 2026-09-05 |
| D16 | Quest starts with the shared 2D workspace; independent spatial panes follow later. | Owner's Quest-layout answer, 2026-09-05 |
| D17 | Include project tree, previews, a basic text editor with optional Vim mode, and terminals in the initial IDE scope. | Owner's editing answer, 2026-09-05; supersedes the preview-plus-external-editor recommendation |
| D18 | Closing views detaches them; sessions persist until explicitly stopped. Include a session browser for managing and reopening sessions. | Owner's lifecycle answer, 2026-09-05 |
| D19 | Implement the desktop workspace and terminals first, including a flat game rendered into a new tab in that first useful milestone. | Owner's execution-priority answer, 2026-09-05 |
| D20 | A workspace supports multiple project/worktree roots; each terminal, editor, agent and game session is explicitly bound to its own root. | Owner's “Yes, just as you recommend” to the project-scope recommendation, 2026-09-05 |
| D21 | Use flat NOLF for the first live game tab on macOS and Windows; VtMB follows as the second game adapter. | Owner's “Yes, that's what I was thinking about” confirming the two recommendations, 2026-09-05 |
| D22 | Preserve unsaved edits as local recovery drafts; write working files only on explicit Save. | Same owner confirmation as D21, 2026-09-05 |
| D23 | Select iklib as the first library to prove in both games. | Owner's “GO for gecommended” answering the iklib/adoption round, 2026-09-05 |
| D24 | “Powered by rEngine” requires adoption of at least one curated capability at a pinned version with passing game integration checks. Use of the IDE and shared harness is optional. | Same owner confirmation as D23, 2026-09-05 |
| D25 | Implement the launchable NOLF orchestrator with proper game launching, tree, editor and a preferred CLI agent booted through a find/update/download/launch shell script. | Owner's active implementation goal, 2026-09-05; authorizes the scoped desktop/agent inventory and supersedes the setup-only review wait |
| D26 | Use microui with C for the desktop GUI; remove Electron. | Owner: “no electron, use microui with c instead for gui”, 2026-09-05; supersedes the earlier implementation stack |
| D27 | Avoid heavyweight application runtimes such as Electron. A web interface follows later as a separate client. | Owner: “We never use such overhead in runtime such as electron … later we would have web interface though”, 2026-09-05 |
| D28 | Pause broader development here; resume the same agent conversation through the native orchestrator after prerequisites, with desktop reload retaining the agent. | Owner's 2026-09-05 orchestrator handoff/pause request; implementation and limits in spec 058 |
| D29 | The desktop renderer moves to full GPU rendering behind a graphics-API adapter boundary: OpenGL first, then Metal, then Vulkan. The theming update designed in Claude Design is implemented on that renderer, not on SDL_Renderer. | Owner: “For the future - we want full gpu rendering. We will have adapters for different graphical APIs, - first OpenGL, then Metal and Vulkan”, 2026-09-06; requirements and phases in spec 066 |
| D30 | The rendering implementation is a candidate approved rendering library for the curated base once it meets the library-quality record and the D24 adoption rules; games adopt it through adapters and are never required to. | Owner: “This rendering implementation can be our approved rendering library in future”, 2026-09-06 |
| D31 | Support opening/managing a separate integration-project window with the current retained agent, inspection and a return channel for rEngine findings, with a reusable agent routine. | Owner's NOLF dogfooding request, 2026-09-06; spec 069 |
| D32 | Measure llm-sidecar usefulness before bundling it as a project skill; adapt only the selected wizard skill for orchestrator terminal actions without references to unselected skills. | Owner's skill evaluation and wizard-selection requests, 2026-09-06; spec 070 |

D07 establishes the product direction. The claim that engines are becoming obsolete is the owner's
thesis, not a verified industry-wide conclusion. The implementation question here is how rEngine
can make a project's selected components dependable and straightforward to compose.

## Code-derived constraints

- The engines have separate compatibility seams and different platform/math conventions.
- Both engines already compile portions of `infra-vr` from a local sibling path.
- iklib exposes a portable core and host presets, but its tracked host migrations are pending.
- Training owns frozen evaluation splits, isolated grading, export auditing, and a readiness GO.
- Existing feature counts and old README status blurbs are not playability measurements.
- Engine worktrees were active during inspection. Commit IDs alone do not identify every file
  observed; the source inventory records working-file hashes.

Evidence and limitations: [reconnaissance](../reconnaissance.md).

## Recommendations awaiting confirmation

| ID | Recommendation | Why / consequence |
| --- | --- | --- |
| P01 (superseded) | First prove one shared verification/evidence workflow in both engines. | Replaced after D07: this would put supporting tooling ahead of the requested library base. Retained as a later harness proposal. |
| P02 (confirmed by D03/D24) | Projects selectively adopt pinned capabilities and remain independently buildable. | Games retain their architecture and can meet the adoption minimum without the IDE or shared harness. |
| P03 (minimum confirmed as D24) | Use an optional project manifest and capability-specific conformance to make adoption measurable. | Verified pinned adoption is confirmed; the exact record/manifest format remains proposed. |
| P04 | Keep iklib, infra-vr, and training independently maintained; curate and integrate them. | Existing ownership, APIs, and roadmaps already exist. |
| P05 | Keep model/provider selection outside core contracts; interchange tasks, commands, and evidence. | A model choice should not require a game integration rewrite. |
| P06 (revised) | Keep reusable tooling usable independently of the orchestrator; use text/JSON artifacts where useful. | D10 now supplies an explicit IDE use case. The earlier deferral of an editor/workspace product is superseded. |
| P07 | Use native game behavior as the authority for parity; distinguish it from deliberate modernization. | A shared package's unit tests cannot prove that a game still behaves correctly. |
| P08 (confirmed as D08) | Curate upstream libraries and author/extract our own libraries for demonstrated gaps. | Owner confirmed. Whether any specific wrapper adds value is still a per-boundary decision. |
| P09 (confirmed as D09/D23) | Prove iklib in both engines first. | Strategy and named library confirmed; exact revision, target profiles and parity measures remain feature-spec work. |
| P10 | Library quality includes contract clarity, correctness, composition, measured resource behavior, maintenance and executable integration knowledge. | Detailed proposal: library-quality.md. A README link alone is insufficient evidence. |
| P11 (lifecycle confirmed as D18) | Model the workspace as resizable splits containing tab groups; tabs refer to sessions with independent lifetimes. | Moving a tab preserves terminal/game identity. D18 settles close/detach/stop and GUI-exit behavior; D20 settles explicit root binding. |
| P12 (partly superseded/confirmed) | Use explicit game/tool adapters first. | D14 confirms adapters. D13 supersedes macOS-first with macOS and Windows from the start. |
| P13 (layout confirmed as D16) | A Quest client uses a desktop sidecar for filesystem, build, terminal, agent and game sessions. Start with the shared layout in a 2D panel before optional independent spatial panels. | The 2D-first layout is confirmed. Pairing, transport and input design still need proof. |
| P14 (confirmed as D18) | Detach views while sessions remain in the sidecar, with an explicit Stop operation. | Owner also requires a session browser for managing retained sessions. |
| P15 (confirmed and extended as D19) | Implement the desktop workspace/terminal slice first. | Owner explicitly includes a flat game rendered into a new tab; terminal/layout-only work does not complete the first milestone. |

These are planning defaults, not settled runtime interfaces or implementation authorization.

## Interview tree

Ask small rounds, in dependency order; answer source questions through inspection.

1. **Purpose — direction answered, concrete proof pending.** D07 makes the quality library base
   primary. D24 settles the minimum powered-by commitment; operational authority and the precise
   training bridge remain scoped design work.
2. **Library ownership and first proof — answered.** D08/D09/D23 confirm curated upstream
   plus our own gaps and iklib in both games first. Specify the parity slice and applicable
   quality criteria next; do not ask the settled selection questions again.
3. **Quality and composition.** Agree the admission bar, first subsystem coverage, portability,
   performance/ownership contracts, host adapter rules and the agent's usable context package.
   Establish infra-vr's role, dependency pins and the first selected library's integration slice.
4. **Orchestrator — scope, lifecycle, priority and root association answered.** macOS/Windows from the start,
   adapters first, Quest 2D-first, and tree/previews/basic editor with optional Vim mode are
   confirmed, as are retained sessions, session browser and desktop-first execution with a live flat
   game tab. Multiple project/worktree roots share a workspace with explicitly bound sessions.
   NOLF is the first game; editor recovery uses local drafts with explicit saves.
   Next resolve the concrete host baseline, editor/Vim details and
   later agent recipes/Windows Bash setup; do not repeat settled questions.
   The specification is `002-orchestrator.md`.
5. **Operational model.** Set resource/time budgets, hardware verification ownership, unattended
   authority and concurrent-work coordination. Distinguish terminal sessions from bounded check jobs.
6. **AI/training boundary.** Decide whether first-class agent support means development tooling,
   training feedback, in-game AI, or some combination; define what may leave a game workspace.
7. **Scope and commitment.** Review feature proposals, exclusions, milestone order, evidence
   requirements, and the point where an unsuccessful extraction should stop.

## Questions to challenge before freezing the roadmap

- What would be measurably easier in the games after the first milestone?
- What do we provide beyond linking an agent to a library's existing documentation?
- Which composition problems should an agent solve locally, and which should we solve once?
- If only one game needs a component, what justifies maintaining it here?
- Can an engine decline a new rEngine version and still ship?
- Does the adoption record prove the selected capability and its claimed game/platform scope?
- Do we need new shared code, or would packaging the existing code solve the problem?
- What evidence would make us reject an abstraction and keep the code local?
- How much game progress can this foundation effort consume before it must show value?

Record subsequent answers here with their source, date, and which proposal they confirm or
replace. Do not infer approval from silence or from a generated review artifact.

## Revision record

2026-09-05, owner answer 1: shifted the draft's primary path from shared command tooling to
library quality, curation and real game adoption. Proposed IDs remain traceable, but their
milestones/priorities/dependencies are revised while the inventory is unapproved. No accepted
feature history or completion evidence is changed.

2026-09-05, subsequent owner answer: confirmed D08/D09 and added the orchestrator scope D10–D12.
The new IDE branch explicitly supersedes the earlier editor deferral. Preserve the library proof
as an independent deliverable; the relative implementation priority of IDE and library work is
still to be decided.

2026-09-05, platform/surface and editing answers: recorded D13–D17. Researched official Quest
2D/PWA/Spatial SDK paths, native Operator, Windows window parenting/capture and macOS capture.
Evidence supports candidate architectures, not a tested port, universal embedding or distribution
approval. 2D-first Quest and basic built-in editing supersede the earlier pending recommendations.

2026-09-05, lifecycle/order answer: D18/D19 require an independent session owner, a session
browser and a first desktop slice that includes actual flat game output. Library adoption remains
independent of IDE completion, but implementation starts with the desktop workflow.

2026-09-05, project-scope answer: D20 confirms multiple roots with explicit per-session binding.
It does not approve the whole feature inventory, select a toolkit or select the named library.

2026-09-05, first-game/editor answer: D21 selects NOLF then VtMB; D22 selects local recovery
drafts with explicit working-file saves. The desktop acceptance draft is `032-desktop-v0.md`.
The exact host revisions, toolkit and measurement budgets remain unselected; D23 below settles
the named library.

2026-09-05, library/adoption answer: D23 selects iklib. D24 sets verified pinned capability
adoption as the powered-by minimum, with optional IDE/shared harness. The “GO” answers those two
presented recommendations; the complete feature proposal still needs concrete roadmap review.

2026-09-06, rendering answer: D29–D30 select full GPU rendering with OpenGL, Metal and Vulkan
adapters and name the renderer a future approved-library candidate. This supersedes the roadmap's
blanket “no new renderer” deferral for the workspace only; games keep their own renderers. The
design source is the Claude Design project pulled into `design/`; requirements, architecture and
phases are in `066-gpu-rendering.md`.
