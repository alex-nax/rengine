# Settings popover, and the explorer's nested mode (F68, F73)

Date: 2026-09-06. Status: recorded after a `/grill-me` interview. Parent:
[design foundations](076-design-foundations.md), [editor syntax](079-editor-syntax.md), charter D33–D34.
Owner: “Just toggle in settings section (we have not implemented that yet but need it) - Vim mode
toggle will also live there”.

The interview began on how the explorer should decide between a nested tree and drilling down. The
owner's answer moved the decision out of the code: a person chooses, in a settings surface the
desktop does not have yet. That reshapes two features, so both corrections are recorded here.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | The explorer's nested-versus-flat behaviour is an explicit setting, not an automatic threshold. This replaces the previous round's answer, which chose nesting under a node budget. | Owner, 2026-09-06 (accepted-criteria correction for F73) |
| 2 | Settings live in their own popover opened from the toolbar, not in the theme panel and not in a tab. | Owner, against the recommendation to grow F68's theme panel into a settings panel |
| 3 | F68's theme panel is dropped. The popover is the only appearance surface and theme files are imported and exported from it. | Owner, against both alternatives (accepted-criteria correction for F68) |
| 4 | The first pass carries five settings: Vim mode (leaving the toolbar), the explorer's mode, the syntax scheme, the theme preset and the accent hue. | Owner |
| 5 | One overlay layer at a time. Opening the popover closes any menu and the reverse; Escape or a click outside closes the top surface and focus returns to the control that opened it. | Recommended, owner confirmed; keeps the single-overlay rule of spec 066 true |
| 6 | All five settings persist as workspace preferences through the existing route, as Vim already does, so a second window and a restarted desktop agree. | Recommended, owner confirmed |
| 7 | Nested mode keeps a cap on loaded rows. Reaching it collapses the least-recently-expanded directory rather than refusing to expand. | Owner, against the recommendation to refuse past the cap |
| 8 | The collapse never takes an ancestor of the directory being opened or one on the selected path; if every candidate is protected, that one expansion is refused with a status line. | Recommended, owner confirmed |
| 9 | In nested mode a click on a directory row expands or collapses it, and a click on the caret glyph drills in and makes that directory the root, so today's behaviour stays reachable. | Recommended, owner confirmed |
| 10 | Expansion state lives on the tab for the session. It survives reloading a directory, closing and reopening a pane and a layered update, and is not written to the persisted layout. | Recommended, owner confirmed |
| 11 | The toolbar's theme button becomes the settings button; no toolbar width is added and the trailing-cell fixture keeps measuring the same right edge. | Recommended, owner confirmed |
| 12 | Theme files are imported and exported through a path field in the popover with Import and Export beside it, the same control the toolbar uses for project paths. | Recommended, owner confirmed |
| 13 | A project root's theme is still offered rather than applied, per charter D34; the offer moves from the panel to the popover. | Codebase-derived from D34 |

## Criteria corrections

- **F68** loses “the theme panel matches its card” and gains the settings popover with those five
  settings and the theme-file path field. Menus, the single overlay layer and the project-theme offer
  are unchanged. The theme panel's card is then realised as a popover rather than a panel, and the
  evidence records which parts of the card the popover carries.
- **F73** loses the node budget as its deciding rule and gains the setting. The cap survives as a
  safety limit with the collapse rule of decisions 7 and 8, and F73 now depends on F68, because the
  toggle needs the surface.

## Shape

- The popover is drawn by the control layer as the one overlay: a shadow, a rounded ground, sections
  with a heading each (Appearance, Editor, Project), and the existing controls — select, checkbox,
  slider, text field — rather than new widget kinds.
- The accent hue slider uses the draw-list gradient primitive (spec 076 decision 7), which is the
  only place a gradient appears.
- Settings changes apply immediately and are sent to the workspace preferences route; a rejected
  write leaves the control showing what the workspace actually holds rather than what was clicked.
- Nested rows reuse the row control's depth argument, so indentation comes from the design token
  already generated for it.

## Verification

- The design spec probes the popover: its shadow and ground against the card reference, the section
  headings present, and the accent slider's gradient producing more than one distinct colour along
  its track.
- A native spec drives the explorer in both modes: expanding a directory in place, collapsing it,
  the caret drilling in, the cap collapsing the oldest expansion, and a protected branch refusing
  instead. Expansion survives a reload of the same directory.
- Preferences round-trip: a setting changed in one window is visible to a second window opened on
  the same workspace.
- The committed desktop suite, the renderer comparison and the trailing-cell fixture keep passing.

## What shipped (F68, 2026-09-06)

The popover carries the five settings of decision 4 with the accent slider drawn by the new
gradient primitive, and Vim left the toolbar as decision 4 requires. The project cell and a right
press on a tab strip open menus on the same overlay layer, with the card's accent hover, its mono
keyboard hints and its separators; those hints name shortcuts the workspace now serves, so a menu
never advertises a key that does nothing. Escape closes the top surface, an outside press closes it
and continues to whatever it landed on, and focus returns to the control that opened it.

Two things grew beyond the popover. The gradient became command 10 of the draw-list contract, which
takes it to version 2: two stops, an axis, and the rrect's radius and corner mask, with the ramp
defined by `re_gradient_sample` in the header so every adapter steps through the same stops and the
cross-backend comparison treats it like any other primitive. The primitives scene draws it on both
axes so that comparison covers it.

Theme files resolve against a token graph the generator now emits per preset, with values left
unexpanded, so a file that sets a palette entry moves every semantic and view token that reads it.
That is the three-layer reach charter D34 asks for. A root's theme lives at `.rengine/theme.conf`,
is read only while the popover is open, and is applied only on a click, remembered per root.

## What shipped (F73, 2026-09-06)

The explorer's mode is the setting of decision 1 and nothing else changes it. In nested mode a
directory row expands in place at the card's indentation, the caret glyph drills in, and a branch
collapses whole. In flat mode the view drills down as it always has.

The cap is on loaded rows, because rows are what a person scrolls and what the desktop lays out.
Reaching it collapses the least-recently-expanded branch and says which one in the status line.
A branch is protected when the directory being opened sits under it, or when the selected file
does. The selection is the file being worked on rather than whichever folder was last toggled:
toggling a folder would otherwise clear the very protection decision 8 asks for. When every branch
is protected the expansion is refused, again in the status line, and nothing already open closes.

Expansion state lives on the tab, keyed by path, and survives a reload of the same directory.
Choosing the explorer in the toolbar is now that reload. Drilling in or moving up starts a new tree
and clears the expansions, because the paths beneath a different root mean something else.

## Corrections found while building this

Owned controls draw into the list while the interface is built, and that path never saw microui's
clip. Nothing bounded them, so a scrolled explorer painted its rows and its path bar over the tab
strip and the toolbar; the owner reported it against the live desktop. Every control now takes its
container's clip, a control that narrows its own intersects rather than replaces, and panels and
popovers clear it because they are drawn outside any container. The invariant is asserted in
`orchestrator/tests/native-scrollbars.spec.mjs`: scrolling a view may not change one pixel above it.

Three more, each found by the owner or by a gate rather than by reading:

- The popover is drawn above every pane but the pointer was still offered to the panes first, so a
  terminal running a program with mouse reporting claimed the press and the rows over it looked
  dead. An open overlay now owns the pointer over its own rectangle. The fixture matters: a plain
  shell does not claim the press, so the test only means something with mouse reporting on.
- A mark inside a small box was drawn at the text size. The check in a 14px checkbox came out
  cropped to a diagonal stroke that reads as a slash. Icons now take a size, and the assertion is
  that the mark keeps clear of the box's corners.
- The new expansion request sorted above `OP_BYTES`, which is the boundary the request path uses to
  decide that an operation belongs to a format view; it then read a format the explorer does not
  have. The enum now records that boundary in a comment, and `re_format_mode` tolerates no view.

## Deferred

Keyboard navigation of the popover beyond Escape, per-project setting overrides, and a settings
search. Theme files that reach outside the workspace state directory and a project root are out of
scope for the path field.

A theme file may also set metrics and font families, as the card shows, and those stay compiled in:
the generated header turns them into macros so layout arithmetic folds at build time. Such keys are
counted and named in the status line rather than dropped in silence. Making them live means moving
the layout metrics into the same runtime table as the colours, which is its own piece of work.
