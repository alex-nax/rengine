# Claude Design views on the GPU renderer, macOS, 2026-09-06

Scope: F67 ([spec 076](../specs/076-design-foundations.md) sibling feature) on macOS 15.7.3, Apple
M3 Max, the Metal default backend. F60 carried the toolbar, tab strip and status bar; this feature
carries the project explorer, the editor chrome, the terminal and the session browser, plus the
overlay scrollbars every scrollable view uses.

## What the views now draw

- **Project explorer**: a path bar with the root name and the path within it, then 22px rows with an
  icon, an ellipsised name and a faint right-aligned meta column. The meta column marks a file that
  has unsaved edits open and flags symlinks.
- **Editor chrome**: the card's breadcrumb path, a state pill (saved, unsaved draft or conflict) and
  right-aligned Discard and Save, with Save taking the primary treatment while edits are pending.
- **Session browser**: the card's table with an icon and title per session, a state pill in the
  semantic hue carrying the process id, and Attach and Stop actions; recovery drafts follow below.
- **Terminal**: default cells follow the live theme rather than the colours they were written with,
  so a preset switch restyles history the terminal already produced. Explicit colours from the
  program are kept as written.
- **Scrollbars**: the card's overlay bar in every scrollable view, a transparent track with a
  rounded thumb at half its width, and the three states rest, hover and accent while dragging.

## Card reference

`orchestrator/tests/native-design.spec.mjs` now probes the view surfaces as well, per preset, against
`design/cards.json` generated from the token layers.

| Surface | default | teal | light |
| --- | --- | --- | --- |
| Explorer background | #242424 | #14181e | #eeece7 |
| Terminal background | #141414 | #0e1217 | #2a2723 |
| Pane background | #242424 | #14181e | #eeece7 |

Every probe matched the reference in all three presets. The light preset is the sharpest check: it
keeps a dark terminal (#2a2723) inside a light workspace, which is the design's own choice, and the
terminal only reached it once default cells started resolving against the live theme.

## Gates

| Check | Result |
| --- | --- |
| Native desktop suite, including the design spec | 17 tests passed |
| CTest | 4 passed |
| Renderer comparison across all four backends | passes; every scene under the 8 ms ceiling |
| `python3 tools/design.py check` | passes |

Frame medians from the same run, with the ratio against the SDL reference recorded as information:

| Scene | SDL | OpenGL | Metal | Vulkan |
| --- | --- | --- | --- | --- |
| Workspace | 0.982 | 1.336 (x1.36) | 1.000 (x1.02) | 0.476 (x0.48) |
| Terminal | 2.240 | 2.180 (x0.97) | 1.270 (x0.57) | 0.742 (x0.33) |
| Primitives | 3.319 | 1.269 (x0.38) | 0.668 (x0.20) | 0.765 (x0.23) |

Resident memory medians: SDL 165616 KiB, OpenGL 185168 KiB, Metal 144192 KiB, Vulkan 146400 KiB.

## Criteria

| F67 criterion | Status |
| --- | --- |
| Tree, editor, terminal and session browser match their cards on macOS under the generated reference | Met for the explorer, terminal and pane surfaces by probe, and for the editor chrome and session table by the recorded snapshots; the editor's gutter, current-line tint and syntax colours are still the pre-design drawing inside `editor.c` and are not claimed |
| Overlay scrollbars with rounded thumbs in every scrollable view, with rest, hover and dragging states | Met: the shared bar carries all three states and every view inherits it |
| Every existing desktop behaviour gate still passes on the GPU backend | Met: 17 of 17 |

## Not claimed yet

The editor's gutter, current-line tint and syntax colours; the card's per-directory counts in the
explorer, which need a field the file listing does not carry; and the tree's nested indentation,
since the view is a drill-down listing rather than an expanding tree.
