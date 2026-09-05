# Progress Log

## Session 6 (macos) — 2026-09-05 — Working desktop panes and retained-sidecar launcher

**Goal turn classification**: progress. Pushed the foundation commit as requested, then added
the launchable Electron/React workspace. The full NOLF/editor/agent objective remains active;
all 15 feature gates remain false pending their full host/platform criteria.

**Implemented**: Tree, retained CodeMirror buffers, optional Vim, explicit Save/conflict actions,
xterm sessions, FlexLayout splits and movable tabs, session browser, saved layout and awaited
draft flush on normal desktop exit. The native window exposes only project selection and close
handshake IPC. `npm start -- --project DIR --agent ID` builds the UI and starts or reuses a separate
Node sidecar, then opens a project-bound shell and agent. Startup ownership and authenticated
instance checks prevent duplicate sidecars; an alive unavailable process remains an error.

**Verification**: Eleven service/launcher tests pass, including concurrent launchers sharing one
real sidecar. The Electron test passes real editor Save, external-disk conflict preservation,
Discard/reload, Vim `ggdd`, keyboard input executed by a real PTY, terminal tab movement, GUI exit,
same-PID reattachment and draft recovery in the editor. The initial missing-desktop run timed out;
after implementation the full desktop test passes in about 6.3 seconds. Inspected its screenshot;
corrected file/session placement so the main area is used when opening from the tree. Test shells
use Bash on macOS to avoid an interactive profile updater; production still honors the user shell.

**Limitations**: No live game tab, real installed-agent session proof or MCP bootstrap yet.
Windows execution and release packaging remain unverified. Image previews, forced-crash recovery,
power-loss durability and full resource budgets are still owed. No NOLF source/assets changed.

**Next**: Implement and verify the SDL2/OpenGL live NOLF surface, finish agent integration and
exercise the actual NOLF workspace. Preserve independent roots and retained process lifetimes.

---

## Session 5 (macos) — 2026-09-05 — Begin the authorized NOLF workspace implementation

**Goal turn classification**: progress. The previous push completed; this first implementation
turn changes authoritative code and verifies real sidecar/PTY behavior. The full user objective
remains the launchable NOLF workspace with tree, editor, live game and agent onboarding, on the
previously required macOS/Windows targets. No goal completion or blocker is claimed.

**Authority and scope**: The owner's active objective supersedes the setup-only review wait.
Recorded D25 and `docs/specs/055-nolf-workspace-goal.md`; activated 15 desktop/agent rows including
aggregate F55. Agent find/update/download/launch is now in the first usable workflow. All feature
completion states remain false because the full platform/UI/host criteria are still unproven.

**Implemented**: Node sidecar HTTP/WebSocket/file/session services; explicit root identities;
UTF-8 text reads, LF/CRLF-preserving explicit saves, local recovery drafts and external-version
conflicts; real PTY sessions with bounded output, reconnect and explicit process-tree Stop.
Standalone `scripts/agent.sh` detects Codex/Claude/Gemini/OpenCode or a custom executable, launches
in an explicit project, installs into a managed npm prefix, and dispatches supported updates.
MCP bootstrap is not yet wired and no actual agent update/download was performed in this turn.

**Dependencies**: Exact npm versions/lockfile for Electron, React/FlexLayout, CodeMirror/Vim,
xterm/node-pty, WebSocket, esbuild and Playwright. Existing Node is v25.3.0 on macOS 15.7.3 arm64.
node-pty 1.1.0's prebuilt spawn-helper lacked execute bits; the postinstall preparation step
repairs the known helper paths. The actual PTY then works outside the sandbox.

**Verification**: Meaningful red tests preceded the modules and launcher. Ten tests cover real
PTY startup, retained session identity across WebSocket disconnect/reconnect, explicit Stop
isolation, HTTP auth/origin/file conflict paths, root/draft restart behavior and agent dispatch.
A malformed UTF-8 token regression was reproduced (500 instead of 401) and repaired. Native PTY
and socket checks need the normal unsandboxed app environment. Default zsh startup asked for an
oh-my-zsh update and consumed the test's first character; controlled tests now use clean shell
profiles, while production terminals retain the user's normal shell configuration. Sidecar
metadata is stamped/validated. Final `npm test` and harness results accompany the checkpoint.

**NOLF evidence**: Current `build/relith-nolf` and local `nolf/NOLF.REZ` exist. Read the host rules,
CLI and profile: `--flat`, `--game nolf`, size arguments and `RELITH_HIDDEN_WINDOW=1` provide a
hidden real GL context. SDL swap/input seams are in `src/platform/sdl_window.cpp` and a second
swap in `src/compat/lt_render_impl.cpp`; both matter to an adapter. No NOLF source, active host
worktree or game asset was changed, and no game was launched yet.

**Next**: Connect Electron/FlexLayout/CodeMirror/xterm to the real sidecar, implement the native
SDL2/OpenGL live surface and NOLF launch adapter, add per-agent MCP bootstrap, then exercise the
actual GUI/NOLF/installed-agent workflow. Preserve persistent sessions, explicit roots/saves,
game input/tab movement and Windows support. Full GUI/native/Windows gates remain owed.

---

## Session 4 (macos) — 2026-09-05 — NOLF, recovery drafts and iklib roadmap review

**Agent**: Codex.
**Owner decisions**: D21 confirms NOLF as the first live desktop game tab, with VtMB second.
D22 confirms local recovery drafts and explicit working-file saves. The later “GO for
gecommended” answers the next two-question round: D23 selects iklib as the first two-game library
proof; D24 requires verified pinned capability adoption for powered-by status, with optional
IDE/shared harness. All session 3 questions are answered. This is not a blanket roadmap verdict.

**Artifacts**: Added `docs/specs/032-desktop-v0.md` and `001-library-pilot.md`. They turn confirmed
choices into acceptance workflows, host ownership and failure cases, while marking concrete
source pins, hardware, numerical/resource budgets and initial Vim details as still required.
F32/F1 remain incomplete; writing a draft does not satisfy their outstanding criteria.

**Proposal correction**: F21 now depends on both core migrations F18/F19 instead of requiring
the separate F20 finger migration. This repairs the draft graph's mismatch with the existing
separate-finger scope. F20 contributes a later evidence update. Updated NOLF/recovery/iklib and
powered-by criteria throughout the 54-feature proposal; every feature remains non-passing.

**Review**: `docs/reviews/rengine-roadmap-2026-09-05-v1.html` embeds all features and complete
criteria in six review branches, along with the current source specs. Its content JSON records
source hashes and group membership. Adjacent CSS/JS are unmodified copies from the ispec skill;
the review works offline without requiring that skill to be installed. The `.spec.json` input
is not an owner verdict. Use the exported `.json` or explicit chat feedback to record review.
Recommended later order is iklib core proof after desktop v0, then agents/VtMB; this remains a
recommendation. Windows test access is an open input in the review, not a claimed available host.

**Verification**: `./init.sh`, JavaScript syntax, graph reproduction, Markdown links, 54-feature
coverage, review source hashes and export-control structure pass. Verified that desktop v0 stays
independent of library/training/installer work, and core IK proof no longer waits for fingers or
the shared-runner branch. In-app browser discovery returned no available browser, so automated
visual, click and JSON-export checks were not performed. The review is ready for presentation
in the regular browser. No orchestrator runtime, native game build, host migration or training
workload was implemented or executed; sibling workspaces remain untouched.

**Next suggested task**: Present the concrete review and incorporate owner feedback. The
harness-init skill requires review of the feature list before creating `features.json`; ispec
waits for completed feedback after presentation. Chat decisions can serve as review without
forcing an exported file. Reconcile revisions/deferred groups and dependency closure, activate
only accepted scope, then complete the desktop qualification inputs before a toolkit prototype.

---

## Session 3 (macos) — 2026-09-05 — Explicit roots in shared workspaces

**Agent**: Codex.
**Owner decision**: D20 confirms multiple project/worktree roots in one workspace, with every
terminal, editor, agent and game session explicitly bound to its own root. This answers session
2's pending question; it is not blanket approval of the feature inventory.

**Summary**: Updated the charter, orchestrator specification, architecture, roadmap and agent
instructions. The proposed implementation separates stable root identity, repository identity,
launch directory and shell cwd. Focus changes and tab moves cannot retarget existing operations.
Root removal/missing directories retain visible session associations instead of guessing a new
checkout. Root binding records context; it is not an access sandbox.

**Proposal changes**: Tightened 11 existing features around two worktrees, duplicate filenames,
similarly named sessions and preserved root bindings after GUI restart. No feature IDs,
dependencies or completion states changed. All 54 remain proposed/non-passing; `features.json`
is still absent. The first desktop milestone retains its actual game tab and session browser.

**Verification**: `./init.sh` passes. Graph reproduction, local document links, proposal state and
desktop/library dependency boundaries are checked before commit. No runtime code, sibling
workspace, game build, installation, device or training job was changed or executed.

**Questions pending**: Select the first live game (NOLF recommended, followed by the VtMB adapter)
and editor recovery policy (local recovery drafts with explicit saves recommended). These were
asked together; do not treat either recommendation as confirmed before an answer.

**Next suggested task**: Record the answers and refine F32's concrete desktop acceptance spec.
Present the proposed scope for review before activating implementation. Toolkit feasibility,
Vim subset and measured budgets remain open; settled platform/lifecycle/multi-root choices do not.

---

## Session 2 (macos) — 2026-09-05 — Library base and desktop orchestrator design

**Agent**: Codex.
**Owner decisions**: Charter D07–D19 records the library-base thesis; curated upstream plus our
own gaps; one library proven in both games first; tab/split IDE; terminal-based Bash agent
selection/installation/MCP bootstrap; macOS and Windows from the start; adapters first with
external-app research; Quest 2D workspace with desktop sidecar before spatial panes; tree,
previews and basic editing with optional Vim; retained sessions with explicit Stop and a session
browser; and desktop workspace/terminals/flat-game-tab as the first implementation milestone.

**Summary**: Revised the initial shared-runner-first plan. Added the library quality proposal,
orchestrator spec and primary-source investigations of Meta XR Operator, Quest delivery and
external app presentation. The first desktop proof includes actual game pixels/input and session
reattachment on both platforms. iklib remains the recommended named library and flat NOLF the
recommended first game; neither name is treated as an explicit new owner decision.

**Proposal changes**: 54 features, all proposed/non-passing. Library and desktop branches are
independent. F32 is the first proposed local design/feasibility entry; desktop v0 closes at F48,
including the host-owned F43 game adapter and F54 session browser. Later agents, XR, Quest and
external-app work have separate gates. The previous blanket editor deferral is superseded.
No accepted feature history was rewritten and `features.json` remains absent pending review.

**Research findings**: Official Meta documentation establishes native standalone Operator and
Android/PWA/Spatial SDK routes suitable for a Quest-client feasibility path. Windows supports
window parenting with caveats and window capture; Apple documents window/app capture. These
support candidate designs, not universal embedding, tested native-host compatibility or store
approval. The proposed sidecar owns files/builds/PTYs/agents/game sessions; layout/session
contracts can serve desktop and Quest views. MCP inspection/control is separate from live-pane
presentation. Source links and proof requirements are recorded in `docs/research/`.

**Verification**: `./init.sh` validates 54 features and their dependency graph. Before commit,
check graph reproducibility, local Markdown links, all-proposed status, desktop-v0 dependency
closure and independence from the library/training/installer branches. No runtime code changed;
no game, native build, GUI prototype, install, device or training job was executed. No reference
workspace was modified.

**Question pending**: Whether one workspace contains multiple project/worktree roots with each
session explicitly bound to a root (recommended), or one root per workspace. Prior strategy,
platform, editing, lifecycle and first-milestone questions have been answered; do not repeat them.

**Next suggested task**: Record the project-association answer, settle the bounded desktop v0
spec, and present the revised feature proposal for owner review. Qualify the implementation stack
through real terminal/editor/game-surface feasibility on both desktops before building the larger
UI. Preserve the required game tab and session browser in the first useful milestone. Agent
recipes/Windows Bash details and later Quest/XR scope remain follow-up design decisions.

---

## Session 1 (macos) — 2026-09-05 — Initial harness and architecture interview

**Agent**: Codex initializer.
**Summary**: Created rEngine's local harness and a concrete proposed roadmap from read-only
inspection of reLith, reSource, iklib, training, and the newly discovered infra-vr dependency.
The charter distinguishes owner-established requirements, code-derived facts, and recommendations.
The interview is ongoing; no answer to the first question round had arrived at this checkpoint.

**Artifacts**: `AGENTS.md`, thin `CLAUDE.md` entry point, this shared log, `init.sh`, local feature
query/validation helper, charter and harness specs, architecture, source hashes, reconnaissance,
integration plan, 30-feature proposal, generated roadmap graph, and known-issues inventory.

**Features completed**: None. This is harness setup, not implementation of the proposed shared
runner, schemas, engine integrations, packaging recipes, or training bridge. `features.json` is
intentionally absent until the concrete proposal is reviewed. The helper labels proposal queries
and offers no executable feature before that review.

**Verification**: Bootstrap succeeds and is independent of sibling paths and native game
toolchains. Inventory types, dependencies and cycles validate. Focused CLI checks exercise
duplicate/unknown IDs, cycles, malformed JSON, review/evidence requirements, local readiness,
host handoffs, graph reproducibility and invocation outside the repository. The first document
link check caught this progress file before it had been written; it is included in final checks.
Final command results are recorded in `docs/evidence/initial-harness.md`.

**Known issues**: First milestone, “both streams,” minimum powered-by contract, infra-vr role,
platform/resource scope and catalog policy remain interview questions. Source worktrees were
active; use the recorded per-file hashes and recheck before future integration. No reference
repo was edited and no game/build/device/service/training workload was run. iklib host migrations
remain owned by their original workspaces and tracker.

**Next suggested task**: Continue the first interview round, record answers in
`docs/specs/000-charter.md`, then ask the dependent workflow/curation questions. Refine and present
the concrete feature proposal for owner review. After acceptance, create `features.json` with
`review_status: approved` and a `review_record` reference, retire the proposal as the active
source, regenerate the graph, and choose the approved first slice. Do not restart reconnaissance
unless facts needed for that slice have changed.

---
