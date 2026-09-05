# rEngine IDE / orchestrator

Date: 2026-09-05. Status: **owner-requested product; detailed design under interview**.
Source: charter D10–D20. No application, agent installer, remote service or game adapter has been
implemented during harness setup.

Confirmed scope: macOS and Windows from the first desktop release; adapters first for game/tool
surfaces; tree, previews, basic editing with optional Vim mode, and terminals. Quest starts with
the same 2D workspace and a desktop sidecar, with spatial panes later. The initial macOS-only and
external-editor-only recommendations are superseded. External app presentation is being researched.
A workspace supports multiple project/worktree roots; terminals, editors, agents and games each
have an explicit root binding.

## User workflow

The owner currently uses Zed with terminal and file-view tabs. The desired workspace starts
empty and lets the owner construct the layout:

1. Split vertically into two panes and resize the left one.
2. Open a project tree on the left and a terminal tab on the right.
3. Launch a game and show its actual rendered output in a new tab.
4. Move the game tab into another pane while continuing to use terminal/tool tabs.
5. Add an agent tab. Initially this is a terminal running a Bash script that selects or installs
   a CLI coding agent and bootstraps its integrations, including custom MCP servers.
6. Add other tools as pane content and consider runtime inspection/control through integrations
   such as Meta XR Operator.

The layout is user-arranged. The first version includes a basic text editor with optional Vim
mode, alongside file previews. Define the supported editing/keybinding subset before implementing;
full language-server, debugger and plugin compatibility are not established requirements.

## Proposed layout model

A workspace contains a recursive split tree. Each leaf contains a tab group; a tab selects a
project view or a live session. The exact behavior of any outer workspace/project tabs remains
to be agreed. For example, after opening the requested tools:

```text
Workspace: reLith
┌──────────────────┬─────────────────────────────────────────┐
│ [Project tree]   │ [Terminal] [Agent]                       │
│                  │                                         │
│ src/             │ interactive CLI session                 │
│ tools/           ├─────────────────────────────────────────┤
│ docs/            │ [NOLF game] [Runtime tools]              │
│                  │                                         │
│                  │ live rendered game surface              │
└──────────────────┴─────────────────────────────────────────┘
```

This illustrates a possible user-created layout, not default panels or an implemented screen.

## Multiple roots and explicit association

Confirmed by D20: one workspace can contain reLith, reSource, iklib and separate worktrees of
the same repository. Every terminal, editor, agent and game session belongs to a selected root.
Creating a session shows its root; tab placement and the currently focused tree do not retarget
an existing session. A tree may show several roots, while opening a file binds its editor to the
owning root.

Proposed implementation rules derived from that requirement:

- Assign stable root IDs scoped to the owning desktop sidecar, distinct from repository identity,
  checkout revision and display labels. Two worktrees of one repository remain distinct roots.
- Store the launch root with each session; report its launch cwd separately from a shell's current
  cwd when available. A user may `cd` elsewhere without changing the recorded launch association.
  Root binding identifies context; it does not by itself sandbox terminal or agent access.
- Show the root alongside session/file labels where names collide. Commands, file saves, game
  input and MCP endpoints resolve through explicit root/session identities, never a global
  “active project” variable. Relative filenames alone cannot identify editor buffers.
- Removing a root from the workspace must not silently stop or retarget its retained sessions.
  Keep their association visible in the session browser. If its directory is missing, report that
  state and require an explicit resolution before new root-dependent operations. Relocation and
  path-alias reconciliation belong in the persistence design; do not guess replacement checkouts.
- Persist associations across GUI restart. Later Quest views refer to the desktop's root IDs;
  desktop paths are not translated into Quest-local paths.

Acceptance includes two roots with the same relative filename and two similarly named sessions:
editing, launching, moving tabs, reattaching and stopping one must affect only the selected root
and session. Exercise separate worktrees as well as unrelated repositories on both desktops.

## Separate layout, session and presentation

| Responsibility | Proposed owner | Required distinction |
| --- | --- | --- |
| Split, resize, tabs, focus, drag and placement | Workspace UI | Moving a view is not a new process launch. |
| Process/PTY identity, cwd, exit status and attached views | Session manager | A session belongs to an explicit root and target independently of view placement. |
| Terminal rendering, tree/file view, tool UI or game image/input | Surface provider | A tool must expose a supported presentation route; arbitrary native-window embedding is not assumed. |
| Agent detection, installation recipe, launch and integration setup | Agent launcher/adapters | CLI/provider-specific configuration remains outside pane layout code. |
| Build/launch parameters, game data and runtime tools | Project adapter | reLith/reSource keep their own targets and engine interfaces. |

Confirmed lifecycle: moving/resizing tabs preserves session, terminal buffer and game state.
Closing a tab or workspace window detaches views; the desktop sidecar continues to own live
sessions. An explicit Stop ends the selected session. Provide a session browser listing root,
type, target, state, attached views and exit information, with reopen/attach and stop controls.
The sidecar must therefore have a lifetime independent of the GUI. Restart after sidecar/OS
termination is distinct from view reattachment; never imply a dead process has been resumed.

## Game and tool surfaces

The requested game pane contains the running game's image and a defined interaction route.
Logs alone do not meet that requirement. Investigate both desktop platforms before selecting a
transport. Candidate approaches include a cooperative render/output adapter, a local or remote
frame stream with input routing, and capture of an external application window. They have not
been selected or shown equivalent.

A feasibility slice must prove actual pixels, resize behavior, input focus, aspect/DPI handling,
tab moves and process lifecycle using the selected method. Define latency/frame/resource targets
before acceptance. It should expose enough project/session identity to prevent controls from
being sent to a different running game.

Internal project views, web-based tools and native game surfaces may use different providers.
The common contract describes lifecycle, presentation and input capabilities rather than forcing
every tool to use the same renderer. Adapters are confirmed as the first integration path.
Unmodified apps are an additional investigation: a captured/controlled window and a reparented
native window are separate mechanisms with different compatibility. See the
[platform research](../research/quest-and-app-surfaces.md).

## Basic editor

The first IDE includes editable text files, previews, and optional Vim mode. Proposed minimum:
open/save, dirty-buffer indication, undo/redo, search, external-change handling and the declared
Vim keybinding subset. Preserve text encoding and line endings when supported; show an explicit
read-only/error state for unsupported files. Unsaved buffers need a deliberate close/recovery
policy independent of whether a terminal process keeps running.

Reuse a qualified editing component rather than implementing a general code editor from scratch.
Choose the component alongside terminal/rendering feasibility on macOS and Windows, with the
Quest 2D client in mind. Language servers, full debugger UI and extension ecosystems remain
separate possible capabilities. External-editor integration can remain optional.

## First agent tab

The owner selected a real terminal plus Bash launcher as the initial agent UI. Proposed flow:

1. Use the tab's explicitly bound root and launch directory and detect registered installed agents.
2. Offer installed agents, supported installation recipes, and an explicit custom CLI command.
3. For an installation selected by the user, show the official source, version, install location
   and required changes, then execute the recipe in the visible terminal.
4. Apply the chosen project's MCP/integration profile through that agent's adapter, preserving
   unrelated settings. Report configured, reachable, unsupported and failed distinctly.
5. Launch the CLI in the same interactive terminal and retain diagnostics for recovery.

“Any CLI coding agent” means an extensible launcher/custom-command path. Installation and
MCP setup require a recipe for the particular CLI/version; an unknown CLI's settings are not
guessed. The first supported recipes are still to be chosen. Windows is an initial target, so
the Bash environment and its interaction with native Windows or WSL agents/toolchains must be
specified and tested; do not silently require WSL or translate project paths heuristically.

The launcher should work outside the GUI as well. Ordinary long-lived terminal sessions are
not verification jobs and must not inherit a check runner's deadline. Agent output remains
visible and interactive; a custom chat protocol is not required for the initial agent tab.

## Meta XR Operator

The owner suggested this integration. [Upstream investigation](../research/meta-xr-operator.md)
establishes that a standalone native path exists; it does not establish compatibility with either
game or provide the pane's visual transport automatically.

Plan an optional runtime-control/inspection adapter bound to the specific game session. It must
report supported tools, connection state, runtime/profile and ownership of input. Use explicit
game-side tooling for native engine concepts that the OpenXR layer cannot identify. Flat-mode
game viewing and the whole orchestrator must remain usable without this optional integration.

## Quest client and desktop sidecar

The owner selected the shared 2D workspace first, with independently placed spatial panes later.
Initial [research](../research/quest-and-app-surfaces.md) supports both Android-panel and web/PWA
routes. Final packaging/toolkit choice awaits a working input/transport prototype.

The proposed desktop sidecar owns filesystem access, PTYs, agent installation/configuration,
build jobs and game sessions. The Quest client displays layout, structured file/terminal content
and game/tool imagery, and sends input over an explicitly paired connection. Keep the UI/session
protocol independent of local window handles so desktop and Quest views can attach to the same
declared session. Sharing the protocol does not guarantee every frontend uses identical UI code.

A first proof needs a real headset connected to both a Mac and a Windows sidecar, legible editor/
terminal text, tested keyboard and pointer/controller interactions, one live game surface,
reconnect behavior and measured latency/resource use. A native Quest VR game running alongside
the workspace is a separate scenario; the desktop-stream proof does not certify that coexistence.

## Independent product paths

The library base still follows the owner-confirmed first proof: one library in both games.
The owner selected the desktop orchestrator as the first implementation milestone, explicitly
including terminals and a flat game rendered into a new tab. Neither product must wait for the
other's entire roadmap. The first library proof still remains one library in both games.

## Acceptance scenario to refine

For the first useful desktop milestone on both macOS and Windows: add two project/worktree roots, create
the empty-to-split layout, use a real PTY, view/edit/save files with ordinary and optional Vim
controls, launch one flat game into a new live tab, and move/resize that tab without relaunching.
Close its view, find the still-running session in the browser, reattach, then explicitly stop it.
Close/reopen the GUI and recover the running session while the sidecar remains alive.
Use identical relative filenames and similarly named sessions across roots to verify that focus,
tab moves, file writes and explicit Stop preserve the intended association.

Flat NOLF is the recommended first game because the owner reports it working. This choice still
needs a pinned host/build target before implementation; the corresponding host adapter is a
separate owned change. A mock terminal, external game window, log tab or static image does not
complete the live-pane requirement. The second engine, agent installation/MCP setup and Quest
client follow their own integration gates; the owner has not yet ordered those later milestones.

Persist/restart behavior, installation coverage, Quest delivery and XR automation
are independently scoped gates. Failed installation, exited process and disconnected surface
must remain visible and recoverable without destroying another session.

## Next decisions

Settled: macOS/Windows desktop first, adapters first, basic editor with optional Vim, retained
sessions with a session browser, Quest 2D-first, and an initial desktop milestone with a real flat
game tab, plus multiple project/worktree roots with explicit per-session binding. Keep those
decisions when refining the implementation specs.

Before the first implementation:

- Confirm the concrete flat game/host baseline and the bounded prototype's performance budgets.
- Specify root identity/persistence details and the basic editor/Vim subset plus unsaved-buffer recovery.
- Qualify a terminal/editor/layout stack with an actual game surface on both platforms; choose
  dependencies using the same curation principles as the library base.

Before later capabilities:

- Select the first CLI agent recipes, Windows Bash environment and configuration scope.
- Refine Quest packaging/pairing and which game/flat-or-VR targets it controls.
- Specify handoff between human input and agent runtime control of the same session.
- Choose the next milestone after desktop v0: library proof, agent setup or Quest client.
