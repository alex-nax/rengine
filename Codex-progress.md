# Progress Log

## Session 26 (macos) — 2026-09-06 — Integration recipe: contract-3 drift and the KI renumber

**Owner scope**: a review of the finished `feat/integration-recipe` branch produced a drift list.
The sibling game lane's contract changed by owner decision on 2026-09-06 — the singular `game`
object is replaced by a multi-game `games` array at `contract: 3`, reconciled with nolf-improved's
competing F1615 proposal but **without** its deprecated `nolf_preflight`/`launch_nolf` aliases —
and this recipe documents that contract in five places. Worktree
`.cache/worktrees/integration-recipe`, branch `feat/integration-recipe` from `ccbb29e`; pushed per
commit. `origin/main` (`6a3271d`) was already an ancestor, so no merge was owed.

**Verified before writing, and again at the end**: the shape was read out of the sibling branch,
not assumed. At the start `origin/feat/project-game` still carried contract 2 with a singular
`game`, and a local `feat/game-contract` at `0f40b24` carried a contract-3 draft that numbered its
spec `077` (colliding with this branch) and narrowed game `executable` to root-relative only; that
branch was deleted while this session ran. By the end `origin/feat/project-game` (`3440ef5`, spec
`078`) had landed the decided shape and it **agrees with the brief on every point**: contract enum
`[1, 2, 3]`, `games` 1–16, `id` kebab ≤64 and unique, `title` 1–32, `executable` 1–8 candidates
sharing the format `argv[0]` definition (absolute, root-relative with a separator, or a bare PATH
name — not root-relative-only), literal `args`, UPPER_SNAKE `env` with `RENGINE_`/`DYLD_`/`LD_`
rejected, root-relative `cwd`/`requires`, `surface` `embedded`|`external`, and the tools
`game_preflight(gameId?)`/`launch_game(gameId?)`. The scaffold and the reference template were then
validated against that landed schema and its `gamesRules` — zero errors each.

**Drift fixed**: spec 077 and the templates README cited "076 (game)" and the runbook cited
"specs 074/075/076"; the game spec is `078` (main took 076 for design foundations). The runbook's
Game bullet called `executable` "a list of root-relative candidates" and omitted the reserved env
prefixes, the literal-args rule and the 1–8 bound that its Dashboard bullet documents properly; it
is now a per-field list covering the array, id uniqueness, `cwd`, the none/one/menu toolbar
behaviour and both surfaces. The test's local re-implementation of the contract rules is gone: it
had drifted in two directions at once (rejecting legal absolute/PATH `executable` candidates,
accepting reserved `env` prefixes) and its "this branch's reader knows contract 1 only" comment was
about to go stale; the helper now calls the shipped `validateSchema` plus `dashboardRules` (and
`gameRules` when the game lane ships it), validating the core with `games` removed and naming the
uncovered tier while the committed schema predates contract 3. The wizard emits a one-record
`games` array at `contract: 3`, takes `--game-surface embedded|external` and rejects the retired
`sdl2-interpose` spelling by naming `embedded`; the reference template moved to contract 3 with two
records (one `embedded`, one `external`, exercising `args`/`env`/`cwd`/`requires`), and the copied
Python declaration test follows. The two worked-example tables now carry the multi-target shapes —
nolf-improved with three `embedded` targets on one LithTech engine, vtmb-vr with two `external`
ones forced by its static SDL3 link — both marked as the shapes those projects are **adopting**,
not verified live state.

**Flags kept single-valued**: `--game-title/--game-exe/--game-surface` scaffold one record, the way
the wizard scaffolds one placeholder format and one dashboard action. Repeatable flags would need
order-dependent record flushing for a skeleton the project edits anyway; the multi-record array is
shown in the reference template and printed as follow-up 5 instead.

**Identifier collisions**: this branch carried two `KI-040` rows after the main merge — the
dashboard lane's and its own. The recipe's row is now **KI-042** (the game lane took KI-041), the
dashboard row is untouched, and the citations moved in `docs/specs/077-*`, the runbook (twice), the
templates README and the evidence document. The same merge had also duplicated `KI-039`: the
branch's stale copy is removed and main's updated row kept verbatim. Two collisions remain for the
owner to settle at merge time and were **not** touched here: the deleted `feat/game-contract` draft
had claimed spec `077` and row `F70`, both of which this branch owns (the surviving
`feat/project-game` uses `078`/`F71`, so this may already be moot), and `feat/project-game` also
numbers its entry below "Session 25", as this branch's previous session does.

**Gates**: `npm test` 47/47 (46 before, +1 new check), exit 0; the recipe file alone 9/9, red on 4
of them before the wizard and template moved; `./init.sh` and `python3 tools/design.py check`
clean; `python3 tools/features.py validate` 30 features; `bash -n` clean on the wizard and the
template `editor.sh`; sidecar repair/review/stamp/check clean on the touched sidecars with the
private index `.cache/sidecars-recipe-drift.sqlite`. `docs/roadmap-graph.md` regenerated identical,
so it is unchanged. Evidence appended to
`docs/evidence/project-integration-recipe-macos-2026-09-06.md`.

**Remaining**: F70 stays passing and spec 077 stands; only their contract-facing wording moved,
with the owner's 2026-09-06 decision as the rationale. KI-042 is still open (Add project should run
this recipe natively). The repo-wide sidecar check reports pre-existing, unrelated drift in
`orchestrator/native/*` and `orchestrator/tests/native-client.mjs` that is present at `ccbb29e` and
belongs to the native/design lanes.

## Session 25 (macos) — 2026-09-06 — Project integration recipe

**Owner scope**: "for next rengine integrations or new projects we should have this recipe stored
and later adapted in the orchestrator interface." Branch `feat/integration-recipe` (worktree
`.cache/worktrees/integration-recipe`, base `43bbb80`; not merged, not pushed). Generalised from
what nolf-improved did on 2026-09-06 (its rEngine submodule, `editor.sh`, REZ format registration
and dashboard features) and what the vtmb-vr lane is doing now; both consumer checkouts were read
only, never modified.

**Landed**: spec `077-project-integration-recipe.md` (scope, recipe, ownership split, what a
wizard may automate versus what stays a project decision). `docs/runbooks/project-integration.md`
— prerequisites, submodule pin/bump policy, the `editor.sh` launching point, the contract-2
`.rengine/project.json`, the three test tiers a consumer keeps and how to register them, skills and
CLAUDE/AGENTS wiring, the cross-vendor review gate, opening the project window, layered updates,
owner-verified consumer gates, plus the nolf-improved and vtmb-vr instances as tables and what the
Add project button should automate. `orchestrator/actions/integrate-project.sh` — a five-stage
wizard in the `lib/wizard.sh` conventions (verify the repository and that the remote advertises the
pin, add and pin `third_party/rengine`, install `editor.sh`, write the declaration, copy the
declaration test) that never overwrites, prints a plan under `--dry-run` and prompts only on a TTY.
`orchestrator/templates/project/` — `editor.sh`, the reference contract-2 `project.json`, a generic
`test_rengine_project_decl.py` (structure always, pinned schema when the pin carries the declared
contract, behaviour when the CLI is built) and a README naming each destination; no template names
a game or a format.

**Verification**: `orchestrator/tests/integrate-project.test.mjs` was red for all seven checks
before the action existed. Final `npm test` 43/43, exit 0 (70 s); the new file alone 8/8 (9.2 s);
`bash -n` clean on both scripts; `./init.sh` and `python3 tools/design.py check` pass; sidecars
repaired/reviewed/stamped/checked with a private index. A manual end-to-end run scaffolded a
throwaway repository from a bare `file://` clone of this worktree: the submodule pinned at the
requested SHA, `./editor.sh --check` reported `SDL2 2.32.10` and `cmake 3.31.2` out of the pinned
tree, and the copied Python test passed with both pinned-contract checks skipping with
`pinned rEngine supports contract [1]; this declaration is contract 2`. Evidence:
`docs/evidence/project-integration-recipe-macos-2026-09-06.md`.

**Remaining**: KI-040 — the Add project button should run this recipe natively (spec 002/071);
until then the wizard runs in a script tab. Both contracts require at least one format record, so
the scaffold writes an inert `*.example` placeholder; relaxing `formats` to `minItems: 0` for
contract 2 belongs to the dashboard/game lanes. F70 is recorded as passing on the automated
evidence above; no native or contract code changed. IDs: F70 and KI-040 were chosen after rebasing
onto main — which advanced by three Windows-renderer commits during the session and took KI-038 and
KI-039 — and after reading the dashboard worktree (F65–F66) and `feat/project-game`, leaving F67 to
that lane. `features.json`, `known-issues.md`, `docs/roadmap-graph.md` and `Codex-progress.md` may
still conflict with the concurrent contract lanes and are append-only here.
## Session 24 (macos) — 2026-09-06 — Project dashboard (contract 2, step 1)

**Owner scope**: after the format-registry review fixes, the second brief: a project dashboard
declared in `.rengine/project.json` (contract 2 = contract 1 plus an optional `dashboard`),
rendered as a tab of grouped actions; log filtering (step 2) and image display (step 3) deferred,
`stream`/`operator` reserved. Branch `feat/project-dashboard` from `2b04926` (review-fix tip; main
had moved to `35e73dc` without it, so no rebase yet); not merged, not pushed. Spec 075, rows F65/F66.

**Implemented**: `contracts/project-v1.schema.json` accepts contracts 1 and 2 with `dashboard`
definitions; the validator subset gains schema-valued `additionalProperties`; `readDeclaration`
validates the contract-1 part first and the dashboard separately (`dashboard`/`dashboardError`) so
a bad dashboard never disables previews; `dashboard-rules.mjs` holds the shared cross rules (unique
ids, per-kind fields, root-relative paths, UPPER_SNAKE env). `dashboard.mjs` computes availability
by root-bounded stat and a PATH walk without running anything, builds script/log session payloads
(bash + resolved script + literal args + env; the argv for logs) that the host's `terminal` route
creates, and runs captures under 10 s / 8 MiB requiring the PNG signature, writing
`<into>/<timestamp>.png` and `manifest.json` atomically inside the root. Routes `dashboard`,
`dashboard-run`, `dashboard-capture` on host and worker (`dashboard: 1`); `open_script` accepts
`env`; MCP `dashboard_actions` (read-only) and `dashboard_capture` (open-world). Native: tab type
`RE_DASHBOARD`, toolbar button, one-time auto-open per root persisted in the layout, group
sections, buttons for available actions and labels naming the first missing item otherwise,
run/capture/reveal handled in app.c, `dashboard.c` owns the rows (no microui pools).

**Verification**: service tests red (merged document rejected, routes 404) then green; native
fixture red (no dashboard tab) then green. Final: `npm test` 38 passes, 0 failures, 5.86 s; `npm run test:desktop`
16 passes, 0 failures, 330.91 s, exit 0 (two background attempts were killed at the turn boundary and produced no result; this is the complete foreground run); CTest 4 passes, 0.65 s; inventory validate (26), `./init.sh`, design check, sidecar
check/stamp for twelve sources. The nolf-improved merged document validates with zero errors.
Evidence: `docs/evidence/project-dashboard-macos-2026-09-06.md`; KI-040 records the deferrals.

**Remaining**: owner merges `fix/format-registry-review` then this branch, runs the layered
update, and verifies the real dashboard once nolf-improved moves its staged section into
`project.json`; steps 2 and 3 are separate specs; Windows unqualified.

---

## Session 23 (macos) — 2026-09-06 — Format registry review fixes

**Owner scope**: `feat/format-registry` merged to main as `f38db49` and running on the live desktop;
a Codex read-only review requested six changes, fixed on `fix/format-registry-review` (worktree
`.cache/worktrees/format-registry`, base `f38db49`; not merged, not pushed). Red test first for
each finding, then the fix.

**Fixed**: (1) directory expansion no longer touches microui's 48-slot treenode pool, whose
`mu_pool_init` aborts on the 49th open node in one frame; the view owns a hashed-path expansion
set and rows are plain buttons with a spacer indent. (2) `readDeclaration` reports structural
schema problems before the cross-field pass (which now guards every shape), `validateSchema`
uses `Object.hasOwn` so prototype names are unknown keys, and a failed formats request settles the
root as declared-with-error natively so text editors open and the status line shows the problem.
(3) `runCommand` takes the root record and re-confines `${file}` immediately before the spawn;
raw reads open first and require the opened inode to match a fresh confined resolution; the
residual path-taking window is stated in spec 074 and KI-037. (4) producers run in their own
POSIX process group and timeout/oversize kill the group (`taskkill /T /F` on Windows), close
the pipes and await the exit. (5) `preview_file` budgets the serialized reply at 32,000 chars,
pages files with `offset`/`limit`, reports `truncated`/`nextOffset`, returns root-relative
command metadata and redacts the absolute root from tool errors. (6) the native HTTP deadline is
per request: preview/entry requests use the declared `timeoutMs` plus two seconds of transport
and a transport timeout names that budget.

**Verification**: `formats-hardening.test.mjs` (4 tests) and `native-format-hardening.spec.mjs`
were red first (thrown TypeError, runner accepting an absolute path, grandchild alive after the
timeout, no offset/limit; the wide tree stalled and the 6 s producer failed the 5 s deadline).
Final: `npm test`: 35 passes, 0 failures, 5.57 s; `npm run test:desktop`: 14 passes, 1 failure, 288.49 s (exit 1): the failure is Codex's untouched `native-render.spec.mjs` budget assertion `opengl: resident memory delta 33536 KiB exceeds 32768 KiB`; it passes standalone (1 pass, 171.53 s) and the two format fixtures passed in that full run; a first full run failed the hardening fixture on the restored-tab deadline bug fixed afterwards (15 fixtures, including the
64-directory expansion, a text file under a malformed declaration and a 6 s producer inside its
10 s budget); CTest 4 passes (0.64 s); inventory validate (24), `./init.sh`, design check and
sidecar check/stamp for nine sources pass. KI-037 and spec 074 corrected where the review proved
them wrong.

**Remaining**: the transport-timeout message with the declared budget is not exercised by a
test (no fixture can stall the loopback service); Windows `.exe` resolution stays untested
(KI-014). Owner merges the branch, runs the layered update again and re-verifies the real window.

---

## Session 22 (macos) — 2026-09-06 — Project format registry

**Owner scope**: `*.rez` files in nolf-improved open in the editor with a raw hex mode by default
and a Preview mode showing the archive's contents (owner direction 2026-09-06, lane authorized
from the orchestrator session). Implemented generically as spec 074: a project declares formats
and the executables that produce their previews; rEngine owns the contract, execution boundary,
hex view and modes. Worked on `feat/format-registry` in `.cache/worktrees/format-registry`
because Codex holds an uncommitted Vulkan adapter (spec 073) on the main tree; not merged, not
pushed. Inventory rows F63 (contract/service/MCP) and F64 (native modes) added; graph regenerated.

**Implemented**: `contracts/project-v1.schema.json` (contract 1) with a bounded Draft 2020-12
subset validator; `orchestrator/server/formats.mjs` reads `<root>/.rengine/project.json`, reports
malformed declarations visibly without disabling the root, matches case-insensitive globs and runs
literal argv commands (`${file}`/`${entry}` only, cwd = root, shell environment, no shell, SIGKILL
on timeout/oversize, stderr's first line on failure). Routes `formats`, `format-preview`
(tree/text/entry with size, SHA-256, text when UTF-8, hex window) and `bytes` are served by the
host and the replaceable workspace worker (`formatRegistry: 1`); `resolveInRoot` is the shared
boundary. MCP `preview_file` slices the tree by dir/depth and is marked open-world. Native:
`hexview.c` (64 KiB window, 16 bytes per row, ASCII column, paging), `formatview.c` (mode switch,
microui treenode tree with sizes, entry split, refresh/retry, read-only text via a new editor
read-only flag), app/workspace wiring with pending-mode decisions, automatic raw fallback for
text-rejected files, mode persistence in the layout, and inspectable controls. New `format`
metrics in `theme.json`; `CMakeLists.txt` regenerated from `cmake.toml`.

**Verification**: Service tests failed before the module existed, then `npm test`: 31 passes
(4.86 s; final gate run 10.76 s). Native fixture red before wiring, then 1 pass (5.15 s); `npm run test:desktop`:
14 passes, 216.23 s, exit 0. CTest 4 passes (0.74 s); design check, `./init.sh`, sidecar check/stamp for eleven
files pass. Real consumer check against nolf-improved: declaration validates unchanged, tree of
`nolf/NOLF.REZ` in 69 ms (4,754 files), entries with matching sizes/SHA-256, entry paging, raw
window of the 618 MB archive, failing entry with relith-rez's stderr, and `preview_file` at
6.4 KB per slice. Evidence: `docs/evidence/project-format-registry-macos-2026-09-06.md`.

**Remaining**: Owner merges `feat/format-registry` into main after Codex's tree settles, runs
`update_workspace` (workspace, desktop, connector) so the live window and connector load the
routes and tool, then verifies `nolf/NOLF.REZ` opens raw and previews in the real project window;
F63/F64 stay false until that judgment. Deviations from the nolf-improved proposal are additive:
optional `dir`/`depth` on `preview_file`, hex `window` and `offset/length` paging on entries,
`bytes` route for raw windows; the declaration needs no change. KI-037 records Windows `.exe`
resolution, entry re-run cost and the treenode pool bound.

---

## Session 21 (macos) — 2026-09-06 — Project windows, interactive flows and curated skills

**Owner scope**: NOLF dogfooding needs a separate window with the current agent, inspection and
management, a return channel for rEngine findings and a reusable routine. The owner also requested
measuring/bundling llm-sidecar and adapting only the selected wizard skill, then clarified that
interactive script tabs are a first-class UI before native controls. Specs 069–071 record scope.

**Implemented**: Window layouts persist independently; the NOLF tree and existing rEngine agent
keep distinct explicit roots. Root-bound MCP/CLI open/list/inspect/focus/close/reopen windows and
exchange durable reports with retry keys/cursors. Added a reusable shell bootstrap and project
skills with Codex adapters. open_script/show_session run a project .sh as a retained interactive
PTY and attach its native tab without restarting coding agents. Production inspection cannot inject
keystrokes; view attachment failure returns the already-created script session for recovery.

**Real consumer**: The shell routine adopted the existing host without a keyboard restart and
opened NOLF with the original agent PID 20049. A subsequent agent-operated all-layer update
succeeded; the interactive workspace-status menu is now waiting in its new tab. Actual NOLF
report #2 requested pane zoom; acknowledged to that project and recorded as KI-036 for follow-up.
No game/provider/duplicate goal or conversation was launched. Existing agent/shell sessions remain.

**Verification**: Red MCP discovery for both window and script tools; final service 27 passes
(4.76 s), native 13 passes (103.92 s), CTest four passes, harness/design/inventory and shell syntax
pass. Native tests cover same-agent identity, separate selected layouts, draft recovery, reports
across updates and human-style interactive script input after reattachment. Six skill entrypoints
validate; bundled sidecar tests: 19 passes. Sidecar corpus output used 59.6% fewer bytes than full
source reads, but more than targeted excerpts; keep it selective. Excluding generated .cache
state improves real-workspace lookup and avoids indexing runtime credentials/captures. Full evidence:
`docs/evidence/project-window-dogfooding-macos-2026-09-06.md` and the sidecar efficiency record.

**Corrections/boundaries**: Fixed a test poll that raced next-request MCP worker replacement and
preserved reload-specific broker error text. An overlapped sidecar stamp hit SQLite writer
contention; reran sequentially with a separate session index and recorded cold-index limits. The concurrent OpenGL/F57 commit remains separate.
No broad feature gate changed here. ShellCheck unavailable; Windows runtime/transfer approval,
KI-024 gameplay and KI-036 zoom remain outstanding. Original host/supervisor protocol migrations
still require quiescence. The current older connector uses the CLI fallback; global configuration
and the user's installed skills were left untouched.

---

## Session 20 (macos) — 2026-09-06 — Layered workspace updates

**Owner direction**: Add agent-operated updates after one last keyboard bootstrap. Remained in
the verified root-bound rEngine CLI; preserved the original host, agents and shell PIDs.

**Implemented**: Spec 065 adds a private supervisor, replaceable workspace workers, immutable
native candidates with prepare/probe/rollback, a stable MCP facade with replaceable tool workers,
and a context-bound CLI fallback for the already loaded connector. Legacy native bootstrap adopts
the original host, deduplicates concurrent launches and creates no extra CLI. Updates report
acceptance separately from completion/recovery. Worker crash recovery retains sessions; original
host/supervisor protocol changes still require quiescence.

**Verification**: Failing MCP discovery before implementation; final service 23 passes (4.66 s),
native 11 passes (64.53 s), CTest four passes (0.05 s), harness/inventory pass. Native fixtures cover
dirty drafts, failed build/start recovery, old-launcher bootstrap and retained PID/input/invocation.
Evidence: `docs/evidence/layered-updates-macos-2026-09-06.md`. Concurrent F56 changes are preserved;
its initially failing draw-list test passes after that session's commit. Renumbered its duplicate
KI-031 design entry to KI-034, preserving the existing fixture KI-031 and all issue text.

**Remaining**: Production one-time adoption is not claimed; Windows runtime remains unqualified.
The owner next requested NOLF project-window management, inspection, a durable rEngine return
channel and a reusable agent routine. Continue that scope without a duplicate conversation or
goal. Earlier Windows transfer approval and OS shortcut-permission boundaries remain intact.

---

## Session 19 (macos) — 2026-09-06 — Repair Claude fullscreen mouse interaction

**Owner direction and context**: The owner prioritized the existing Claude `/rc` pane, where
items could not be clicked and scrolling did nothing. Verified the current orchestrator session
and root-bound MCP, preserving Claude PID 92674, Codex PID 20049 and original shells 33500/39735.
Private read-only Claude output shows alternate screen plus tracking 1000/1002/1003 and SGR 1006.
No provider prompt, Remote Control change, duplicate conversation/goal or sibling edit.

**Implemented**: Spec 063/F36 adds negotiated libvterm mouse buttons, hover/drag and precise signed
wheel, with logical cell mapping and native scrollbar/history precedence. Hover preserves keyboard
focus; held releases remain bound across pointer exit, focus loss, hide and detach. Snapshot replay
recreates the emulator and silences historical query responses that otherwise fill the outgoing
queue. Live queries still reply. Normal GUI close/reload releases buttons and drains queued and
in-flight stream sends before teardown, canceling visibly after two seconds if still busy. Pinned
upstream sources remain unchanged; headers/build declarations need no extra file-local notes.

**Verification**: The native click regression failed before the fix (8.71 s); a later regression
proved GUI close dropped the final held release (6.83 s). Final native desktop suite: eight passes,
48.00 s; CTest: three passes, 0.58 s; service/MCP: 21 passes, 4.41 s. Actual recorded Claude replay
passes (9.03 s), with no repeated historical query replies, SGR click/wheel delivery after same-PTY
reattachment and a working new live cursor query. Native checks also cover tracking modes, legacy
X10, modifiers, both screens, resize/pane movement, keyboard-focus isolation and final release.
Screenshots inspected; narrow static replay is protocol evidence, not live Claude layout proof.
Harness/inventory, source sizes/links, reviewed sidecars and diff checks pass. Full evidence:
`docs/evidence/native-terminal-mouse-macos-2026-09-06.md`.

**Environment findings**: Sandboxed service tests lacked loopback access; an unrestricted baseline
also inherited the real handoff into a temporary launcher fixture (20 passes/one failure). Tests
pass with only RENGINE_HANDOFF_FILE/GATE removed from test-child environments; KI-031 records the
fixture isolation gap. A transient missing-static-archive build failed once; the archive existed
on inspection and one sequential rerun passed. No cause is claimed; failed logs remain local.
The concurrent theme substitutions in b86f953 are included in the final tested build. Reviewed
and refreshed five stale source fingerprints from that commit; their notes still match the code.
Assigned this session's mouse issue KI-032 to preserve the concurrently committed design KI-030.

**Remaining and handoff**: The current Claude/agent/shell PIDs remain running. Cmd/Ctrl+Shift+R
loads the tested native build. The retained service/connector upgrade boundary and prior OS
shortcut-permission denial remain; no live GUI reload or live Claude menu action was claimed.
All 15 feature gates stay false. Return to KI-024 after owner-prioritized terminal repairs;
Windows, broader terminal clipboard/hyperlink/keyboard compatibility and optional service migration
remain independently scoped. Commit: `fix(native): forward negotiated terminal mouse input`.

---

## Session 18 (macos) — 2026-09-06 — Prepare the native UI for Claude Design

**Owner direction and boundary**: The owner asked to prepare the project for Claude Design to
enhance the UI. Treated as explicit, bounded preparation outside the paused NOLF goal; D28, every
feature gate and the active goal are unchanged, and no conversation or goal was started. Another
session's uncommitted spec 061/062 edits (native scroll/desktop-action sources, service, tests,
package.json) were present throughout and were left untouched and uncommitted.

**Implemented**: Spec 064 (renumbered from 063 after the other session's untracked 063 appeared) defines the single channel between Claude Design's HTML design-system
projects and the C/microui desktop. `design/tokens.json` (25 colours including the explicit
upstream microui defaults, typography, 12 metric groups, icon glyphs and UI strings) generates
`orchestrator/native/theme.h`, `design/tokens.css`, `design/manifest.json` and the managed blocks
of 13 self-contained `@dsCard` previews: colours, type/metrics and rendering constraints;
toolbar, pane header and status line; scrollbars; tree, editor, terminal, session browser and
game views; a 1280×800 workspace screen. `tools/design.py generate|check|import` uses the standard
library. `draw.c` now applies the generated palette, microui metrics, font size and line height
and carries a `generated-theme` sidecar constraint. Architecture table row, KI-030 and a design
README were added. Nothing under `design/` is loaded at runtime.

**Verification**: `python3 tools/design.py check` passes: header, CSS and manifest regenerate
identically, 13 cards are valid and self-contained, and every native `mu_color`/`vterm_color_rgb`
literal is a token. Native smoke snapshots from the pre-change binary and the rebuilt binary are
byte-identical (1280×800 logical, 2560×1600 drawable, cocoa); the PNG was inspected. CTest: three
passes. Import round trip: changing `--re-color-control` in a scratch copy of the colours card
moved the token and `RE_COLOR_CONTROL` to (60, 70, 90); tokens were restored and regenerated with a
passing check. Sidecar validator OK after one anchor repair. Harness gate passes. A read-only
DesignSync `list_projects` was refused until the owner ran `/design-login`; it then listed no
projects. On the owner's go-ahead: created design-system project “rEngine native workspace”
(`9e977c1b-7cbd-4a89-90a4-5524771712d7`), verified its type, locked a plan limited to `design/**`
(writes only), uploaded 18 files from disk and confirmed the remote listing matches the bundle.

**Remaining**: Cards edited in Claude Design return through `tools/design.py import`; later
syncs reuse the same project with a per-run plan limited to `design/**`. Replace the remaining literal colours in editor, terminal, workspace,
scroll, main and game sources with `RE_COLOR_*` once specs 061/062 land. No feature row was
added; spec 064 records a candidate. A Claude Design canvas seeded from `screens/workspace.html`
is an optional later step. All 15 feature gates remain false.
Commit: `feat(design): add Claude Design token bridge and preview library`.

**Follow-up (same session)**: On owner direction, replaced every remaining `mu_color` and
`vterm_color_rgb` literal in the editor, terminal, workspace, scroll, main and game sources with
`RE_COLOR_*`; `common.h` now includes `theme.h`, and `tools/design.py check` fails on any numeric
colour literal. Baseline and post-change native smoke snapshots of the same tree are byte-identical;
CTest: three passes; sidecar anchors valid; harness gate passes. The other session's uncommitted
terminal mouse-reporting edits in terminal.c and workspace.c stayed unstaged: those index entries
were built from HEAD plus the substitutions only. Commit:
`refactor(native): draw every colour through the generated theme constants`.

**Follow-up 2 (same session)**: On owner direction, moved the layout metrics onto the header.
Window size and minimum, toolbar rows and column widths, workspace top, status line, divider,
pane minimum and tree share, pane header and rows, tab-strip geometry, tree/session/editor/
terminal/game rows and insets, caret width, editor tab cells and native scrollbar sizes now come
from `RE_METRIC_*`; `tokens.json` gained 24 keys and `RE_SCROLLBAR_SIZE` was retired. `check`
also fails on numeric sizes in `mu_layout_row` calls, and the preview cards use the same
variables. Baseline and post-change smoke snapshots are byte-identical; CTest: three passes; the
seven committed native desktop specs pass (40.8 s); harness gate passes. The other session
committed its mouse-reporting work (`3c12fea`) while this was staged, so the shared
workspace/app/terminal entries were rebuilt from that HEAD plus the substitutions and verified
to contain none of its hunks. Commit:
`refactor(native): take layout metrics from the generated theme header`.

**Follow-up 3 (same session)**: The owner reported Claude Design updates that need rendering work
and set the direction: full GPU rendering behind graphics-API adapters, OpenGL first, then Metal and
Vulkan, with the renderer as a future approved-library candidate. Recorded as charter D29–D30, an
AGENTS boundary, architecture constraint 15, roadmap milestones R0–R3, features F56–F61 (blocked
behind existing desktop features) and spec 066 (renumbered from 065 after the other session's
untracked 065 appeared). Pulled the theming update verbatim: three-layer
`tokens.css` with default/teal/light presets, rewritten `base.css`, `styles.css`, six new cards and
thirteen rewritten cards. `tools/design.py` now parses the layered CSS, mirrors it into
`tokens.json`, resolves presets to sRGB with oklch conversion and validates cards that link
`styles.css`; the interim native source moved to `orchestrator/native/theme.json` and `theme.h` is
unchanged. `check` found `--terminal-cursor` referencing an undefined `--ui-accent-dim`; fixed
to `--re-accent-dim`, and the mirror now follows the CSS font stacks. On the owner's go-ahead the
corrected `tokens.css`, mirror, manifest and README were synced back to the design project (plan
limited to those four paths, four files written, remote cursor token verified). Harness
gate, graph regeneration and design check pass. Commit:
`feat(design): record the GPU rendering decision and pull the theming update`.

**Follow-up 4 (same session)**: On owner direction, started F56 although the inventory still
blocks it behind F34 and F42. Spec 067 defines draw-list contract v1 (`render/draw_list.h`: clip,
rect, rounded rect with corner mask, frame with inner highlight, shadow, ring, text runs in two
faces, icons, textures; string arena; sticky overflow with limits) and the adapter interface
(`render/backend.h`). Fonts moved to `render/font.c`, UTF-8 helpers to `render/utf8.c`, and all SDL
rendering into `render/backend_sdl.c` as the reference adapter. `draw.c` keeps the `re_draw_*` API as
a list builder that flushes once per frame on snapshot or end; the game view creates, updates and
draws its texture through the contract. `tools/design.py check` now fails when a native file above
the list names SDL rendering, OpenGL, Metal or Vulkan symbols. Verification: native smoke
snapshots before and after are byte-identical; CTest four passes including the new
`native_draw_list`; the eight committed native desktop specs pass on the reference adapter
(50.0 s); sidecars valid; harness gate passes. Evidence:
`docs/evidence/draw-list-macos-2026-09-06.md`. The other session's uncommitted CMake, main.c and
app.c edits stayed unstaged; the CMake index entry was built from HEAD plus the new sources and
test. F56 stays `passes: false` with its evidence recorded; F57 (OpenGL adapter) is next. Commit:
`feat(native): add the draw-list contract and SDL reference adapter (F56)`.

**Follow-up 5 (same session)**: F57 on owner direction after a `/grill-me` interview (spec 068
records eight attributed decisions; against the recommendation the owner chose OpenGL as the macOS
default on pass, a non-zero exit instead of a fallback, and vendored, pinned glad). The skills
grill-me, rengine-continue, rengine-audit, rengine-housekeep and rengine-ki-promote were copied and
adapted from nolf-improved with Codex adapters (commit ee744b1). `render/backend_gl.c` is an OpenGL
3.3 core adapter behind the draw list: one batched program (solid, signed-distance fill, ring and
shadow, coverage atlas, RGBA texture), a 2048² glyph atlas that repacks when full, scissor clips and
`glReadPixels` snapshots. Selection is `--renderer opengl|sdl` or `RENGINE_RENDERER`; the smoke line
and automation `state` report `backend=`; automation gained `stats` and `scene`; `scene.c` draws
every primitive; `tools/render_compare.py` applies the recorded tolerances;
`native-render.spec.mjs` captures both backends from separate server state with stable text and
is part of `npm run test:desktop`. Results: workspace and terminal scenes pixel-identical to the
SDL reference; primitives 0.80% differing, all within the 2px band (the per-channel limit inside
the band was dropped by owner decision after measuring 139); OpenGL medians 0.297/0.411/0.491 ms
against SDL 0.663/1.990/1.413 ms; resident memory +20.3 MiB of 32; the eight committed native specs
pass on OpenGL (50.7 s); CTest four passes; `--renderer sdl` stays byte-identical to the F56
baseline. The macOS default is now OpenGL; Windows keeps SDL and F57 stays unpassed until Windows
evidence (KI-014). Evidence: `docs/evidence/opengl-adapter-macos-2026-09-06.md`. Commit:
`feat(native): add the OpenGL adapter behind the draw list (F57)`.

**Follow-up 9 (same session)**: F60 on owner direction (“we need to update design to the proposed by
Claude Design, if microui is not enough - we write addition keeping the same compatible contract and
conventions like in microui lib”) after a `/grill-me` interview: spec 076 records eleven decisions,
charter D33–D34, and the split of F60 into F60/F67/F68/F69. Landed: `design/tokens.css` is now the
runtime theme source (theme.json holds bindings, `theme.c` carries every preset, `re_draw_theme`
switches live); `orchestrator/native/ui` is a separate `rengine_ui` target with owned controls in
microui's conventions and a transition clock; Inter and Phosphor are pinned as bundled faces with an
owned symbol-to-icon mapping; the toolbar, tab strip and status bar are redrawn to their cards; the
renderer became its own `rengine_render` target. Verification: `design.py cards` generates
`design/cards.json` from the tokens and `native-design.spec.mjs` probes real snapshot pixels across
all three presets; desktop suite 17/17, CTest 4/4, render comparison passing on all four backends.
Two measurement corrections were needed and are recorded in the evidence: the current-UI scenes now
carry the edge-band rule instead of a per-channel limit, because they contain anti-aliased rounded
controls, and resident memory is the median of four samples because a single reading swings by more
than the budget. Evidence `docs/evidence/design-foundations-macos-2026-09-06.md`; the owner signed off on the card
snapshots and confirmed the tolerance amendment, so **F60 passes**. rEngine also gained its own `.rengine/project.json` (contract 2) with a BMP
preview format and nine dashboard actions, verified through the service's readers.

**Follow-up 10 (same session)**: owner review of the new toolbar (“some paddings and margins should be
adjusted”, “close x should be inside tab indicator”, “suggested prompt should have lower opacity”) and
a request to take up the project explorer, which starts F67. The card stylesheet fixes constants the
tokens do not name, so they became design metrics with their source noted, and the toolbar now uses a
uniform 8px rhythm with 10px edge padding, 24px controls, a bordered segmented group with an accent
bar under the active member, and separators with their own margins. The tab close moved inside the
tab, which is also what the overflow arithmetic expects. The project explorer is rebuilt on the
control layer: a path bar with the root and the path within it, and 22px rows with icon, ellipsised
name and a right-aligned meta column that marks unsaved drafts and symlinks. Panes now paint their own
background so views can draw their own faces; the pane root row stays for every view except the
explorer, which shows the root in its path bar. Placeholders take a lower alpha than typed input.
Suite 17/17 after each change. The session browser became the card's table with state pills, the editor
gained its breadcrumb bar with a state pill and right-aligned actions, and the microui button helper
retired because every surface now uses the control layer. Two specs that clicked fixed coordinates now
click by control record. Owner decision during this round (spec 068 amendment): frame time is gated on
an absolute 8 ms per scene rather than at-or-below the SDL reference, because the adapters now
anti-alias shapes the reference draws hard-edged; the ratio against the reference is recorded as
information. Needless clipping was removed from the controls first, which cut the OpenGL workspace
median by about a third. The terminal followed: default cells now resolve against the live theme, so a preset switch restyles
history the terminal already produced, and every preset's terminal background matches its token
exactly. Scrollbars became the card's overlay bars with rounded thumbs and rest, hover and accent
states. The design spec probes the view surfaces per preset too. Evidence
`docs/evidence/design-views-macos-2026-09-06.md`; suite 17/17, CTest 4/4. F67 stays open on the
editor's gutter, current-line tint and syntax colours, which still use the pre-design drawing inside
editor.c, and on the card's per-directory counts, which need a field the file listing does not carry.

**Follow-up 11 (same session)**: owner asked for syntax highlighting tunable with IDE-style presets,
and reported missing glyphs in the Claude pane. The glyph report was a real defect: Claude Code's
status line uses U+23F5, which neither Menlo nor Inter nor any font installed on this machine carries,
so it drew as tofu. Glyph lookup now tries the requested face, then the other loaded faces, then a
substitution table for the six media-control code points no face has; advances are untouched, so the
monospace grid and every adapter's placement are unmoved. Spec 077 records the highlighting design:
nine token roles, a line-based tokeniser with a carry state (`syntax.h`/`syntax.c`, written by an Opus
subagent against the header, with `native_syntax` under CTest covering every language plus hostile
input), and four schemes in `syntax.json` resolved per theme preset into a generated table. The editor
gained the card's 44px gutter with line numbers, the current-line tint, its own background and
per-character colouring with a per-line carry cache so scrolling is not a rescan. The design spec
opens a C file and asserts the keyword colour is on screen in the dark and light presets. Suite 17/17,
CTest 5/5. A scheme is chosen through the automation `syntax` op until the theme panel lands (F68).

**Follow-up 8 (same session)**: F59 on owner direction after a `/grill-me` interview (spec 073;
charter D31 names `pr0fe@192.168.31.217` as the Windows verification host and authorizes the
commits-only transfer KI-014 waited for; D32 sets the Vulkan floor at the Quest 3 maximum, researched
as 1.3). `render/backend_vk.c` (Vulkan 1.3 core, dynamic rendering, entry points through SDL,
vendored Vulkan-Headers v1.4.328, SPIR-V committed by `tools/shaders.py` from owned GLSL, a glyph
pre-pass because transfers are illegal inside a rendering scope, two frames in flight) lands behind
`--renderer vulkan` on every platform; macOS keeps Metal as default and uses Homebrew's loader with
MoltenVK as the development path. The render spec now captures `sdl`, `opengl`, `metal`, `vulkan`,
probes for a missing loader, and repeats the Vulkan capture under `VK_LAYER_KHRONOS_validation`;
the first validated run found an HDR colour-space pick and a missing shader-demote feature, both
fixed. macOS results: Vulkan pixel-identical to OpenGL and Metal on every scene, below the SDL
median everywhere, memory below SDL, 0 validation messages, suite 13 of 13 on
`RENGINE_RENDERER=vulkan`, CTest 4/4. Evidence `docs/evidence/vulkan-adapter-macos-2026-09-06.md`.
Windows bring-up started per the runbook `docs/runbooks/windows-verification.md`: SDL2 2.32.10 dev
files and the LunarG SDK 1.4.357 installed, the pre-Vulkan HEAD builds with MSVC and its SDL and
OpenGL smoke snapshots are byte-identical; CTest editor/terminal binaries lacked `SDL2.dll` (copy
added in `cmake.toml`). Windows results (`docs/evidence/opengl-adapter-windows-2026-09-06.md`, `vulkan-adapter-windows-2026-09-06.md`):
OpenGL and Vulkan pixel-identical to each other and within tolerance against SDL, both below the SDL
median, Vulkan validation clean on the NVIDIA driver, smoke snapshots of all backends byte-identical;
OpenGL memory +24–28 MiB, Vulkan +54–60 MiB after the allocation trim (`b0a6d4b`) against the 32 MiB
ceiling; the owner then amended that budget to 64 MiB for Vulkan on Windows (charter revision record,
spec 068 amendment, KI-039 closed) because the NVIDIA driver's process baseline sits about 30 MiB above
OpenGL's on the same DLL, and the Windows render run passes under it, so **F59 passes**. The suite passes
7 of 15 there on either backend (KI-038:
layered-update unlink, symlink fixture, tree scroll, four terminal specs; fixed on the way: `_spawnv`
quoting, DLL copies, `python`, the game fixture path, `--test-force-exit`). F62 stays open on its suite criterion.

**Follow-up 7 (same session)**: F58 on owner direction after a `/grill-me` interview (spec 072;
inventory corrections committed first as `b119a3e`). `render/backend_metal.m` is the one
Objective-C file (ARC, `SDL_WINDOW_METAL`, SDL's Metal view, MSL compiled from an embedded string,
the OpenGL adapter's shading, atlas and batching ported), `cmake.toml` enables Objective-C on Apple
only, `draw.c` selects `metal`, the layering guard scans `.m` files, and the render spec captures
`sdl`, `opengl` and `metal`, gating both GPU adapters against SDL and recording Metal-versus-OpenGL.
The first spec run failed on every scene for both GPU adapters with identical pixels between them:
the login shell's asynchronous prompt moved between captures, so the spec now starts `bash --norc`
with a fixed prompt. Results: Metal pixel-identical to OpenGL on every scene, 0 differing pixels on
the current-UI scenes, primitives 0.8% inside the band, Metal medians below SDL on every scene,
memory below SDL; suite on `RENGINE_RENDERER=metal` 13 of 13 tests across twelve spec files; CTest 4/4; smoke snapshots of
all three backends byte-identical; macOS default flipped to Metal. Evidence
`docs/evidence/metal-adapter-macos-2026-09-06.md`; F58 passes. Commit:
`feat(native): add the Metal adapter behind the draw list (F58)`.

**Follow-up 6 (same session)**: On owner direction the build moved to cmkr as in nolf-improved:
`cmake.toml` at the root defines every native target and CTest entry, `adapters/sdl2/cmake.toml`
the surface adapter and its fixture, and `cmake/cmkr.cmake` (tag v0.2.46, copied verbatim)
bootstraps cmkr into the build directory on first configure and regenerates the committed
`CMakeLists.txt` files; the hand-written native CMake file is gone and `tools/design.py check`
rejects hand-edited build files. Verified after regeneration: the same targets and four CTest
entries, default and `--renderer sdl` smoke snapshots byte-identical to their baselines, the surface
adapter and fixture rebuilt and the game spec passing. Commit:
`build: generate CMakeLists.txt from cmake.toml with pinned cmkr`.

---
## Session 18 (macos) — 2026-09-06 — System scrolling, visible bars and agent reload

**Owner direction and context**: Remained inside the verified root-bound rEngine agent session
`a0de60fe-eac8-4e75-8ea8-fe8f4aa3c83a`, PID 20049. The owner requested trackpad direction matching
system settings, scrollbars on scrollable panes, and agent invocation of Cmd/Ctrl+Shift+R through
MCP. Prioritized specs 061–062 without a duplicate conversation/goal or game/sibling edits.

**Implemented**: Removed the extra FLIPPED negation that undid Cocoa's system-adjusted deltas;
shared signed precise accumulation now covers terminal/editor/microui input. Added native
terminal history and two-axis editor bars with thumb dragging, track paging and clamped ranges.
Tree/session lists retain upstream microui bars. Wheel follows hovered content without retargeting
keyboard focus or project bindings. Added authenticated ephemeral desktop discovery and explicit
root-bound MCP reload, with capability/version checks, bounded acknowledgement and stale/foreign/
unsupported-target rejection. The action enters the existing durable native quit/rebuild path;
it reports acceptance separately from build success and retains processes without another prompt.

**Verification**: Corrected direction assertion failed before implementation (exit 134); actual
MCP tool discovery failed before the new actions existed. Final `npm run test:desktop`: seven
passes, 41.12 s; CTest: three passes, 0.62 s; `npm test`: 21 passes, 4.30 s. Real MCP stdio plus
normal native launcher prove dirty draft recovery, replacement desktop ID, unchanged instrumented
CLI PID and one invocation across keyboard and MCP reloads. Native pointer tests cover terminal/
editor endpoints, both axes, track paging, precise inverted events, tree overflow, unchanged
editor bytes and no unintended PTY input. Screenshots inspected. Harness/inventory, reviewed
sidecars and diff checks pass. Headers, build declarations and straightforward broker/MCP test
assertions need no additional file-local notes. Evidence:
`docs/evidence/native-scroll-controls-actions-macos-2026-09-06.md`.

**Live rollout and remaining**: The retained service/connector still predate desktopActions
version 1; a fresh connector reports this limitation without replacing the service. A targeted
shortcut attempt against verified production desktop PID 62416 was denied by macOS Accessibility
(error 1002, osascript cannot send keystrokes). No OS settings or retained processes were changed;
the native build is ready for Cmd/Ctrl+Shift+R. Agent actions become available after explicit
service/connector upgrade. Current agent and original shell PIDs remain running. All 15 feature
gates remain false. KI-024 menu-state qualification is next; preserve the known initial NOLF
selection -1 finding, Windows transfer approval boundary and optional service-migration decision.
Commit: `feat(orchestrator): add system scrolling, pane bars and MCP reload`.

---

## Session 17 (macos) — 2026-09-06 — Scroll the running agent pane

**Environment and steering**: Verified `RENGINE_ORCHESTRATOR_SESSION` identifying
`a0de60fe-eac8-4e75-8ea8-fe8f4aa3c83a`, root-bound MCP workspace/session identity and running
agent PID 20049 before continuing. Harness and 20 service tests passed. During KI-024 read-only
investigation the owner reported missing scrolling in the active agent pane, so prioritized
spec 060/F36. No game or sibling files were edited and no duplicate conversation/goal started.

**Implemented**: Primary-screen libvterm history in a 2,000-row/8 MiB ring; mouse/trackpad and
Shift+PageUp/PageDown/Home/End navigation; reading position held under new output; typing returns
to live. Wheel targets the hovered terminal without changing keyboard focus. Alternate-screen
output stays separate; cursor visibility and the history position indicator follow the view.
Resize callbacks restore recent rows; attachment/reload rebuilds available history from the same
retained PTY. Headers and build-list additions need no extra file-local rationale; substantive
terminal/routing/test rationale is recorded in reviewed sidecars.

**Verification**: The pre-fix native PTY/wheel regression failed to reveal earlier rows. Final
native scroll checks pass across continued output, alternate screen, resize, pane movement,
hover/focus isolation and GUI restart with the same PIDs. Replaying actual ended Codex output
also scrolls and returns to live (5.55 s), without a provider run. Final desktop suite: six
passes, 39.54 s. CTest: three passes, 0.56 s, including history clearing and line/byte limits.
Service baseline: 20 passes, 4.29 s. Screenshots inspected: early colored history and actual CLI
history render; the selected font still lacks CJK glyphs. Harness/metadata/diff checks pass.
See `docs/evidence/native-terminal-scroll-macos-2026-09-06.md`. Local recordings remain ignored.

**Remaining**: The owner can load this build with Cmd/Ctrl+Shift+R while retaining this CLI.
All 15 feature gates remain false. KI-024 still needs a real menu-state oracle; source inspection
also found NOLF's main folder intentionally starts with selection -1, so Enter alone must not
be assumed to select Single Player. Establish selection deliberately and distinguish that from
letterbox routing before changing input. Terminal selection/copy, history reflow and Windows
remain open; existing Windows transfer and optional service-migration boundaries persist.
Commit: `feat(native): add bounded terminal scrollback and pointer navigation`.

---

## Session 16 (macos) — 2026-09-06 — Repair shared terminal freeze during resume

**Owner direction and environment**: The exact real conversation resumed in the native pane.
Verified its `RENGINE_ORCHESTRATOR_SESSION`, running agent PID 33534 and root-bound rEngine MCP
workspace/session calls for this checkout. The owner then reported both agent and shell unable
to accept input and suggested incomplete terminal animations. The original GUI/agent exited;
the same conversation was resumed externally. Prioritized this explicitly authorized handoff
repair and deferred NOLF KI-024 without game/sibling edits. No new conversation or goal.

**Reproduced and fixed**: Animated ANSI alone stayed interactive, but an 8,000-event burst
filled the 128-message native receive queue and killed the shared stream worker. Its disconnect
notice could also be discarded, leaving apparently connected panes with undelivered input.
Spec 059 adds receive backpressure, bounded per-tick draining, disconnect status and retries
to the same authenticated endpoint. Reattach retained terminal IDs through fresh snapshots,
discard unsent/offline input and preserve processes, bindings and drafts. No launch or repeated
continuation occurs during recovery. Automated native windows now have a distinguishing title.

**Verification**: Pre-fix animation-only pass (6.17 s), burst regression fail (14.15 s); final
real PTY/native input checks pass in both panes after burst and forced outage with the same
PIDs, two sessions and no offline-input replay. Replaying 803,215 bytes from the ended real
Codex session through the test PTY also passes (8.69 s), without another provider run. Service
tests: 20 passes (4.30 s). Final desktop suite: five passes (41.89 s). CTest: two passes
(0.45 s). Screenshot visually inspected; the selected font lacks the spinner glyph, separately
from input recovery. Harness/inventory, metadata and diff checks pass. Actual recording stays
ignored/local. Evidence and exact limits: `docs/evidence/native-terminal-recovery-macos-2026-09-06.md`.

**Preserved state and next**: Original retained service PID 33465 and user shell PIDs 33500/39735
remain running; tests cleaned up only their own fixtures. All 15 feature gates remain false.
After the current conversation writer exits, run `npm run resume` and verify the new attached
agent environment/MCP before returning to KI-024. Service identity replacement and Windows
remain unqualified; the Windows transfer approval boundary and optional service-migration
decision remain unchanged. Commit: `fix(native): keep terminal streams responsive and reconnect retained sessions`.

---

## Session 15 (macos) — 2026-09-05 — Pause at the orchestrator handoff

**Owner direction**: stop broader feature work here and resume this exact agent conversation
inside the native orchestrator after prerequisites. The handoff is the remaining authorized
work for this session. AGENTS and charter D28 preserve that boundary. No feature or overall goal
is marked complete. The available goal API cannot pause; the application's Pause goal control
remains owner-controlled, and this agent stops broader work after the checkpoint.

**Implemented**: Before the pause request, added bounded tab-strip arrows, reorder and Merge
pane with stable view identity, selected-header reveal, draft/order persistence and retained
PTYs (spec 057). Then added spec 058: explicit Codex UUID/project/checkpoint validation, CLI
resume/login probes, a private per-session manifest snapshot and readiness gate. The real CLI
starts only after its native terminal is attached and presented. Concurrent handoff creation and
later launches reuse the same live conversation PTY. Native Cmd/Ctrl+Shift+R flushes drafts/layout,
rebuilds the C desktop and reconnects without a second continuation prompt. Old sidecars must
advertise handoff capability; they cannot silently launch an ungated CLI. Normal close detaches.

**Verification**: Native desktop suite: four passes (game texture/capture, handoff/reload,
pane navigation and workspace/editor/PTY), 24.23 s; CTest: two passes, 0.33 s. Service suite:
20 passes, 4.36 s on the final source; the hardened manifest-snapshot native regression also
passes (8.43 s). Final checks are recorded in the handoff evidence. The handoff consumer uses an instrumented managed CLI with a real PTY,
Bash/MCP setup and actual native presentation/rebuild: rejected login creates no session;
no CLI before its visible pane; explicit UUID/MCP args delivered once; interactive output and
same PID retained; dirty draft survives reload; repeated launch does not invoke again; Stop
allows a fresh waiting bootstrap. Real installed Codex 0.153.4 has resume support, authenticated
ChatGPT login and matching local session metadata. The active conversation is not reopened
concurrently; its real continuation happens at the next launch. All test-owned processes are
cleaned up. See `docs/evidence/orchestrator-handoff-macos-2026-09-05.md`.

**Honest remaining finding**: Moving real NOLF into/out of a narrow pane preserves frames and
PID, but the last inspected `game-input.png` remains on the main menu after Enter. The combined
test's green result lacks a menu-state oracle. Recorded KI-024 instead of claiming post-move
input works. The speculative letterbox regression/debug addition was withdrawn when work was
paused, leaving the tested pane checkpoint. No game-input fix was added. Windows source transfer
approval, Node-service timing and other existing limits remain outstanding.

**Next session**: Run `npm run resume` from this checkout after the current writer yields. Local
`.cache/handoff/current.json` selects this conversation; `.cache/orchestrator-development` is
its retained workspace. Read `docs/handoff/2026-09-05-orchestrator-resume.md`, verify the attached
agent/MCP root and resume the existing goal there, starting with the missing NOLF menu oracle.
No automatic continuation outside the orchestrator overrides the owner's pause.

---

## Session 14 (macos) — 2026-09-05 — Qualify the normal native NOLF launcher

**Goal turn classification**: progress. The owner's no-Electron/runtime-overhead constraint
remains explicit in AGENTS, charter and architecture. The future web client stays independent.
This turn qualified the normal C/microui workflow, beyond the previous isolated component tests.

**Implemented**: `test:workspace` now drives the actual npm launcher, including build, retained
sidecar and initial NOLF/shell/Codex creation. Optional stdin inspection reports bounded clipped
control geometry and accepts SDL wheel events; actions still use real native input. Fixed a
microui hover regression discovered by adding the real source project: schedule one settling
frame when entering another root container so the first click works without continuous repaint.
The shared test bridge accepts launcher build output and matches the Windows multi-config path.

**Verification**: Combined check passed in 15.06 s: executed shell output, installed Codex 0.153.4
with eight connected rEngine MCP tools, real NOLF tree/README, two-root Unicode Save/conflict/
Discard, dirty editor movement, NOLF Single Player menu input, GUI detach/reattach/restart with
the same process identities and draft, and session-browser Stop affecting only NOLF. Screenshots
were inspected; all four test-owned service/session PIDs exited after cleanup. NOLF checkout
status and source README were preserved. Nineteen service tests, two CTest checks and both existing
native GUI regressions passed. Evidence: `docs/evidence/native-workspace-macos-2026-09-05.md`.

**Remaining**: All feature gates and the overall goal remain open. Native previews, terminal/
editor breadth, reconnect/failure recovery, in-level aiming/DPI, packaging/resource budgets and
Windows qualification remain. KI-023 records observed tab overflow and field/status polish.
Windows source-transfer approval and the optional Node-service timing answer are still pending;
neither was inferred from silence. No Windows source transfer occurred.

**Next**: Continue the native workflow gaps and resource/recovery qualification. Preserve C/microui
presentation and independent game/library ownership through any later service migration.

---

## Session 13 (macos) — 2026-09-05 — Replace Electron with C/microui

**Goal turn classification**: progress. The owner explicitly rejected Electron and selected C
with microui, followed by a separate later web interface. Charter D26–D27, architecture, roadmap
and AGENTS now preserve that constraint. A question about moving the separate Node session service
to C remains optional/pending; that service has not been rewritten by the GUI migration.

**Implemented**: A real C11/SDL2/microui desktop now replaces the Electron/React/CodeMirror/xterm
UI and is the normal launcher target. Pinned C libraries provide JSON, terminal emulation,
text editing, font rasterization and loopback transport. Native split/tab layout, root-bound
file tree/editor, Save/conflict/Discard/drafts, real PTYs, session browser/Stop, live game textures
and native capture/Escape handling are connected. Removed browser-only packages, source/tests
and static serving. A web client is a future independent consumer. Vendored upstream remains
pristine, with licenses/hashes and a documented owned-source style exemption.

**Verification**: All 19 service checks pass. CTest layout/editor checks pass with Release
assertions active. Native GUI tests pass executed PTY output, Unicode Save, external conflict,
Discard, dirty-tab movement, durable close/restart and same shell PID. The actual SDL fixture
passes live texture, native capture, held W release on first Escape, next Escape delivery and
explicit asynchronous Stop. Actual NOLF main-menu to Single Player input, GUI restart with the
same PID and Stop pass in an isolated copied-binary/archive-only runtime directory. Installed
Codex 0.153.4 boots through the real Bash launcher in the native terminal; its startup was
visually inspected without sending a coding prompt. Details: `docs/evidence/native-desktop-macos-2026-09-05.md`.

**Corrections/findings**: Strengthened terminal proof to distinguish executed output from echo.
Excluded a game mouse-up originating from the Capture button. Native Vim mode entry suppresses
the initiating SDL text event; undo tests position the cursor explicitly. Respect microui's
fixed command-root capacity with 15 panes. Rasterize fonts at drawable density; avoid idle repaint
loops. Moving the downloaded curl cache beneath an ignored build directory prevented the sidecar
indexer from ingesting thousands of generated/dependency files. All source metadata was reviewed.

**Remaining**: Native combined-launch/MCP interaction, image previews, terminal/editor breadth,
reconnect/failure handling, in-level aiming, logical/drawable game input mapping, packaging,
resource budgets and Windows qualification remain open. The Windows source-transfer auto-review
rejection remains in force; no transfer occurred. No feature or overall goal is marked complete.
The former Electron tests/evidence are historical, not a native release pass.

**Next**: Complete the native workflow and qualification against unchanged accepted criteria;
retain service/engine independence and incorporate any owner steering on the service implementation.

---

## Session 12 (macos) — 2026-09-05 — Game button release and actual lobby movement

**Goal turn classification**: progress. The preceding remote-only turn confirmed synchronization
but did not advance gameplay. This turn reproduced and fixed a native mouse-up loss when the
pointer left the canvas. Ordinary release preserves held movement; capture loss and pane blur
release controls, and subsequent focused keyboard input reacquires session ownership.

**Verification**: Nineteen service smoke checks passed (4.3 s). The completed SDL/Electron input
regression and existing GL/key check pass (13.1 s total). A real isolated NOLF run entered the
UNITY lobby, strafed left and moved forward, with inspected release evidence and preserved host
files. The direct gameplay probe is now checked in; its separate launch/menu/cleanup run exited
0 and stopped its own processes. Evidence/pins are in `docs/evidence/gameplay-input-macos-2026-09-05.md`.

**Findings**: Sustained Playwright raw-frame tracing stalled its Electron process at 6.2 GiB;
direct CDP input/screenshots stayed responsive. This comparison changes the sustained test
method, not the production surface or performance criteria. Early probe cleanup needed explicit
process termination; the checked-in tool now closes its client/child streams and stdin reference.

**Unproven**: Pointer lock failed before permission handling. Native window focus stayed false;
CoreGraphics confirms the Mac session is locked. An unlock request is pending. The explicit
`RENGINE_REQUIRE_POINTER_LOCK=1` check remains a required additional qualification, not part of
the passing button-release claim. Windows source-transfer approval is also still pending; its
auto-review rejection remains in force. All 15 feature gates and the overall goal remain open.

**Next**: Qualify relative aiming on the unlocked Mac; complete drawable/logical DPI mapping,
recovery and resource checks. On approved transfer, wire and qualify the Windows adapter/desktop
in an isolated checkout. No active probe/test process is intentionally left running.

---

## Session 11 (macos) — 2026-09-05 — Windows environment fix and transfer approval

**Goal turn classification**: progress. Preview checkpoint `fa7e346` and preceding launch/agent
commits were pushed to the requested origin. Fixed Windows environment key normalization while
preserving POSIX behavior. Nineteen service tests pass, including both new environment checks
and actual macOS PTY/MCP/agent tests (about 4.4 seconds).

**Windows authority**: Read-only checks reached the NOLF-configured Windows machine and read
its local checkout rules/tools/status. Automatic approval review rejected copying the committed
261 KiB source bundle to that host: the destination was inferred from project configuration,
not directly authorized by the owner. No source transfer occurred. An explicit async approval
question names the machine/destination and isolated checkout; it remains pending. Do not bypass
the rejection through clone, archive streaming or another transfer mechanism.

**Scope**: The environment regression proves path/key transformation, not Windows process
execution. Installed Codex/Claude help confirms their native update commands exist; managed
Codex download/update remains the actual update runtime proof. No global agent update occurred.

**Next**: On approval, transfer the prepared source and run native Windows qualification in an
isolated checkout, preserving the dirty NOLF checkout. While approval is pending, local gameplay,
input/DPI, editor/session failure recovery and packaging/performance work remain available.
The complete goal stays active; no blocker/completion state or feature pass is claimed.

---

## Session 10 (macos) — 2026-09-05 — Image previews and verified pane movement

**Goal turn classification**: progress. Combined-launch checkpoint committed as `7c407f3`.
Added actual image previews with bounded authenticated reads and root-bound tab persistence.
The complete Windows/gameplay/recovery qualification remains active.

**Implemented/verified**: PNG/JPEG/GIF/WebP browser decoding, fit/actual size and refresh; invalid
metadata/data and byte/pixel limits report errors. Object URLs and reads are released on view
replacement/detach. Seventeen service tests pass; the real image test verifies two roots with
different pixels, refresh, decoder-error recovery and GUI restart. Existing text/terminal checks
still pass. Evidence is in `docs/evidence/image-previews-macos-2026-09-05.md`.

**Evidence correction**: A stronger pane-position assertion exposed that the previous short
Playwright drag emitted no drop on this Electron/macOS profile. The tests now use intermediate
pointer moves and assert actual destination coordinates. NOLF passes the stronger move/input/
restart/Stop check (11.1 seconds), and preview movement passes (about 2.1 seconds). Historical
survival-after-gesture assertions alone were insufficient; refreshed native evidence records the
correction. This required test input changes, not a replacement layout implementation.

**Windows progress/next**: The NOLF project's configured Windows host was reachable with a
read-only SSH check. It has Node 24.15.0, npm 11.12.1, Git, CMake, Ninja and an active console
session. Its older NOLF checkout has unrelated edits; preserve it. Read its AGENTS/CLAUDE rules.
Use an isolated rEngine qualification checkout next; Windows game integration, installed-agent
proof, gameplay/DPI, packaging, resource budgets and failure recovery remain open. The earlier
host question no longer prevents establishing Windows tests. No feature/goal marked complete.

---

## Session 9 (macos) — 2026-09-05 — Combined production launch and two-root editing

**Goal turn classification**: progress. Pushed the earlier native/desktop commits as requested;
committed agent bootstrap as `bdae7a3`. Verified the actual npm launch command rather than only
separately constructed desktop/service tests. The complete goal remains active.

**Implemented/verified**: Explicit opt-in local UI inspection enables acceptance automation of
the normal launcher. Missing project/game prerequisites now fail before new shell/agent sessions.
The combined test passes (29.3 seconds): actual NOLF frames, installed Codex with MCP tools,
real shell input, real NOLF tree/README draft, second-root Save and conflict preservation, GUI
close/relaunch retaining all session IDs/PIDs, draft recovery and explicit NOLF Stop while the
other sessions stay running. The NOLF working file was preserved. Both launcher regressions pass.
Inspected rendered evidence and recorded its hash in `docs/evidence/nolf-workspace.md`.

**Test corrections**: Selected the actual provider-named agent tab and root-specific README
buttons. Awaiting the page close event plus launcher exit handles CDP shutdown reply timing.
These failures did not require changing session or editor behavior.

**Next**: Image previews, native gameplay/input/DPI, Windows integration and remaining recovery,
packaging and performance qualification. No feature or goal completion claimed; all 15 gates
retain their unproven status. The existing Windows-host question remains pending.

---

## Session 8 (macos) — 2026-09-05 — Agent MCP bootstrap and actual CLI/download proof

**Goal turn classification**: progress. Native NOLF checkpoint committed as `a22d823`. Added
project-bound MCP tools and per-invocation agent overlays through the Bash launcher. The full
goal remains active; Windows, gameplay and other outstanding desktop requirements remain open.

**Implemented**: Official MCP SDK stdio bridge with project identity, bounded tree/text/session
tools, NOLF preflight/launch and explicit Stop. Every call retains its original root and sidecar
instance. Private context/config files live in sidecar state; existing user/project config and
CLI authentication remain in their normal scopes. Codex uses invocation overrides, Claude an
additional MCP config, OpenCode merged inline JSONC, Gemini preserved defaults plus the new
server, and custom executables receive a generic config path. Windows wrapper execution uses
Git Bash argv forwarding for native npm shims; actual Windows execution remains unverified.

**Verification**: All fifteen service/config/MCP tests pass, including the stale-instance rejection.
Actual Codex 0.153.4 launched in the
NOLF workspace and `/mcp verbose` showed rEngine connected with all eight tools (pass, about
5.8 seconds; screenshot inspected). Automated fast typing initially left the command unsubmitted;
after waiting for startup and using human-paced keys it executed. The PTY input trace records
Enter as carriage return. A real isolated managed install of 0.153.3 and update to 0.153.4 both
verified their resulting executable versions; managed launch selected that installation.

**Limits/next**: Existing Capture MCP handshake failure is separate KI-017. Other agent runtimes,
Windows, the combined launch command, image previews, full game/aiming/DPI/performance and crash
recovery remain to verify or implement. The Windows-host question remains pending; independent
work continues. No feature or goal completion is claimed. Evidence details are in
`docs/evidence/agent-bootstrap-macos-2026-09-05.md`.

---

## Session 7 (macos) — 2026-09-05 — Live NOLF game pane and native input

**Goal turn classification**: progress. Implemented the native SDL2/OpenGL surface, bounded
authenticated frame/input transport, NOLF preflight/launch, canvas presentation and game-session
reattachment. Desktop checkpoint committed as `c09d2a8`. The complete goal remains active.

**Verified**: Actual existing NOLF build renders its menu live in the desktop. Enter opens Single
player through the native input path; a pixel-region assertion and inspected screenshot corroborate
the transition. Moving and closing the tab, restarting the GUI and reattaching retain the same PID;
explicit Stop reaches exited state. The expanded NOLF test passes in about 10.3 seconds. A separate
real SDL/GL fixture verifies key-down/release, pixel orientation and preservation of pixel-pack
state (pass, about 13.4 seconds). Thirteen service/protocol tests pass. Detailed host/executable
hashes and local artifact hashes are in `docs/evidence/nolf-surface-macos-2026-09-05.md`.

**Failures resolved**: The SDK does not ship dyld's private interpose header; the adapter now
declares the documented two-pointer Mach-O section directly. The first NOLF test's polling code
forgot to await a browser attribute, producing NaN; corrected and reran after the prior run ended.
No NOLF source/assets were edited; pre-existing host worktree status was preserved.

**Remaining**: Full gameplay/relative aiming/DPI/performance, image previews, installed-agent/MCP
proof, forced-crash recovery and Windows qualification. The Windows cooperative API source exists;
host integration is unverified. Asked which Windows host is available while continuing
independent agent work. No blocker or completion state is claimed; feature gates stay false.

---

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
