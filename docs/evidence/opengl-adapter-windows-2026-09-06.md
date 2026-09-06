# OpenGL adapter behind the draw list, Windows, 2026-09-06

Scope: F62 ([spec 073](../specs/073-vulkan-adapter.md) decision 3; adapter from [spec 068](../specs/068-opengl-adapter.md)).
Host: Windows 11 Pro 26200, NVIDIA GeForce RTX 4070 Ti SUPER (driver 591.86), Visual Studio 2026
Community 18.6 (MSVC 19.51), CMake 4.2.3, SDL 2.32.10 development files, Node 24.15, 1280×800 logical and
drawable (no high-DPI scaling on this display), builds `35e73dc`–`eb88c92` in the isolated checkout
`C:\Users\pr0fe\rengine` fed by git bundle (charter D31, runbook
`docs/runbooks/windows-verification.md`). GUI stages ran in the console session through a scheduled
task; the terminal scene used PowerShell with its default prompt.

## Comparisons against the SDL reference adapter

`orchestrator/tests/native-render.spec.mjs` under the spec 068 tolerances (current-UI scenes at most
0.1% differing pixels and channel delta at most 2; primitives at most 2% within a 2px edge band).

| Scene | OpenGL vs SDL differing pixels | Max channel Δ | Outside 2px band | SDL median ms | OpenGL median ms | Commands |
| --- | --- | --- | --- | --- | --- | --- |
| Default workspace (tree, shell prompt) | 0 of 1024000 (0.000%) | 0 | n/a | 1.473 | 0.434 | 3520 |
| Terminal with 40 coloured rows | 0 of 1024000 (0.000%) | 0 | n/a | 0.826 | 0.522 | 4879 |
| Primitives scene (all contract commands) | 8079 of 1024000 (0.789%) | 139 | 0 | 1.019 | 0.537 | 4920 |

Medians cover 40 event-driven frames per scene after a stats reset; frame time is list build plus
adapter execute with submission flushed, excluding present and vsync. Resident memory (working set):
SDL 63708 KiB, OpenGL 91936 KiB, delta 28228 KiB against the 32768 KiB limit (24–28 MiB across
three runs). OpenGL and Vulkan are pixel-identical on every scene on this host.

## Other checks

| Check | Result |
| --- | --- |
| Build from the transferred commits with MSVC | passes; `SDL2.dll` is copied next to `rengine.exe`, the CTest executables and the surface fixture |
| CTest (layout, editor, terminal, draw list) | 4 passed (after the DLL copy; two tests exited 0xc0000135 before it) |
| `--renderer sdl` and `--renderer opengl` smoke snapshots | byte-identical to each other (`c15b4ec3…`); `--renderer nope` exits 2 with the usage message |
| Native desktop suite on `RENGINE_RENDERER=opengl` | 7 of 15 tests passed, 8 failed, on both backends alike: the empty-workspace bootstrap (EPERM unlinking a running `rengine.exe` in the layered-update versions directory), the wide-tree layout test (`dir063 never scrolled into view`), project windows (the fixture's symlink needs a Windows privilege), the render comparison (the Vulkan memory delta), and the four terminal specs whose PTY output or input never reached the native view (KI-038) |

## Criteria

| F62 criterion | Status |
| --- | --- |
| The OpenGL adapter builds and starts on the Windows desktop from the authorized source transfer (KI-014), with backend selection and evidence recording as on macOS | Met: build, smoke line `renderer=windows, backend=opengl`, automation `state` records the backend |
| Per-primitive and whole-screen snapshot comparisons against the reference adapter pass on Windows within the spec 068 tolerances | Met as tabulated |
| Frame time and memory are measured on Windows against the spec 068 budgets, and the native desktop suite passes there on the OpenGL backend | Frame time and memory met (OpenGL below the SDL median on every scene, terminal under 8 ms, delta under 32 MiB); suite: not met, 7 of 15 on Windows (KI-038); F62 stays open |
