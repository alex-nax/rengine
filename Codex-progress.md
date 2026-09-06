# Progress Log

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
