# Vulkan adapter behind the draw list, Windows, 2026-09-06

Scope: F59 ([spec 073](../specs/073-vulkan-adapter.md)) on the host that carries the criterion.
Host: Windows 11 Pro 26200, NVIDIA GeForce RTX 4070 Ti SUPER (driver 591.86), Visual Studio 2026
Community 18.6 (MSVC 19.51), CMake 4.2.3, SDL 2.32.10 development files, Node 24.15, 1280×800 logical and
drawable (no high-DPI scaling on this display), builds `35e73dc`–`eb88c92` in the isolated checkout
`C:\Users\pr0fe\rengine` fed by git bundle (charter D31, runbook
`docs/runbooks/windows-verification.md`). GUI stages ran in the console session through a scheduled
task; the terminal scene used PowerShell with its default prompt.
Vulkan: NVIDIA runtime 1.4.325 (instance 1.4.357 with the LunarG SDK 1.4.357 installed for the
validation layer); the adapter requests API 1.3 with dynamic rendering and synchronization2.

## Comparisons against the SDL reference adapter

| Scene | Vulkan vs SDL differing pixels | Max channel Δ | Outside 2px band | SDL median ms | Vulkan median ms | Commands |
| --- | --- | --- | --- | --- | --- | --- |
| Default workspace (tree, shell prompt) | 0 of 1024000 (0.000%) | 0 | n/a | 1.473 | 0.196 | 3520 |
| Terminal with 40 coloured rows | 0 of 1024000 (0.000%) | 0 | n/a | 0.826 | 0.293 | 4879 |
| Primitives scene (all contract commands) | 8079 of 1024000 (0.789%) | 139 | 0 | 1.019 | 0.291 | 4920 |

Vulkan is pixel-identical to OpenGL on every scene (0 differing pixels in each cross-comparison), so
the comparison numbers above are the same as the OpenGL evidence of this host. Vulkan medians are
below OpenGL's on every scene. Validation-layer run: 0 messages of warning or error severity.

Resident memory (working set): SDL 63708 KiB, OpenGL 91936 KiB, Vulkan 125452 KiB; the Vulkan delta against
SDL is 61744 KiB (54–60 MiB across three runs) against the 32768 KiB limit, so the memory budget is not met
on this host. Before the adapter's allocation trim the delta was 71472 KiB; the trim (1 MiB staging
per frame, 16384-vertex chunks created on first use, readback allocated on the first snapshot)
removed the adapter's own share, and the remainder is the NVIDIA Vulkan driver's process baseline:
OpenGL, which shares the same driver DLL, sits 28228 KiB above SDL, and the Vulkan path adds about
30 MiB on top of that before the adapter draws anything. On macOS (unified memory, MoltenVK) the same
adapter sits below SDL.

## Other checks

| Check | Result |
| --- | --- |
| `--renderer vulkan` smoke snapshot | reports `backend=vulkan` on the NVIDIA device (API 1.4.325); byte-identical to the SDL, OpenGL and default smoke snapshots (`c15b4ec3…`); `--renderer nope` exits 2 |
| Native desktop suite on `RENGINE_RENDERER=vulkan` | 7 of 15 tests passed, 8 failed, on both backends alike: the empty-workspace bootstrap (EPERM unlinking a running `rengine.exe` in the layered-update versions directory), the wide-tree layout test (`dir063 never scrolled into view`), project windows (the fixture's symlink needs a Windows privilege), the render comparison (the Vulkan memory delta), and the four terminal specs whose PTY output or input never reached the native view (KI-038); the same seven pass on Vulkan as on OpenGL |
| Windows default | stays SDL: spec 073 decision 8 flips it to Vulkan only once OpenGL and Vulkan both pass here |

## Criteria

| F59 criterion | Status |
| --- | --- |
| The Vulkan adapter renders every draw-list primitive with the same snapshot comparisons and measurements as the OpenGL adapter on Windows | Comparisons and frame time met; the memory measurement exceeds the spec 068 budget on this host (driver baseline), so the criterion is not met as recorded |
| Backend selection, fallback and evidence recording match the OpenGL adapter; additional platforms record their own evidence | Met: `--renderer vulkan` / `RENGINE_RENDERER=vulkan`, explicit fallback, smoke line and automation `state`; macOS evidence in `vulkan-adapter-macos-2026-09-06.md` |
