# Native terminal scrollback

Date: 2026-09-06. The owner cannot scroll the running agent pane. This is the next bounded
F36 repair under the active NOLF workspace goal, ahead of KI-024. The resumed conversation's
orchestrator environment and root-bound MCP were verified; no duplicate session is required.

Keep primary-screen rows evicted by pinned libvterm in a per-view ring, capped at 2,000 rows
and 8 MiB of cell storage. Retain cell colors/attributes and wide characters. Capture rows
through upstream scrollback callbacks; do not turn the PTY into a plain text log. Resizing
returns recent rows through the matching pop callback. Old-width history is clipped/padded
at display width, not retrospectively reflowed. Drop oldest rows at the limits.

Mouse/trackpad vertical scrolling addresses the visible terminal beneath the pointer without
changing keyboard focus/root/session bindings. Respect precise fractional wheel motion and
system direction using delivered signed deltas; [spec 061](061-pane-scroll-controls.md) corrects
the original double inversion and adds draggable bars. Shift+PageUp/PageDown navigate by a viewport;
Shift+Home/End select oldest/live.
Unmodified keys retain their PTY semantics. A visible position indicator appears while browsing;
the live cursor is hidden there. New primary-screen output preserves the viewed rows until
they age out. Text or a key sent to the PTY returns to live output. Alternate-screen applications
keep their own screen; primary history must not absorb alternate-screen output or mask that UI.

Fresh attachment clears/rebuilds history from the service's retained raw output instead of
duplicating it, initially at live output. Desktop reload/reattachment preserves the same process.
The service currently retains at most 1,048,576 JavaScript string characters; older output and
the scroll position are not persisted by this change. Closing a view still detaches it.

Before implementation, add a native regression that emits real PTY output beyond one screen,
scrolls via SDL input and asserts older visible text. Qualify hover routing with a second pane,
continued output while browsing, keyboard return to live input, alternate-screen isolation,
width/height changes, limits and same-PID reconstruction after GUI restart. Inspect the rendered
history, and replay real Codex output without starting another conversation. Windows runtime
and terminal selection/copy remain separate gates. Use C/microui and existing pinned libvterm.
