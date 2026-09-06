# OpenGL adapter behind the draw list, macOS, 2026-09-06

Scope: F57 ([spec 068](../specs/068-opengl-adapter.md)) on macOS 15.7.3, Apple M3 Max, SDL 2.32.10,
OpenGL 3.3 core through SDL's context, 1280×800 logical / 2560×1600 drawable, tree at `ca44dd5` plus
the other session's uncommitted edits. Windows is not covered (KI-014); F57 stays unpassed.

## Comparisons against the SDL reference adapter

`orchestrator/tests/native-render.spec.mjs` captures each backend from its own server state, waits
for stable view text, and compares snapshots with `tools/render_compare.py` under the decision 5
tolerances: current-UI scenes at most 0.1% differing pixels and channel delta at most 2;
primitives at most 2% differing pixels, all within a 2px edge band.

| Scene | Differing pixels | Max channel Δ | Outside 2px band | SDL median ms | OpenGL median ms | Commands |
| --- | --- | --- | --- | --- | --- | --- |
| Default workspace (tree, shell prompt) | 0 of 4096000 (0.000%) | 0 | n/a | 0.663 | 0.297 | 3873 |
| Terminal with 40 coloured rows | 0 of 4096000 (0.000%) | 0 | n/a | 1.990 | 0.411 | 5278 |
| Primitives scene (all contract commands) | 32786 of 4096000 (0.800%) | 139 | 0 | 1.413 | 0.491 | 5319 |

Medians cover 40 event-driven frames per scene after a stats reset; frame time is list build plus
adapter execute with submission flushed (`SDL_RenderFlush`, `glFlush`), excluding present and
vsync. Resident memory: SDL 161568 KiB, OpenGL 182336 KiB, delta 20768 KiB against
the 32768 KiB limit.

## Other checks on the final build

| Check | Result |
| --- | --- |
| Committed native desktop suite on `RENGINE_RENDERER=opengl` (eight specs) | 8 passed, 50.7 s |
| `native-render.spec.mjs` | passed |
| CTest (layout, editor, terminal, draw list) | 4 passed |
| Default backend on macOS after the flip: smoke snapshot | reports `backend=opengl`, byte-identical to the explicit `--renderer opengl` snapshot |
| `--renderer sdl` smoke snapshot | byte-identical to the F56 baseline (`8d237fdf…`) |
| `--renderer nope` | exits 2 with the usage message; a failed context exits 1 with SDL's reason |
| `python3 tools/design.py check` (render-layering guard) | passes |

## Criteria

| F57 criterion | Status |
| --- | --- |
| Core-profile adapter with owned shaders and glyph/icon atlases; explicit selection with SDL fallback recorded in evidence | Met on macOS; per decision 8 the fallback is explicit (`--renderer sdl`) rather than automatic, and the smoke line and automation `state` record the backend |
| Per-primitive and whole-screen comparisons within tolerances recorded before the run, on both desktops | Met on macOS as tabulated; Windows open |
| Frame time and memory against budgets set beforehand; native desktop suite on the OpenGL backend | Met on macOS: OpenGL below the SDL median on every scene, terminal scene under 8 ms, memory delta under 32 MiB, suite 8 of 8 |
