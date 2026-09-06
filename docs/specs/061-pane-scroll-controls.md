# System scrolling and visible pane controls

Date: 2026-09-06. The owner requests system-configured trackpad direction and scrollbars on
scrollable panes. This refines spec 060 under the active desktop scope; accepted gates are unchanged.

Use SDL's delivered signed, precise wheel deltas for workspace scrolling. Do not negate them
again for `SDL_MOUSEWHEEL_FLIPPED`: on macOS that flag describes the system's inversion already
applied to the Cocoa delta. Preserve fractional movement for terminals, editors and microui lists.
No global setting or app-specific direction override is needed.

Terminals have a vertical scrollbar for primary history, from oldest at top to live at bottom.
Editors have vertical and horizontal bars when content exceeds the viewport. Tree/session views
retain upstream microui overflow bars. Custom bars show position and visible fraction, support
thumb dragging and track paging, and clamp to valid ranges on resize/content changes. Scrollbar input
must not become terminal input or editor selection; dragging outside the pane releases cleanly.
Wheel input addresses the hovered scrollable view without retargeting keyboard focus or bindings.
Keep non-scrollable/game panes free of history controls and upstream sources pristine.

Before changing behavior, establish the failing direction regression. Verify the added bars with
actual native pointer actions, fractional/flipped deltas, editor navigation without edits, both axes,
overflow lists, terminal history/live endpoints, no-overflow behavior and existing session gates.
Record Mac runtime evidence separately from unverified Windows behavior.

Primary implementation references: [SDL 2.32.10 Cocoa wheel delivery](https://github.com/libsdl-org/SDL/blob/release-2.32.10/src/video/cocoa/SDL_cocoamouse.m#L471),
[SDL event construction](https://github.com/libsdl-org/SDL/blob/release-2.32.10/src/events/SDL_mouse.c#L798).
Those sources preserve signed deltas and carry inversion as metadata; the prior terminal
negation undid the owner's system preference. This records the rationale for correcting the
previous flipped-event expectation, without changing any accepted feature criterion.
