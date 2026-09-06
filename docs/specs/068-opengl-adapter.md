# OpenGL adapter behind the draw list (F57)

Date: 2026-09-06. Status: owner-directed start after a `/grill-me` interview; macOS gates passed on
2026-09-06 and the macOS default became OpenGL; F57 stays unpassed until Windows has evidence. Parent: [GPU rendering](066-gpu-rendering.md),
[draw-list contract](067-draw-list-contract.md), charter D29–D30.

## Decisions from the interview

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | OpenGL 3.3 core profile with GLSL 330 on macOS and Windows; no 4.1 path. | Recommended, owner confirmed |
| 2 | Once the adapter passes its macOS gates, OpenGL becomes the default backend on macOS. Windows keeps the SDL default until Windows evidence exists. | Owner decided (against the recommendation to keep SDL default until F60); Windows part derived from decision 3 and the two-desktop rule |
| 3 | Windows evidence is deferred while KI-014 blocks the source transfer; the adapter is written portably and F57 records the gap explicitly. | Recommended, owner confirmed |
| 4 | Function loading uses vendored, pinned glad (header-only, MIT) with `SDL_GL_GetProcAddress` as its loader; no platform GL library is linked. | Owner decided (against the recommendation of an owned loader) |
| 5 | “Matches the reference” means per-scene tolerances set before the run: current-UI scenes at most 0.1% differing pixels and no channel differing by more than 2; new-primitive scenes at most 2% differing pixels, all within a 2px band of an edge, with no per-channel limit inside that band. A standard-library comparer records the numbers. | Recommended, owner confirmed. Revised after the first measurement: the original 64-per-channel limit for new primitives was dropped because anti-aliased edge pixels legitimately differ by the shape's full contrast (measured 139); the fraction and band limits bound the spread. Recommended, owner confirmed. |
| 6 | Budgets are relative to a measured SDL baseline on the same machine plus ceilings: OpenGL median CPU frame time at or below SDL's per scene, at most 8 ms median on the terminal scene, at most 32 MiB extra resident memory, glyph atlas at most 2048². | Recommended, owner confirmed |
| 7 | New primitives are anti-aliased signed-distance shapes with a 1px feathered edge and analytic shadow falloff. | Recommended, owner confirmed |
| 8 | If the selected or default backend cannot initialise (context, 3.3 core, glad, shaders), the desktop exits non-zero with the reason. `--renderer sdl` remains the explicit way to run the reference adapter. No silent fallback. | Owner decided (against the recommendation of a fallback with a notice) |

Codebase-derived choices: shader sources are C string constants in the adapter (no runtime file
loads); the glyph atlas is an 8-bit coverage texture packed on shelves with nearest sampling and
integer drawable placement reproducing the reference expressions; blending is
`SRC_ALPHA, ONE_MINUS_SRC_ALPHA` like the SDL reference; snapshots read the framebuffer with
`glReadPixels` into an SDL surface saved as BMP; selection is `--renderer opengl|sdl` or
`RENGINE_RENDERER`; the smoke line and automation `state` report `backend=`; per-primitive scenes
come from an automation `scene` op drawn by `re_app_draw`; HiDPI uses the drawable size with a
projection scaled by density.

## Adapter

`render/backend_gl.c` implements `ReBackendOps`:

- `re_draw_window_flags("opengl")` sets the context attributes (core profile 3.3, double buffer,
  no depth or stencil) before the window exists and returns `SDL_WINDOW_OPENGL`; `re_draw_open`
  creates the context, loads glad, checks the version, compiles the programs, and returns NULL
  with the reason on any failure.
- One dynamic vertex buffer per frame; vertices carry position, texture coordinates, colour and
  shape parameters (rect centre and half size in drawable pixels, corner radius, mode, width).
  Batches break only on clip or texture changes, so a full terminal frame is a few dozen draws.
- One program with modes: solid, signed-distance shape (fill, ring, shadow), coverage texture
  (glyphs, icons), RGBA texture (game frames, flipped by UV). Clip uses `glScissor` in drawable
  pixels.
- Rounded shapes use a per-corner radius selected from the corner mask; rings are the band
  between the outer and inset distances; shadows scale alpha by a smooth falloff over `width`.
- Glyphs are rasterised once by `render/font.c` at the drawable density and packed into the atlas;
  a density change clears it. The atlas is capped at 2048×2048; when it fills, the batch is flushed and the
  atlas repacked from scratch rather than grown.

## Verification

- Byte-level comparison of `--renderer sdl` and `--renderer opengl` snapshots for the default
  workspace, the primitives scene and a live terminal scene, with `tools/render_compare.py`
  applying the decision 5 tolerances and writing numbers to the evidence file.
- Budgets per decision 6, measured through the automation `stats` op (median CPU frame time
  over the last frames) and resident memory of the desktop process.
- CTest and the native desktop suite pass on `--renderer opengl`; the SDL path stays
  byte-identical to its F56 baseline.
- Results on macOS: workspace and terminal scenes differ in zero pixels; the primitives scene
  differs in 0.80% of pixels, all inside the edge band; OpenGL medians 0.297, 0.411 and 0.491 ms
  against SDL 0.663, 1.990 and 1.413 ms; resident memory +20.3 MiB; the eight committed native
  specs pass on OpenGL. `orchestrator/tests/native-render.spec.mjs` is part of `npm run test:desktop`.
- Evidence: `docs/evidence/opengl-adapter-macos-2026-09-06.md`. Windows: not run (KI-014).

## Deferred

Amendment 2026-09-06 (owner decision during F59, spec 073): the decision 6 resident-memory ceiling is
64 MiB above the SDL reference for Vulkan on Windows, where the NVIDIA driver's process baseline sits
about 30 MiB above OpenGL's before the adapter draws anything; every other backend and platform keeps
32 MiB. Metal (F58) and Vulkan (F59) reuse the batching and atlas design through the same ops table. The
default flip on Windows waits for its evidence. Subpixel or gamma-aware text is not part of this
feature.
