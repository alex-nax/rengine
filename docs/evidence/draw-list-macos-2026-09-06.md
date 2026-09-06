# Draw-list contract and SDL reference adapter, macOS, 2026-09-06

Scope: F56 ([spec 067](../specs/067-draw-list-contract.md)) on macOS (Darwin 24.6.0, SDL 2.32.10,
cocoa video driver, 1280×800 logical / 2560×1600 drawable). Started on owner direction while the
inventory still blocks F56 behind F34 and F42; F56 is not marked passing. Baseline tree: `3a6d068`
plus the other session's uncommitted CMake, main.c and app.c edits, which were present for both runs.

## Byte-identical rendering

| Snapshot | Build | SHA-256 |
| --- | --- | --- |
| before | immediate-mode `draw.c` | `8d237fdfc2f0c118f2ce8f83ce94b0a3ea126c6fce3831b1083b6d8598884c51` |
| after | draw list → `render/backend_sdl.c` | `8d237fdfc2f0c118f2ce8f83ce94b0a3ea126c6fce3831b1083b6d8598884c51` |

Command: `.cache/desktop/bin/rengine --smoke-test --snapshot FILE.bmp`; `cmp` reports no difference.

## Automated checks on the final build

| Check | Result |
| --- | --- |
| CTest | native_layout, native_editor, native_terminal, native_draw_list: 4 passed |
| Native desktop suite (eight committed specs, reference adapter) | 8 passed, 50.0 s |
| `python3 tools/design.py check` with the render-layering guard | passes |
| Sidecar validator: draw.c, game.c, render/font.c, render/backend_sdl.c, render/draw_list.c | valid |
| `./init.sh` | passes |

## Criteria

| F56 criterion | Status |
| --- | --- |
| Versioned draw-list contract covering clip, rounded alpha rects, frames with inner highlight, shadows, text runs in two faces, tinted icons, focus rings and game textures in logical pixels with density; no API header above it | Met by `render/draw_list.h` v1; `native_draw_list` verifies order, payloads, arena copies, clip reset, overflow and a recording adapter; the guard rejects rendering symbols above the list |
| microui commands and the owned control layer emit only draw-list commands; pinned upstream microui unmodified | Met: `draw.c` translates commands; `git diff third_party/` is empty |
| SDL_Renderer adapter consumes the list; snapshots byte-identical; CTest and native desktop suite pass | Met on macOS as tabulated above |

Windows is not covered (KI-014). Per-primitive comparisons for the new primitives arrive with F57.
