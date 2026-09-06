# Continue inside rEngine

The owner requested a pause of the current development goal and the next session inside the
native orchestrator. This checkpoint authorizes continuation only after its agent pane is
presented and the root-bound rEngine MCP integration is available. The current chat must finish
before the same Codex conversation is resumed; do not compete for its writer lock.

From this checkout, run `npm run resume`. The local ignored manifest is
`.cache/handoff/current.json`; it targets this rEngine project's exact Codex conversation.
The local workspace uses `.cache/orchestrator-development`, keeping older sidecars separate.
CLI prerequisites are checked without installing/updating or replacing credentials. Missing
session metadata, wrong project, old service or failed login stops the handoff. An interactive
CLI trust/login/MCP error must be resolved visibly; never select `--last` as a substitute.

The CLI runs in the sidecar-owned PTY displayed by the native C/microui pane. Closing the window
detaches it. Cmd+Shift+R on macOS / Ctrl+Shift+R on Windows saves drafts/layout, rebuilds the
desktop and reattaches the same live agent without another prompt. Use Sessions → Stop to end
a process. Spec 065 adds agent-operated workspace/UI/MCP updates above the retained PTY host. Original
host and supervisor protocol replacement still requires explicit session management.

## Goal and current checkpoint

Continue the existing goal: launch the orchestrator on NOLF with a working game tab, project
tree, basic editor, terminal and agent launcher supporting explicit detection/install/update/
launch and integrations. Do not create a duplicate goal. The scheduler's pause/resume state is
controlled by the calling application; the repository mechanism resumes the CLI conversation
and supplies this checkpoint, not a scheduler migration. If it remains paused, continue the
user-authorized work as the resumed CLI turn and leave scheduler controls with the user.

Consult the current `features.json` for gate status; later renderer work has its own evidence. Read the newest
`Codex-progress.md` entry, `known-issues.md`, specs 055–063 and architecture before choosing the
next bounded fix. Check `RENGINE_ORCHESTRATOR_SESSION`, then the MCP workspace/session identity
for `/Users/alex/rengine`; its session must be the running root-bound agent. The environment
marker is context, not a security boundary. Confirm the MCP connection before continuing edits.

The current checkpoint includes native tab overflow arrows, reordering and pane merging, with
dirty drafts/order/selection/PIDs preserved across layout changes and GUI restart. Mac native
tests cover those behaviors. The handoff test uses an instrumented Codex executable in a real
PTY: no invocation before presentation, correct explicit resume/MCP arguments once, native
interaction, rebuild/reload, dirty draft recovery, repeated launch and the same process identity.
Installed real Codex 0.153.4 reports resume support and an authenticated ChatGPT login. Its local
session metadata matches this root. The real continuation crossed this boundary on 2026-09-06:
its orchestrator session environment and root-bound MCP workspace/session calls were verified.
The owner subsequently reported both terminals stuck. That GUI and agent exited; the same
conversation was resumed externally for the explicitly authorized terminal repair in spec 059.
The repair passes native burst/reconnection tests and replay of the ended CLI's actual ANSI
output. Exit the current writer before running `npm run resume` again. Broader NOLF work still
requires a verified orchestrator session; the external repair did not remove that boundary.

## Next investigation

The next real launch on 2026-09-06 again verified its running agent environment and root-bound
MCP. The owner then prioritized missing terminal scrolling; spec 060 implements bounded native
history. Cmd/Ctrl+Shift+R loads it while retaining this CLI. Wheel/trackpad and Shift+PageUp/
PageDown browse; Shift+End returns to live output. No new conversation is needed for that reload.

The owner then requested system trackpad direction, visible bars and agent-invoked reload. Specs
061–062 implement signed precise scrolling, terminal/editor bars and root-bound MCP list_desktops/
reload_desktop. Mac native checks pass, including an actual MCP-triggered rebuild with retained
CLI PID, one invocation and dirty draft. The original live service/connector still predate
desktopActions version 1 and were deliberately retained. Native reload loads the scrolling build;
loading service/MCP code requires separate explicit session management. A targeted shortcut attempt
was denied by macOS Accessibility, so this agent has not verified a live desktop reload from that
attempt. No OS permission settings, conversation or retained processes were replaced. See
`docs/evidence/native-scroll-controls-actions-macos-2026-09-06.md`.

The next owner report prioritized unclickable/unscrollable Claude fullscreen UI in the existing
`/rc` session. Spec 063 adds negotiated terminal mouse reporting, balanced releases and precise
cell mapping. Private replay of that Claude stream qualifies SGR click/wheel packets after
reattachment, without operating its live conversation or Remote Control connection. Historical
queries no longer fill the input queue during reconstruction; live queries still receive replies.
The tested native build loads with Cmd/Ctrl+Shift+R and retains the current sessions. Existing
service/MCP upgrade and OS shortcut-permission limits remain as recorded above.

The owner then requested layered updates. Spec 065 is implemented and passes real native/MCP
fixtures: prepared updates, rollback, dirty draft recovery, old-launcher adoption, concurrent
startup and retained CLI input/PIDs. The production supervisor was not installed at the last
2026-09-06 check. One native keyboard reload installs it; afterward use update_workspace or the
context-bound runtime/client.mjs fallback from this same CLI. Do not restart the original host
or conversation. This supersedes the routine service/connector upgrade limitation recorded above,
while preserving low-level migration and OS permission boundaries. Evidence:
`docs/evidence/layered-updates-macos-2026-09-06.md`.

The next owner request adds separate project windows, agent inspection and a durable integration
return channel (spec 069). The terminal action `orchestrator/actions/project-window.sh` adopted
the original host and opened NOLF on 2026-09-06 without a keyboard restart. The current same-agent
window is `4c55dec7-f1e5-4626-9286-01e8d37ef8f2`; its project root is NOLF and its agent remains
bound to rEngine. Use current list/status calls rather than assuming recorded PIDs remain live.
The original legacy GUI remains attached separately. The production supervisor is now installed;
this supersedes the prior one-time-bootstrap wait. Do not create another conversation or host.

Read `docs/runbooks/project-window-dogfooding.md`; use window inspection and the context-bound CLI
from the already loaded connector. One local NOLF-to-rEngine status report was delivered and read.
Reports are polled durable data, not provider input. Project skills now guide dogfooding, terminal
wizard authoring and selectively useful sidecar lookup; their evidence is recorded in specs
069–070 and `docs/evidence/sidecar-efficiency-2026-09-06.md`.

Spec 071 adds root-bound `open_script`/`show_session`. An all-layer update succeeded on the live
NOLF window, preserving the original coding agents. Its `workspace-status.sh` menu was opened
in a new retained terminal (`d102f6bd-61d7-4b6a-b14b-bf0bf28afc6a`) and is waiting for human input.
Do not duplicate or stop that flow incidentally. The actual NOLF-bound agent delivered report #2
requesting independent pane zoom; it was acknowledged and recorded as KI-036, not implemented.

Return to KI-024 for gameplay integration after these owner-prioritized capabilities. Actual NOLF streams while moved into a narrow pane and back. However the
latest combined test's `game-input.png` still shows the main menu after Enter; its automated
assertion checked frames rather than the Single Player title, so the green result is insufficient.
Evidence is local under `.cache/native-workspace-Mcoemj/`. `game-narrow.png` SHA-256 is
`6911e521621b77a273a8475937246bfd26840b7a578b41e5fe7031de88a2fd77`;
`game-input.png` SHA-256 is
`007b1f8b729cb90db4bc34a03bcf6d5f64e72a1d9827a45d39785985e91fb093`.

Suspected cause, not established: `native/game.c` forwards uncaptured mouse positions outside
the rendered image, including letterbox clicks/motion. This may clear menu selection. First add
a failing fixture/menu-state regression. Consider ignoring unheld motion/clicks outside the
image while allowing keyboard focus, and clamping the release of a button held inside it.
Preserve relative delta/capture semantics. The speculative regression and debug inspection
started before the owner's pause were withdrawn; no unimplemented test is left in the suite.

Later gaps remain previews, terminal selection/copy, editor/Vim breadth, service-restart/failure
recovery, gameplay aiming/DPI, packaging/resources and Windows proof. Basic Ctrl+Home editor
behavior also needs qualification; do not infer insertion position from retained-text checks.

## Boundaries carried forward

- GUI/game runtime: C/microui/SDL2; no Electron or embedded browser. The separate Node service
  remains until an explicit migration decision. A later web interface stays independent.
- Games/library/framework ownership remains independent. No sibling migration or feature pass
  follows from orchestrator work. Preserve dirty NOLF worktrees and use isolated game runtimes.
- Windows source transfer was rejected by automatic approval review: the private destination
  `alex-pc` / `pr0fe@192.168.31.217` came from donor configuration, without direct owner approval
  to send source there. That approval question remains unanswered. Do not export through another
  route or treat Windows support as destination authorization.
- The optional Node-service migration timing question remains unanswered. Capture MCP startup
  failure is separate; do not change global agent settings or credentials to fix it incidentally.
- Git origin `git@github.com:alex-nax/rengine.git` and pushing this project's work are authorized.
  No proactive subagents; no unrelated background loops, training or data export.
