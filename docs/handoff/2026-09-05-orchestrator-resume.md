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
a process. Reload does not hot-replace service code; a service restart requires explicit session
management, followed by another launch of the same handoff to resume the conversation.

## Goal and current checkpoint

Continue the existing goal: launch the orchestrator on NOLF with a working game tab, project
tree, basic editor, terminal and agent launcher supporting explicit detection/install/update/
launch and integrations. Do not create a duplicate goal. The scheduler's pause/resume state is
controlled by the calling application; the repository mechanism resumes the CLI conversation
and supplies this checkpoint, not a scheduler migration. If it remains paused, continue the
user-authorized work as the resumed CLI turn and leave scheduler controls with the user.

All 15 feature gates remain false. `features.json` criteria have not changed. Read the newest
`Codex-progress.md` entry, `known-issues.md`, specs 055–060 and architecture before choosing the
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

Start with KI-024. Actual NOLF streams while moved into a narrow pane and back. However the
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
