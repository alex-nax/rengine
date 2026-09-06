# Vulkan adapter behind the draw list, macOS through MoltenVK, 2026-09-06

Scope: the macOS development and evidence path of F59 ([spec 073](../specs/073-vulkan-adapter.md)
decision 2) on macOS 15.7.3, Apple M3 Max, SDL 2.32.10 with `SDL_WINDOW_VULKAN`, Homebrew Vulkan
loader 1.4.328 with MoltenVK 1.4.0 (device API 1.3.323), validation layers 1.4.357 from Homebrew,
1280×800 logical / 2560×1600 drawable, tree at `038759f` plus this change. The F59 criterion is
carried by the Windows evidence; this run shows the adapter meets the same gates on a second
platform. The gate is the SDL reference adapter (spec 068 decisions 5 and 6).

## Comparisons against the SDL reference adapter

`orchestrator/tests/native-render.spec.mjs` captures `sdl`, `opengl`, `metal` and `vulkan` from
separate server state with a plain `bash --norc` shell and a fixed prompt, then compares snapshots
with `tools/render_compare.py` under the spec 068 tolerances.

| Scene | Vulkan vs SDL differing pixels | Max channel Δ | Outside 2px band | SDL median ms | OpenGL median ms | Metal median ms | Vulkan median ms | Commands |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Default workspace (tree, shell prompt) | 0 of 4096000 (0.000%) | 0 | n/a | 1.832 | 1.231 | 1.401 | 0.846 | 4028 |
| Terminal with 40 coloured rows | 0 of 4096000 (0.000%) | 0 | n/a | 3.115 | 1.469 | 1.673 | 1.110 | 5258 |
| Primitives scene (all contract commands) | 32786 of 4096000 (0.800%) | 139 | 0 | 2.825 | 1.561 | 1.675 | 0.462 | 5299 |

Vulkan is pixel-identical to OpenGL and to Metal on every scene (0 differing pixels in each
cross-comparison), so the three GPU adapters share one set of numbers against the reference.
Medians cover 40 event-driven frames per scene after a stats reset; frame time is list build plus
adapter execute with the frame's commands recorded, excluding present and vsync. Resident memory:
SDL 162048 KiB, OpenGL 179728 KiB, Metal 142672 KiB, Vulkan 143456 KiB; the Vulkan delta against SDL is
-18592 KiB against the 32768 KiB limit.

## Validation-layer run (spec 073 decision 9)

The spec repeats the Vulkan capture with `RENGINE_VULKAN_VALIDATION=1`; `VK_LAYER_KHRONOS_validation`
reported 0 messages of warning or error severity across the three scenes. The first smoke run with
validation, before this evidence, reported two findings that were fixed: the swapchain picked a
BGRA8 entry in the HDR10 colour space (MoltenVK lists several colour spaces per format; the adapter
now prefers the sRGB space) and the 1.3-targeted SPIR-V uses demote-to-helper for `discard`, which
the device must enable (now required and enabled).

## Other checks on the final build

| Check | Result |
| --- | --- |
| Committed native desktop suite on `RENGINE_RENDERER=vulkan` (twelve specs, including the render comparison) | SUITE_RESULT |
| CTest (layout, editor, terminal, draw list) | 4 passed |
| `--renderer vulkan` smoke snapshot | byte-identical to the SDL, OpenGL and Metal smoke snapshots (`d9cc6d2f…`); the validated run produces the same bytes |
| `--renderer vulkan` without a loader path | exits non-zero with `Failed to load Vulkan Portability library` (spec 068 decision 8); the render spec records the backend as unavailable on such a machine (decision 11) |
| `python3 tools/design.py check`, `python3 tools/shaders.py check` | pass; the layering guard sees Vulkan symbols only in `render/backend_vk.c` |
| macOS default | stays Metal (spec 072); Vulkan on macOS needs `SDL_VULKAN_LIBRARY` pointing at the Homebrew loader, which the render spec sets itself |
