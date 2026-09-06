# Native C desktop and independent web client

Date: 2026-09-05. Status: implementation authorized by owner decisions D26–D27.
This changes the implementation of F32–F38/F42/F54/F55, not their accepted behavior or completion
criteria. All existing feature gates remain open until their complete criteria are verified.

The desktop GUI is C using pinned upstream microui. No Electron, Chromium application shell,
React or browser renderer is required to build or run it. SDL2 supplies the cross-platform window,
input, clipboard and rendering boundary. Keep pristine upstream libraries and licenses intact;
the owned-source line limit does not require rewriting a vendored library.

## Component boundaries

- microui controls and a native split/tab model arrange trees, editors, previews, terminals and
  game surfaces. A tab keeps its root/file/session identity when moved, resized or detached.
- A curated C terminal emulator processes the actual PTY byte stream, alternate screen, color,
  cursor movement and control keys. Rendering terminal output as plain log text is insufficient.
- A C text buffer/editor supports UTF-8, selection, undo, explicit Save, retained recovery drafts,
  external conflicts and a documented optional Vim subset. Preserve LF/CRLF/BOM service contracts.
- Live game frames become native textures. Native relative mouse capture, focus loss and Escape
  release controls. Logical input coordinates and drawable dimensions must be explicitly mapped.
- The service owns processes, filesystem operations and durable state. The GUI owns views. GUI
  exit detaches; Stop is an explicit operation. Preserve authenticated, root-bound service seams
  usable by a later web client. The current Node service's replacement timing is pending owner
  clarification; it is not linked into the C GUI or either game.
- The independent agent Bash launcher and MCP integration recipes retain their existing role.
  Agent-selected runtimes do not become dependencies of the engine library base.

## Migration sequence and acceptance

1. Build and launch a real C/microui window with no Electron dependency. Pin source provenance and
   licenses. Switch the default launcher to the native executable; retire browser-only packaging.
2. Connect real roots, retained sessions and file operations. Verify split/resize/tab movement and
   root isolation, editor Save/conflict/draft recovery, actual shell and installed CLI rendering.
3. Render actual NOLF frames and exercise game input, tab moves, restart/reattach and explicit Stop.
   Preserve the host checkout and local game assets. Fixtures supplement actual consumer evidence.
4. Repeat native Windows verification and the declared performance/recovery gates. The pending
   Windows source-transfer rejection remains in force until that destination is authorized.

Browser/CDP tests and screenshots remain historical prototype evidence only. New checks must
exercise SDL events and native rendered output, real service operations and actual process identity.
Do not describe a native window alone as the completed orchestrator. Capture baseline idle/active
resource use, then qualify the previously declared budgets rather than assuming C guarantees them.

## Current checkpoint and limits

An event-driven microui host must settle container hover after crossing between roots. Queue one
additional frame when upstream's next hover root differs; an idle interval must not make the first
click on a project textbox or another pane ineffective. Do not require a continuous redraw loop.

The C executable builds and renders on macOS. Real file/tree/PTY checks pass, including Unicode
codepoint editing, explicit Save, external conflict, Discard, moving a dirty editor between panes
and same-process/draft recovery after GUI restart. The SDL fixture proves live textures, native
relative capture and first-Escape release/second-Escape delivery. Actual NOLF main-menu to Single
Player input, same-process restart and explicit Stop pass in an isolated game runtime directory.
The normal npm launcher also passes the combined macOS workflow: installed Codex with eight
connected rEngine MCP tools, executed shell output, real NOLF source tree, two-root editing,
Save/conflict/Discard, dirty-tab movement, retained draft/process identities after GUI restart,
and game detach/reattach/Stop through the session browser. See the
[combined evidence](../evidence/native-workspace-macos-2026-09-05.md).

Owned UI/layout/editor/terminal/transport code is C11. Dependencies are pinned in
`third_party/sources.json` and `orchestrator/native/curl.cmake`; SDL2 is required at 2.32.10.
The executable has no Node or browser integration. The development launcher and retained process
service still require Node; GUI migration does not claim that service has been rewritten in C.

Current bounds: 15 leaf panes, 64 retained views, 2 MiB encoded text through the service, 2,048
cached glyphs, 128 queued transport messages and 16 MiB per transport queue, one latest game frame.
Two microui root containers per pane plus the toolbar fit upstream's fixed 32-root command limit.
The current Vim subset is h/j/k/l, 0/$, gg/G, i/a/o, x/dd, u, Ctrl-R and Escape. Conventional editing
adds selection, clipboard, Home/End, Page Up/Down and undo/redo. This is not full Vim compatibility.
Font glyph coverage depends on the selected trusted local monospace TTF/TTC (`RENGINE_FONT`).
Tab overflow navigation, header reordering and non-destructive pane merging are implemented in
[native pane navigation](057-native-pane-navigation.md). Strip offsets are ephemeral; stable tab
order, root/session bindings and the selected tab remain in the version-1 persisted layout.

Session-stream backpressure and reconnection to the same authenticated endpoint now pass native
macOS checks with fresh terminal snapshots and retained PIDs; see [spec 059](059-native-terminal-recovery.md).
A changed service identity/address still requires explicit launcher reconnection.

Primary-screen terminal history now supports pointer/keyboard scrolling with bounded storage;
see [spec 060](060-native-terminal-scrollback.md). New output preserves the viewed rows, and
native reload reconstructs available history from the same retained process. System-configured
wheel direction and visible native terminal/editor scrollbars are covered by [spec 061](061-pane-scroll-controls.md).
Agents can request the same native reload through root-bound MCP discovery and an explicit desktop
ID; [spec 062](062-agent-desktop-actions.md) separates acceptance from build completion. Existing
retained services/connectors require an explicit upgrade to load this action protocol.
Negotiated terminal mouse reporting now covers fullscreen app clicks, hover/drag and wheel,
including replay of the selected real Claude session; see [spec 063](063-terminal-mouse-reporting.md).
Snapshot reconstruction silences historical query replies; normal close/reload drains queued
input after releasing held mouse buttons, with a bounded visible cancellation on a busy stream.

Native image previews, terminal selection/copy, richer text navigation, service-restart recovery,
frame/input DPI mapping, actual in-level aiming, resource budgets, packaging and Windows runtime
proof remain open. No accepted feature is marked passing by this checkpoint. The historical web
prototype and its browser-specific tests were retired; version `916a204` retains that history.

References: [microui upstream](https://github.com/rxi/microui),
[libvterm upstream](https://www.leonerd.org.uk/code/libvterm/),
[SDL2](https://wiki.libsdl.org/SDL2/FrontPage).
