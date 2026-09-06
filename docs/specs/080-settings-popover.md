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

## Deferred

Keyboard navigation of the popover beyond Escape, per-project setting overrides, and a settings
search. Theme files that reach outside the workspace state directory and a project root are out of
scope for the path field.
