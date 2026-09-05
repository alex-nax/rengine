# First desktop workspace: NOLF and retained sessions

Date: 2026-09-05. Status: **implementation authorized; F32 qualification remains incomplete**.
Owner decisions: [charter D13–D22](000-charter.md). Architecture: [orchestrator](002-orchestrator.md).
This defines the first useful release. The [active goal](055-nolf-workspace-goal.md) brings agent
onboarding into the workflow. Sidecar implementation has started; UI/game/platform proof remains.

## Confirmed result

On macOS and Windows, construct an initially empty workspace from splits and movable tab groups.
Use multiple project/worktree roots, a project tree, previews, a basic editor with optional Vim
mode and real terminals. Launch flat NOLF into a new interactive game tab. Move and detach views,
then recover the same live sessions through a session browser after restarting the GUI. Stop
sessions explicitly. Retain unsaved editor drafts locally; change working files on explicit Save.

VtMB follows as the second game adapter. Agent installation/MCP bootstrap, Quest 2D delivery,
spatial panels, external-app compatibility and XR Operator have separate roadmap gates.

## Acceptance workflow on each desktop

1. Start with an empty layout. Add a NOLF checkout and a second project/worktree root. Include
   the same relative text filename in both roots to expose incorrect file/session association.
2. Split horizontally and vertically, resize the panes, and open a tree, file tabs and two real
   terminal sessions. Each session exposes its root. Normal editing and the declared Vim subset
   both work. The terminal handles an interactive full-screen program, resize and control keys.
3. Edit both files to different unsaved contents. Close one editor view, then reopen its retained
   draft. Verify that both files on disk are unchanged. Save one explicitly and verify that only
   its intended file changed. Repeat with an external edit while a draft is retained.
4. Launch the pinned flat NOLF profile into a new tab through its host-owned adapter. Verify live
   game image and gameplay input. Move/resize the tab; the same process and game state survive.
   Changing tree focus to the other root cannot redirect game input or terminal commands.
5. Detach the game and terminal views. Find both sessions in the browser with root, type, target,
   state and view information. Reattach to the same sessions and retained terminal output.
6. Leave a dirty editor draft and live sessions, close the GUI, then reopen it. Restore layout,
   root bindings and the draft; reattach to the sidecar's existing processes without rerunning
   launch commands. Stop NOLF explicitly and verify the intended session exits while the other
   terminal remains usable.
7. Record actual image/input, file-state and process-identity evidence plus the measurements
   below. Run the host's applicable native gates. A static image, log tab or external game window
   cannot satisfy the game-tab criterion.

## Proposed draft and conflict semantics

The owner selected the user-facing policy; these mechanics implement it and remain design proposals:

- Draft identity includes its owning root and file/buffer identity. Keep drafts in local application
  state outside tracked project files. Retain the base disk version needed to detect external edits.
- Closing a view preserves its draft and a route to reopen it. Before orderly GUI exit, durably
  checkpoint unsaved contents. Checkpoint failure is visible and must not discard the only copy.
- A disk edit by a CLI agent or another editor does not replace the retained draft. Show the
  conflict and preserve both versions; overwriting the changed file requires an explicit choice.
- Explicit Save writes only the intended file and clears dirty state only after a successful write.
  Interrupted writes must preserve a recoverable previous or new version; select and test the
  platform-specific write strategy during implementation. Read-only/deleted files report failure.
- Explicit Discard removes the selected draft and uses the current disk version. Closing a tab
  alone is not Discard. An untitled buffer still belongs to a selected root and needs a Save path.
- After a crash, restore the last durable checkpoint and report its freshness. Checkpoint cadence
  and size limits need measurement; do not claim that every in-flight edit survives an OS failure.

## Failure and isolation cases

| Case | Required outcome |
| --- | --- |
| Same filenames/session labels in different worktrees | Saves, input, reattachment and Stop address the selected root/session. |
| Root removed from the layout or directory missing | Retained sessions keep their identity; missing paths are visible and never mapped to another checkout automatically. |
| Sidecar terminates or an old process ID is reused | Report lost/exited state; never present a replacement process as the original session. |
| Game crashes or its surface disconnects | Keep diagnostics/session state and other panes usable; reconnect and relaunch are distinct actions. |
| Editor disk conflict or draft-write failure | Preserve unsaved contents and show a recoverable state without silently saving or discarding. |
| Unknown/interrupted persistence format | Preserve available recovery material and report the unsupported/damaged state. |
| GUI restart with long-lived processes | Reattach without executing persisted commands again. |

## Qualification inputs still required

F32 cannot pass until these are recorded. The initial source inventory is a dated observation,
not the integration pin. A reported working NOLF baseline is not new two-platform verification.

| Input | Required record before the F33 feasibility run |
| --- | --- |
| NOLF source and assets | Reviewed host revision plus patch hash if needed, flat target/profile, local asset prerequisites and reproducible launch arguments. |
| Native commands | Current configure/build/launch commands and applicable regression gates for each OS, read from the owning repository. |
| Reference machines | macOS/Windows versions, CPU/GPU, display scale/refresh, driver/toolchain and the NOLF scene used for comparison. |
| Editor scope | Supported text encoding/line endings, preview types, file-size limits, exact initial Vim actions and keyboard shortcuts. |
| Session/persistence scope | Versioned root/session identity, path relocation behavior, draft checkpoint cadence and retained terminal-output limits. |
| Measurement limits | Numeric thresholds set before the experiment, with a fixed workload and repeatable measurement method. |

Measure terminal input-to-display and resize responsiveness; editor open/search/save/recovery time;
idle and active GUI/sidecar memory and CPU; NOLF frame pacing and input-to-display overhead relative
to the same scene running directly; and resource behavior when tabs are visible, hidden or detached.
Record sample counts and percentile definitions with the results. Prototype measurements guide the
component choice; any revised threshold needs a recorded rationale rather than a retroactive pass.

Qualify a small number of existing layout/editor/terminal components plus cooperative game output
on both platforms. Record source, version, license, supported interfaces and limits in F33's
decision. The later Quest client is a design constraint, not an untested desktop-release claim.

## Ownership and completion

rEngine owns F32/F33 and the workspace/session implementation. `nolf-improved` owns F43's native
adapter and host checks; `vtmb-vr` owns F44. Shared reLith changes require checks for affected games.
Preserve each game's independent build and runtime architecture; reverting an adapter/pin restores
the recorded direct-launch path without making either engine depend on the workspace GUI.

F48 closes the desktop release only when its prerequisites and the full workflow pass on both
desktops. Drafting this document does not complete F32, F43 or F48. The owner authorized the
desktop/agent scope through F55; the broader library/Quest/training proposal remains separate.
