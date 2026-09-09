# Chat file links and native image tabs

Owner request, 2026-09-08, from the attached NOLF conversation: open the generated
PNG evidence in a new editor tab directly from chat and add image viewing. This
authorizes the bounded native portion of F37 despite its broader desktop-v0 and
Windows qualification dependencies remaining open. It does not complete F37.

## Contract

- Cmd-click (macOS) or Ctrl-click (Windows/Linux) a visible file reference in an
  agent/terminal pane to open or focus its root-bound editor tab. Plain absolute
  and root-relative paths, Markdown links, file URLs with percent escapes, and
  `:line[:column]` / `#Lline` suffixes are supported. Recognize paths from the
  displayed cells, including scrollback; clicking a Markdown label uses its target.
  Ordinary mouse input keeps its negotiated terminal behavior. The opening gesture
  consumes both press and release and never types a command into the agent.
- Resolve against the clicked terminal's recorded root, independent of project
  focus. Reject paths outside it, remote URLs and malformed escapes. Existing
  authenticated file/image endpoints enforce regular-file, traversal and symlink
  boundaries. Opening an existing buffer preserves unsaved edits. Source locations
  position the caret after loading; images ignore source locations.
- PNG/APNG, JPEG and GIF files open as read-only native image views, from either
  the explorer or a chat reference. Use the first frame for animated formats.
  SVG stays text; WebP receives an explicit unsupported-native-decoder message.
  The existing 8 MiB / 8192-per-axis / 16-megapixel bounds apply to decoding too.
  Use stb_image from the already pinned stb revision; no OS image viewer or browser.
- Show dimensions, fit/actual size and Refresh. Actual size means source pixels in
  logical editor coordinates; scrolling pans an oversized image. Transparency has
  a checkerboard. Refresh clears stale pixels, reports decode/read errors visibly,
  and can retry. Decode from bounded authenticated response bytes and upload through
  the existing backend-neutral texture API. Closing/reusing a tab or restarting the
  desktop must not leak textures or apply a late response to a different file.
- Persist root/path and fit mode with the tab. Keep editor drafts and the retained
  agent process alive across desktop updates. No source image writes occur.

Terminal OSC-8 hidden-label metadata is a separate terminal-emulation capability;
this slice makes the visible paths and Markdown references emitted in chat usable.
It does not promise links whose target never appears in the displayed text.

## Verification

### Wrapped references and hover correction, 2026-09-09

The owner's screenshot exposes an uncovered case: Codex renders a link as
`viewer screenshot (third_party/.../pv-` followed by `hands-viewer.png)` on the
next row, before the terminal's right edge. Treat newline padding/indentation
inside displayed parenthesized paths and Markdown targets as presentation wrapping.
Clicking either row must open the complete path. Retain ordinary hard line breaks
between unrelated references; preserve full-width terminal wrapping and scrollback.

Hovering a valid local reference shows the system hand cursor without requiring
Cmd/Ctrl first, plus the existing modifier-click hint. Opening still requires the
modifier. Moving to ordinary text, opening an overlay, leaving the window or losing
focus restores the default cursor. Refresh hover against the latest rendered cells
so an output/layout change cannot leave an obsolete pointer. Cursor resources belong
to the desktop lifetime. Add real native pointer regressions for the screenshot's
two rows, resize/scrollback, cursor entry/exit and root-invalid references; inspect
the actual SDL cursor selection, not only a desired hover flag.

Before code, run the new `native-file-images.spec.mjs` checks against the existing
binary and observe failures for image presentation and actual pointer activation.
Then verify real PNG pixels from screenshots, two roots with identical filenames,
fit/actual/refresh/error/retry, no writes, retained terminal PID, scrollback links,
location navigation, unrelated focus, and restart. Unit checks cover path decoding
and boundary cases. Deliberately disconnect link dispatch and texture drawing, run
their specific checks red, restore, then rerun the gates.

Commands: `./init.sh`, `python3 tools/design.py check`, `npm run build`,
`ctest --test-dir .cache/desktop --output-on-failure`, `npm test`, and
`npm run test:desktop`. Record scoped macOS evidence and inspected PNGs under
`docs/evidence/chat-file-images/`; Windows remains unverified. Upgrade NOLF's
pinned editor after the changed behavior passes its gates; report any inherited
failure with an unchanged-revision comparison, as required by the work protocol.
