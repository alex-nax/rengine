# Agent Instructions — rEngine

## Orient

The owner paused broader development here on 2026-09-05 and requested the next session through
the native orchestrator. Finish only the handoff preparation outside it. Resume the NOLF
workspace goal when `RENGINE_ORCHESTRATOR_SESSION` identifies the attached agent session and
the root-bound rEngine MCP connection is available; read
`docs/handoff/2026-09-05-orchestrator-resume.md`. Do not start another conversation or goal as
a substitute, or treat automatic goal continuations outside the orchestrator as overriding this
pause. A later explicit owner direction can change this boundary.

1. Confirm the repository root with `pwd`.
2. Read the newest entry in `Codex-progress.md` and `docs/specs/000-charter.md`.
3. Run `./init.sh`, then `python3 tools/features.py status` and `next`.
4. Read `docs/architecture.md` and the relevant integration-plan section.
5. Select one ready, approved feature; read its acceptance criteria before implementing.

`docs/features.proposed.json` retains the broader design proposal. The owner's active NOLF
orchestrator goal authorizes the implementation scope in `docs/specs/055-nolf-workspace-goal.md`
and its active `features.json` rows. No additional review export is required for that scope.

## Sources of truth

- `docs/specs/000-charter.md`: attributed decisions and unanswered design questions.
- `features.json`, once reviewed: executable work inventory and verified completion state.
- `docs/roadmap.md`: milestone intent; `docs/roadmap-graph.md`: generated feature graph.
- `docs/integration-plan.md`: boundaries, external prerequisites, and migration evidence.
- `Codex-progress.md`: one shared, machine-tagged session log for all coding agents.
- `known-issues.md`: observed gaps; never silently turn missing evidence into success.

## Work protocol

Write a feature spec in `docs/specs/` before implementation. For behavior changes, establish a
failing regression or other meaningful acceptance check, implement the bounded change, run the
relevant gates, and verify the actual consumer path. Documentation-only changes need document
and graph checks, not artificial tests.

Keep accepted IDs, descriptions, criteria, and dependencies stable. Add follow-up work instead
of rewriting a requirement to pass. A necessary correction requires a recorded rationale and
owner decision. Set `passes: true` only with evidence for every criterion and prerequisite.
Missing assets, skipped checks, infrastructure errors, and pending human judgments are distinct
from passes. Fix regressions caused by the current change; record unrelated failures explicitly.

Prepend a `## Session N (<machine>) — YYYY-MM-DD — <title>` entry to `Codex-progress.md`, record
commands/results and remaining work, regenerate the graph when the inventory changes, and commit
a coherent change. Preserve other sessions' entries and unrelated edits.

## Boundaries

- rEngine's primary product is a quality library base and its integration knowledge. Reusable
  harness/tool contracts support that base. Games own their engine architecture, ECS choice,
  assets, compatibility behavior, release cadence, and engine-specific adapters.
  iklib is the selected first two-game library proof. A pinned curated capability with passing
  game integration checks meets the powered-by minimum; IDE/shared harness adoption is optional.
- The owner also requested a tab/pane IDE-orchestrator. Its scoped design is in
  `docs/specs/002-orchestrator.md`; it does not replace a game's runtime or make GUI use mandatory
  for library consumption. Initial desktop targets are macOS/Windows, with adapters first and
  basic editing plus optional Vim mode. Quest uses the shared 2D workspace with a desktop sidecar
  before later spatial panes. Views detach; the sidecar retains sessions managed by a session
  browser. Implementation starts with the desktop workspace, terminals and a live flat NOLF tab;
  VtMB follows as the second game adapter. Editors retain local recovery drafts and write working
  files on explicit Save. The first desktop acceptance draft is `docs/specs/032-desktop-v0.md`.
  Workspaces support multiple project/worktree roots with explicit per-session bindings; moving
  tabs or changing focus must never retarget terminal, file, agent or game operations.
- `iklib`, `infra-vr`, and training keep their own source and feature authorities.
- Sibling changes are scoped to the required NOLF adapter integration under the active goal and
  follow that workspace's rules. A local task cannot mark another project's feature done. Preserve
  unrelated active worktrees; prefer a separately buildable adapter where the host supports it.
- New components use explicit inputs and versioned dependencies; no required `~/...` paths,
  hidden downloads, global mutable configuration, or mandatory umbrella runtime.
- Desktop GUI code is C using microui. Electron and embedded browser application runtimes are
  prohibited in the desktop and game runtime. A later web interface is an optional separate
  client of workspace services, never a dependency of native tools or games (charter D26–D27).
- Honor the training project's held-out-data and grader boundaries. Recording a run does not
  authorize training, data export, or model creation.
- Do not delegate by default. Spawn agents only when the user or an applicable skill asks for it.
- Do not schedule loops, launch games/devices, publish packages, or operate backends as a side
  effect of bootstrap. Such actions belong to their own concrete tasks and existing authority.

## Verification and code organization

`./init.sh` is the local harness gate. `python3 tools/features.py validate` validates inventory
structure and dependency cycles. The initial Python tooling uses the standard library only.
Native toolchains will be selected per component when that component is approved.

Keep owned source files under 1,000 lines; retain pinned upstream sources intact with their licenses.
Public API documentation stays with the API. Longer file-local
rationale belongs in `._llm.json` sidecars using the installed llm-sidecar skill; refresh anchors
and review stamps when editing an annotated file. Cross-file decisions belong in specs.

The initialization phase is complete. Pursue the active NOLF workspace goal through implementation
and runtime verification; the larger library/Quest/training proposal remains independently scoped.
