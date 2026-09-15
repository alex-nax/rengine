# Spec 136 — the declared mark on the operating system's tile

Owner request, 2026-09-15: "Can we also make configured icon (even if it is a placeholder) appear
in macos doc panel?"

## Why this is not already true

Spec 104 gave a project a brand mark and the chrome wears it: the toolbar's mark chip rasterises
the declared SVG, and the window title wears the declared name (spec 084 decision 4). Both are
*inside* the window. The Dock tile is outside it, and it is the thing a person looks at when the
window is behind something else — with several workspaces open on one machine, every one of them
shows the same generic tile.

`SDL_SetWindowIcon` is the obvious answer and the wrong one. On macOS it sets the window's icon
and leaves the Dock tile alone; the tile is `NSApplication`'s `applicationIconImage`. So this is a
platform seam, not an SDL call.

## Decisions

1. **The tile is the declared mark, rasterised.** Not a second asset to declare, and not a bundle
   resource: the same `icon.image` spec 104 already resolves to an absolute file. A project that
   declares only a glyph gets no tile — the glyph is a chrome affordance whose contrast is a
   property of the theme, and there is no theme behind a Dock tile.
2. **It follows the window title's rule, for the title's reason.** The declaration arrives after
   the window exists, so the tile is set when the mark becomes known and only when it *changes*.
   Rasterising an SVG every frame to hand the platform a tile it already holds would be a
   per-frame allocation for no pixels. A file that cannot be read is remembered as attempted, so
   an unreadable declaration is not retried sixty times a second.
3. **`RE_DOCK_ICON_EDGE` is 512 device pixels, on the LONG edge.** `re_svg_rasterize` fits artwork
   uniformly and returns the fitted size, so a mark that is not square keeps its aspect and the
   tile is not stretched. The `NSImage` is sized in *points* at half that, and the representation
   keeps its pixels — the Dock draws at a point size and picks the representation.
4. **Straight alpha, declared as such.** `re_svg_rasterize` returns straight-alpha RGBA, so the
   bitmap is `NSBitmapFormatAlphaNonpremultiplied`. Declaring premultiplied would darken every
   edge pixel against its own transparency, which reads as a dirty halo rather than as a wrong
   flag.
5. **One Objective-C file, on Apple only.** The build already enables `OBJC` for the Metal seam and
   compiles it without ARC; this follows both, so the two retain/release rules in this build are
   one rule. Every other platform compiles the stub beside it, which reports **no** tile rather
   than claiming one — a stub that returned success would make the read-back agree with a call
   that did nothing.
6. **The check asks the OPERATING SYSTEM, not the call.** `re_dock_icon_size` reads back
   `[[NSApp applicationIconImage] representations]` and reports the representation's pixels. This
   is spec 084 decision 4's rule applied one layer out: hold the chrome and the platform to one
   source instead of assuming they agree. The pixels, not the point size, because the point size
   is what the caller asked to draw at and two different bitmaps can share it.

## Acceptance

`orchestrator/tests/native-identity.spec.mjs`, beside the artwork tests that already drive this
declaration, skipped off macOS:

- A root declaring `icon.image` wears a tile whose long edge is 512 pixels and whose aspect is the
  artwork's own (the fixture mark is 17.335 x 17.5537, so 506 x 512).
- A root declaring only a glyph does **not**: the tile stays whatever the process defaulted to.
  Verified non-vacuous — that default is a real 256 x 256, so the two assertions separate two
  real values rather than a value from nothing.

Sabotage: removing `setApplicationIconImage:` leaves the declared root reporting the 256 x 256
default, red at "the platform took the tile", with the glyph test still green.

## What this does not do

- **Windows and Linux.** They carry a window icon rather than a Dock tile, which is
  `SDL_SetWindowIcon`'s job and a separate decision. The stub reports nothing there; nothing is
  claimed about those platforms.
- **An application bundle.** The tile is set at runtime by the running process. A `.app` with an
  `.icns` is how a shipped build would carry a default before any project is known, and is not
  decided here.
- **The wordmark.** Only `icon.image` becomes a tile; a wordmark is a horizontal lockup and a Dock
  tile is a square.
