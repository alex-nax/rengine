# Mouse input for fullscreen terminal applications

Date: 2026-09-06. The owner reports that the current Claude `/rc` session cannot click items
or scroll. This is a bounded F36 compatibility repair; accepted feature gates stay unchanged.

The selected live Claude PTY requests alternate screen 1049, tracking modes 1000/1002/1003 and
SGR encoding 1006. rEngine currently never forwards mouse clicks and discards alternate-screen
wheel events. [Claude's fullscreen documentation](https://code.claude.com/docs/en/fullscreen#mouse-wheel-scrolling)
requires terminal mouse reporting for its scrolling and clickable UI. `/rc` itself is the
[Remote Control command](https://code.claude.com/docs/en/remote-control); no remote-service
changes or new provider conversation are needed for this terminal repair.

Use pinned libvterm's negotiated mouse mode and encoding, not Claude-specific event strings.
Forward buttons, requested hover/drag motion and signed precise wheel steps when the running
application requests them. Translate SDL logical window coordinates into the displayed terminal
cells, excluding chrome/gutters. Preserve modifier bits supported by the terminal protocol.
Honor mouse tracking on both primary and alternate screens. Ordinary shells retain native
history navigation; clicks on old history or native scrollbars must not activate live TUI items.
Shift+wheel may browse primary history locally; the alternate application owns its own history.

Pointer routing must follow the hovered terminal without changing keyboard/session bindings.
Releases for a button held inside a terminal remain bound to it across pointer exit, focus loss
and detach, with clamped cell coordinates. No unheld off-pane events, offline-input replay or
duplicate process launch. Reattachment must reset local mouse state before replaying the retained
stream. Keep pristine upstream sources; broader terminal clipboard/hyperlink/keyboard protocols
remain independently scoped.

First establish a failing real PTY/native pointer regression. Verify clickable item state and
wheel-owned viewport changes, precise system direction, negotiated motion/encoding, both screen
modes, coordinates after resize/pane movement, balanced releases, focus isolation and unchanged
process identities. Replay the selected Claude stream privately to qualify its actual escape
sequences without sending another prompt. Record Mac evidence and distinguish it from Windows
and any live Claude interaction not actually performed.

Replay and detach qualification exposed two related input bugs. Suppress responses while restoring
a historical snapshot, while still answering live cursor/device queries. Rebuild the emulator for
a fresh snapshot to clear old mouse encoding/state. Queue held-button releases before normal GUI
close/reload, then wait for queued/in-flight stream output to be handed to the transport. Cancel
the close/reload visibly if that drain exceeds two seconds; disconnected input remains discarded.
Transport drain is not an application acknowledgement and cannot guarantee delivery after a loss.
