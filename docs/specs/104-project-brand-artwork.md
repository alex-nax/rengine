# A project's brand is its own artwork, not a letter (F106)

Date: 2026-09-07. Status: recorded from owner direction, given directly in the hirebase-v2 workspace:

> "Can we also make that our window title is Kohai instead of 'Hirebase' and the logo is like on site,
> maybe we can use the svg instead of title too"

and, when told the chrome can only draw a letter:

> "svg rasterizer is a good addition to redit editor"

Parent: [spec 084](084-project-identity.md), which gave a project its own name and mark. This finishes
the half that could not be drawn.

## The situation it answers

Spec 084 let a project replace the chrome's default word and letter chip: `title` becomes the window
title and the bar's text, `icon` is one or two characters on a design-token colour. That was the
right first step and it is not what a brand is. `toolbar_brand` draws the chip with `re_draw_rrect`
and then draws the glyph with `re_draw_text_face` — the mark is **text**, so a project whose mark is
a shape has no way to say so, and the owner's project had to wear `Hi` on a blue square while the
product it builds wears a red gate.

The renderer was never the obstacle. `re_draw_texture_create` / `re_draw_texture_update` /
`re_draw_texture` have been public in `draw.h` since the backend split, and every backend implements
them. What was missing is anything that turns artwork into pixels: rEngine vendors a font rasteriser
and a JPEG *encoder*, and no decoder for the vector format every brand asset actually ships as.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | The chrome accepts **SVG**, not a raster format. A brand mark is authored as vector art, the bar's size varies with theme and DPI, and pinning a PNG would bake one size into the declaration and blur on every other. | Owner ("svg rasterizer is a good addition") |
| 2 | Rasterising is a **vendored library, wrapped thinly** — `third_party/nanosvg` (zlib) behind `orchestrator/native/svg.{c,h}`, exactly as `jpeg.c` wraps pinned stb. Writing a path rasteriser would be rEngine's own work in a solved problem, and the Kohai wordmark alone needs cubic béziers. | Recommended |
| 3 | The mark and the wordmark are **two slots, not one lockup**. The bar already draws a square chip and then a title; a project replaces either, both or neither. A single fused image would lose the chip when the bar is narrow, and the assets are authored split — the site itself composes two elements. | Recommended |
| 4 | An image icon is **an alternative to the glyph, never an addition**: the declaration carries `glyph` or `image`, and declaring both is refused. Two marks with no rule about which wins is a defect waiting for a narrow window. | Recommended |
| 5 | The wordmark may name **one image per theme** (`{ light, dark }`), because a wordmark is ink and ink has to invert. A single string is accepted and used for both, which is the honest default for a mark that already contrasts on either ground. | Recommended; the Kohai wordmark ships as two files |
| 6 | Artwork is rasterised at the **device pixel size actually being drawn**, and re-rasterised when that size or the theme changes — not once at load. The chip is one metric today and a DPI change moves it; a texture cached at the wrong size is the blur decision 1 exists to avoid. | Recommended |
| 7 | A **failure degrades to the glyph**, and the default glyph when none is declared. A missing file, bad XML or an oversized document is a mistake in someone's declaration, and a chrome that renders nothing is a worse answer than a chrome that renders a letter. The workspace reports the problem the way every other declaration problem is reported. | Recommended |
| 8 | The **window title stays text**. `SDL_SetWindowTitle` takes a string, so the owner's "svg instead of title" reaches the in-app chrome and cannot reach the OS title bar. `title` therefore stays required for identity even when a wordmark is declared. | Recommended; stated because the request asked for both |
| 9 | Paths are **declaration-relative and confined**, resolved and refused like every other project path — an external declaration outside the checkout (spec 085) resolves beside itself, not inside the root. | Recommended |
| 10 | Contract **7**, because a contract-6 workspace must not silently ignore artwork it cannot draw. | Recommended |

## What this does not do

It does not draw SVG anywhere but the brand slots — no icon theming, no document preview, no format
registry entry. It does not animate, and it ignores `<style>` blocks and CSS beyond what nanosvg
resolves, which is what the two Kohai assets need and no more. It does not fetch a remote image: a
declaration names a file that ships with the project, so the chrome never blocks on a network. It
does not replace the phosphor icon font, which is a font and correct as one.

## Verification

| Check | Establishes |
| --- | --- |
| `svg_test.c` | a document rasterises to the requested pixel size with the fill colour it declares; the Kohai mark's rectilinear path and the wordmark's cubics both land; a malformed document, a missing file and an oversized one each fail rather than return half a bitmap |
| `native-identity.spec.mjs` | the chrome reports artwork where a project declares it, the glyph where it declares one, and the glyph again when the declared file is missing — the decision-7 fallback observed, not assumed |
| `contracts.test.mjs` | `glyph` and `image` together are refused; artwork on contract 6 is refused; a wordmark accepts a string or a `{light,dark}` pair and refuses anything else; a path escaping the declaration is refused |
| `native-render.spec.mjs` | the rendered bar actually contains the mark's ink, so a texture that is created, cached and never drawn cannot pass |

Each observed failing for its own reason before the implementation existed, per the work protocol.

**Not verified here:** how the wordmark reads at the smallest supported bar height on a low-DPI
display. The metric is fixed today and both Kohai assets are legible at it; a project whose wordmark
is denser is a case this spec does not answer.
