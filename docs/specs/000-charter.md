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
| P01 | First prove one shared verification/evidence workflow in both engines. | A small shared tool can deliver value without waiting for two runtime migrations. |
| P02 | Projects selectively adopt pinned capabilities and remain independently buildable. | Fits the explicit requirement for individual architectures. |
| P03 | Use an optional project manifest and capability-specific conformance to make adoption measurable. | Branding then points to a reproducible contribution instead of a badge alone. |
| P04 | Keep iklib, infra-vr, and training independently maintained; curate and integrate them. | Existing ownership, APIs, and roadmaps already exist. |
| P05 | Keep model/provider selection outside core contracts; interchange tasks, commands, and evidence. | A model choice should not require a game integration rewrite. |
| P06 | Start with repository-local command-line tools and text/JSON artifacts. | A hosted orchestration service or editor needs a demonstrated consumer problem first. |
| P07 | Use native game behavior as the authority for parity; distinguish it from deliberate modernization. | A shared package's unit tests cannot prove that a game still behaves correctly. |

These are planning defaults, not settled runtime interfaces or implementation authorization.

## Interview tree

Ask small rounds, in dependency order; answer source questions through inspection.

1. **Purpose and authority — asked, awaiting answers.** What first milestone proves value?
   How much can rEngine require of an individual project? Does “both streams” mean the two
   engines or game development and agent training? Which repeated pain must disappear first?
2. **First consumer workflow.** Choose the concrete repro/task; decide whether the initial
   shared result is feature/handoff tooling, verifier evidence, dependency adoption, or runtime IK.
   Define “powered by” and the smallest required contract, if any.
3. **Runtime curation.** Establish infra-vr's role, iklib's first host, package admission criteria,
   distribution/pinning approach, and whether any common native substrate is actually required.
4. **Operational model.** Set target platforms for the first proof, resource/time budgets,
   hardware verification ownership, unattended authority, and concurrent-work coordination.
5. **AI/training boundary.** Decide whether first-class agent support means development tooling,
   training feedback, in-game AI, or some combination; define what may leave a game workspace.
6. **Scope and commitment.** Review feature proposals, exclusions, milestone order, evidence
   requirements, and the point where an unsuccessful extraction should stop.

## Questions to challenge before freezing the roadmap

- What would be measurably easier in the games after the first milestone?
- If only one game needs a component, what justifies maintaining it here?
- Can an engine decline a new rEngine version and still ship?
- Is a common harness mandatory for branding, or is adopting one library enough?
- Do we need new shared code, or would packaging the existing code solve the problem?
- What evidence would make us reject an abstraction and keep the code local?
- How much game progress can this foundation effort consume before it must show value?

Record subsequent answers here with their source, date, and which proposal they confirm or
replace. Do not infer approval from silence or from a generated review artifact.
