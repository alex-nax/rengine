# Draw-list contract and SDL_Renderer reference adapter (F56)

Date: 2026-09-06. Status: started on owner direction (“start on the renderer contract, F56”)
while the inventory still lists F56 as blocked behind F34 and F42; it cannot pass until those do.
Parent: [GPU rendering](066-gpu-rendering.md), charter D29–D30, architecture constraint 15.

## Contract (version 1)

`orchestrator/native/render/draw_list.h` is the boundary. It includes only C standard headers.

- Coordinates are logical pixels in `ReRect {x, y, w, h}`; the list carries `width`, `height`,
  the drawable `density` (drawable pixels per logical pixel) and the frame's `clear` colour.
  Colours are `ReColor` RGBA8 with straight alpha, blended over the destination.
- Commands are consumed strictly in append order. `RE_CMD_CLIP` sets the absolute clip rectangle
  or, with `RE_CLIP_RESET`, removes it; there is no clip stack, matching the workspace's usage.
- Primitives: `RECT`, `RRECT` (radius plus a corner mask), `FRAME` (1px border and a 1px inner
  highlight line, optional radius), `SHADOW` (soft falloff of `width` pixels around a rounded
  rect), `RING` (`width`-pixel outline outside a rounded rect), `TEXT` (a run in face
  `RE_FACE_MONO` or `RE_FACE_UI` at a pixel `size`, positioned by the top-left of its line box),
  `ICON` (a glyph from the bundled icon set centred in a rect, tinted), and `TEXTURE` (a
  backend-owned RGBA8 image drawn into a rect, optionally flipped vertically).
- Text bytes are copied into the list's own arena, so callers may pass stack buffers. Every run
  is NUL-terminated in the arena; `re_draw_list_string` returns it.
- Limits default to 1,048,576 commands and 16 MiB of text per frame. Exceeding a limit or failing
  an allocation sets `overflow`, drops the command and returns false; the frame still renders what
  was accepted. `re_draw_list_limits` lowers the limits for tests.
- Textures come from the adapter (`texture_create`, `texture_update`, `texture_destroy`) and
  carry their owner, so a view can release one without a draw handle.

`render/backend.h` is the adapter interface: `density`, `begin` (logical size and clear),
`execute` (the whole list), `present`, `snapshot`, texture operations and `close`. Adapters read
`render/font.h` for face metrics and glyph bitmaps; `render/font.c` owns the trusted-local-font
policy, one required monospace face and an optional UI face from `RENGINE_UI_FONT` that aliases
the monospace face when absent.

## Glue and layering

- `draw.c` keeps the `re_draw_*` API the views already use. `re_draw_begin` resets the list,
  `re_draw_rect`, `re_draw_clip`, `re_draw_text` and `re_draw_texture` append, and the first of
  `re_draw_snapshot` or `re_draw_end` flushes the list through the adapter exactly once per frame.
  New wrappers expose rounded rects, frames, shadows, rings, icons and text faces to the owned
  control layer.
- microui commands are translated one to one; microui icons stay text runs centred with the theme
  metrics, so `RE_CMD_ICON` is reserved for the owned control layer. Pinned upstream microui is
  untouched.
- The game view creates and updates its frame texture through the contract and appends a
  `TEXTURE` command with `RE_DRAW_FLIP_Y`.
- Layering guard: `python3 tools/design.py check` fails when any file under
  `orchestrator/native` other than `render/backend_*.c` mentions SDL rendering symbols
  (`SDL_Render*`, `SDL_Texture*`, `SDL_FRect`, `SDL_FLIP*`, `SDL_Vertex`), OpenGL, Metal or Vulkan
  identifiers. Windowing, input and file helpers from SDL remain allowed above the list.

## Reference adapter

`render/backend_sdl.c` reproduces the previous immediate-mode drawing call for call: logical size,
clear, clip, filled rectangles, glyph textures rasterised at drawable density, and the game texture
copy with vertical flip. The new primitives use rectangle-only approximations documented for the
GPU comparisons: rounded fills are drawn as per-row spans, outlines as the staircase difference of
consecutive rows, shadows as `width` expanding layers of divided alpha, rings as stacked outlines,
and icons as the monospace glyph strings centred by font metrics. Anti-aliased quality is a GPU
adapter concern (F57).

## Verification

- Native smoke snapshots of the same tree before and after the change must be byte-identical.
- CTest gains `native_draw_list`: order and payload of appended commands, arena copying after the
  source buffer changes, clip reset, overflow at reduced limits, reset reuse, and a recording
  adapter that consumes the list through the ops table.
- The committed native desktop suite passes on the reference adapter; `check` passes with the
  layering guard; sidecars validate.
- Evidence: `docs/evidence/draw-list-macos-2026-09-06.md`.

## Deferred

Per-primitive snapshot tests, tolerance comparisons and the explicit `--renderer` switch arrive
with F57. The owned control layer and the UI face's real use arrive with F60. Windows evidence
waits on KI-014.
