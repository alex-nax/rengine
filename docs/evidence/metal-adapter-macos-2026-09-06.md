# Metal adapter behind the draw list, macOS, 2026-09-06

Scope: F58 ([spec 072](../specs/072-metal-adapter.md)) on macOS 15.7.3, Apple M3 Max, Xcode 16.3,
SDL 2.32.10 with `SDL_WINDOW_METAL` and SDL's Metal view, 1280×800 logical / 2560×1600 drawable,
tree at `b119a3e` plus this change. The gate is the SDL reference adapter, as for OpenGL
(spec 068 decisions 5 and 6); Metal-versus-OpenGL numbers are recorded as information.

## Comparisons against the SDL reference adapter

`orchestrator/tests/native-render.spec.mjs` captures each backend from its own server state with a
plain `bash --norc` shell and a fixed prompt, waits for stable view text, and compares snapshots
with `tools/render_compare.py` under the spec 068 tolerances: current-UI scenes at most 0.1%
differing pixels and channel delta at most 2; primitives at most 2% differing pixels, all within a
2px edge band.

| Scene | Metal vs SDL differing pixels | Max channel Δ | Outside 2px band | SDL median ms | OpenGL median ms | Metal median ms | Commands |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Default workspace (tree, shell prompt) | 0 of 4096000 (0.000%) | 0 | n/a | 0.852 | 0.311 | 0.408 | 4028 |
| Terminal with 40 coloured rows | 0 of 4096000 (0.000%) | 0 | n/a | 2.064 | 0.915 | 0.766 | 5258 |
| Primitives scene (all contract commands) | 32786 of 4096000 (0.800%) | 139 | 0 | 1.638 | 0.659 | 0.547 | 5299 |

Metal versus OpenGL: differing pixels workspace 0, terminal 0, primitives 0; the two GPU adapters are pixel-identical on every
scene, so the OpenGL comparison numbers of the same run are the Metal numbers above. Medians cover
40 event-driven frames per scene after a stats reset; frame time is list build plus adapter execute
with the encoder ended (`SDL_RenderFlush`, `glFlush`, `endEncoding`), excluding present and vsync.
Resident memory: SDL 162288 KiB, OpenGL 180352 KiB, Metal 143408 KiB; the Metal delta
against SDL is -18880 KiB against the 32768 KiB limit.

The first run of the spec failed on all three scenes for both GPU adapters (3259, 760 and 700
pixels) while Metal and OpenGL agreed exactly; the crops showed the login shell's asynchronous
two-line prompt and the scrollbar thumb it moved, captured at different moments. The spec now
starts a plain shell with a fixed prompt; the tolerances were not changed.

## Other checks on the final build

| Check | Result |
| --- | --- |
| Committed native desktop suite on `RENGINE_RENDERER=metal` (twelve specs, including the render comparison) | 13 tests passed across the twelve spec files, 166.7 s |
| CTest (layout, editor, terminal, draw list) | 4 passed |
| Default backend on macOS after the flip: smoke snapshot | reports `backend=metal`, byte-identical to the explicit `--renderer metal` snapshot |
| `--renderer sdl`, `--renderer opengl`, `--renderer metal` smoke snapshots | all byte-identical (`d9cc6d2f…`); `render/backend_sdl.c` is untouched since F57, so the reference itself did not move |
| `--renderer nope` | exits 2 with the usage message naming `opengl, metal or sdl`; a failed Metal device, shader or pipeline exits 1 with SDL's reason (spec 068 decision 8) |
| `python3 tools/design.py check` (render-layering guard, now scanning `.m` files) | passes |
| Build | `cmake.toml` enables Objective-C on Apple only, compiles the one `.m` file with ARC and links Metal, QuartzCore and Foundation; the regenerated `CMakeLists.txt` is committed; no warnings from the adapter |

## Criteria

| F58 criterion | Status |
| --- | --- |
| The Metal adapter renders every draw-list primitive with the same snapshot comparisons and measurements as the OpenGL adapter on macOS | Met: the same spec, scenes, tolerances and budgets; Metal below the SDL median on every scene, terminal scene under 8 ms, memory delta under 32 MiB |
| Backend selection, fallback and evidence recording match the OpenGL adapter | Met: `--renderer metal` / `RENGINE_RENDERER=metal`, explicit `--renderer sdl` fallback with a non-zero exit on failure, the smoke line and automation `state` record the backend, and this document mirrors the OpenGL evidence |
