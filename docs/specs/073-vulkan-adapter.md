# Vulkan adapter behind the draw list (F59), with the Windows OpenGL evidence (F62)

Date: 2026-09-06. Status: started after a `/grill-me` interview. Parent: [GPU rendering](066-gpu-rendering.md),
[draw-list contract](067-draw-list-contract.md), [OpenGL adapter](068-opengl-adapter.md),
[Metal adapter](072-metal-adapter.md), charter D29–D32.

## Decisions from the interview

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | The Windows verification host is `pr0fe@192.168.31.217`; this is the source-transfer authorization KI-014 waited for. Commits move by `git bundle` over SSH into an isolated checkout `C:\Users\pr0fe\rengine`; the working tree, including the other session's uncommitted files, never leaves this machine and nothing is pushed to GitHub as a side effect. | Owner: “for windows verification use ssh pr0fe@192.168.31.217 machine”, 2026-09-06 (charter D31); transfer method recommended, owner confirmed |
| 2 | The adapter is developed on this Mac through MoltenVK first (Homebrew SDL2 2.32.10 has Vulkan support; loader, MoltenVK 1.3.323 and glslc are present), with `vulkan` as a fourth backend in the render spec; Windows then verifies for the criterion. Metal stays the macOS default; Vulkan on macOS is a development and evidence path. | Recommended, owner confirmed |
| 3 | The Windows OpenGL evidence (F62) is produced by the same Windows bring-up and run. | Recommended, owner confirmed |
| 4 | Installed on the Windows host for this work: the SDL2 2.32.10 development files (nolf's copy is 2.30.11 and the build pins 2.32.10 exactly) and the LunarG Vulkan SDK, so validation layers run on the NVIDIA driver as well. | SDL2 recommended; the SDK is the owner's addition |
| 5 | The floor is Vulkan 1.3 core, the maximum Quest 3 supports: the Qualcomm driver v837 extracted from a Quest 3 (January 2026) reports 1.3.295; MoltenVK here reports 1.3.323; the Windows host's NVIDIA runtime is 1.4. Dynamic rendering and synchronization2 are therefore core, and the adapter has no render-pass or framebuffer objects. Older Horizon OS drivers reported 1.1, so a Quest must run a current OS. | Owner: “We need to have the same maximum that Quest 3 supports”, 2026-09-06 (charter D32); the version was researched, not asked |
| 6 | Shaders are owned Vulkan GLSL sources under `render/shaders/`, compiled by `tools/shaders.py generate` with glslc into committed SPIR-V arrays; `tools/shaders.py check` (run by `init.sh`) fails when the arrays do not match the sources' hashes. No Vulkan SDK is needed to build. | Recommended, owner confirmed |
| 7 | Vulkan headers are vendored and pinned in `third_party/vulkan` (the glad precedent); every entry point is resolved through `SDL_Vulkan_GetVkGetInstanceProcAddr`, so there is no link-time dependency and Vulkan is simply unavailable where no loader exists. | Recommended, owner confirmed |
| 8 | Once OpenGL and Vulkan both pass on Windows, Vulkan becomes the Windows default with OpenGL and SDL selectable, the same rule Metal set on macOS. | Recommended, owner confirmed |
| 9 | A validation-layer-clean run is part of the gate: `RENGINE_VULKAN_VALIDATION=1` enables `VK_LAYER_KHRONOS_validation` with a debug messenger, the render spec runs once with it on each platform, and any error or warning fails. | Recommended, owner confirmed |
| 10 | Windows failures outside rendering: small blockers in the desktop's own code are fixed, larger ones recorded as known issues; F59 and F62 pass only when every criterion is met and otherwise stay open with their evidence recorded. | Recommended, owner confirmed |
| 11 | Where no Vulkan loader exists, the render spec probes `--renderer vulkan` once, records the backend as unavailable on that machine and still gates the others; the evidence names the machine where Vulkan actually ran. | Recommended, owner confirmed |

Inherited from spec 068: tolerances, budgets and the SDL reference as the gate (decisions 5–6), a
selected backend that cannot initialise exits non-zero with the reason (decision 8); from spec 072:
GPU adapters are compared to each other as information only.

## Codebase-derived design

- Window flag `SDL_WINDOW_VULKAN`; instance extensions from `SDL_Vulkan_GetInstanceExtensions`
  plus `VK_KHR_portability_enumeration` when the loader offers it (MoltenVK); surface from
  `SDL_Vulkan_CreateSurface`; drawable size from `SDL_Vulkan_GetDrawableSize`.
- Device: the first physical device with a graphics queue that can present, API 1.3 or later and
  the 1.3 features `dynamicRendering` and `synchronization2`; `VK_KHR_swapchain`, plus
  `VK_KHR_portability_subset` when present.
- Swapchain: `B8G8R8A8_UNORM` when offered, FIFO presentation (vsync like the other adapters),
  colour-attachment and transfer-source usage so snapshots copy the presented image; recreated on
  out-of-date, suboptimal or size change.
- Two frames in flight, each with a command buffer, fence, semaphores, a chain of persistently
  mapped 16384-vertex chunks created on first use that grows to the largest frame seen, and a
  1 MiB glyph staging buffer; the snapshot readback buffer is allocated on the first snapshot.
- Vertex layout and shading are the Metal adapter's (`float4` shape and radii first, stride 60);
  the vertex shader takes the drawable size as a push constant and emits Vulkan's y-down NDC
  directly, so no flip is needed anywhere else.
- Glyphs are rasterised and uploaded in a pre-pass over the list's text and icon commands before
  `vkCmdBeginRendering`, because transfers are illegal inside a rendering scope; the atlas is an
  `R8_UNORM` 2048² image packed on shelves and repacked when full, as in the other adapters.
- Textures are `RGBA8_UNORM` images with one descriptor set each; `texture_update` writes a
  per-texture staging buffer after waiting for the frame that last copied it, and the copy is
  recorded at the next `begin` behind a fragment-read barrier.
- Snapshot: end rendering, copy the swapchain image to a host-visible buffer, submit with a fence,
  wait, write the BMP, and let `present` only queue the already-submitted image.
- macOS: the harness sets `SDL_VULKAN_LIBRARY` to Homebrew's loader when it exists (SDL honours
  that variable); `rengine --renderer vulkan` needs the same variable by hand.
- Windows runs happen in the console session through a scheduled task (the nolf precedent: an SSH
  session is not interactive), with output captured to log files; the terminal scene uses
  PowerShell with its default prompt. The runbook is `docs/runbooks/windows-verification.md`.

## Verification

- macOS: `native-render.spec.mjs` with `sdl`, `opengl`, `metal`, `vulkan`; the full desktop suite
  on `RENGINE_RENDERER=vulkan`; CTest; a validation-clean run; smoke snapshots of every backend;
  the SDL snapshot unchanged. Evidence: `docs/evidence/vulkan-adapter-macos-2026-09-06.md`.
- Windows: build from the transferred commits with MSVC, the render spec with `sdl`, `opengl`,
  `vulkan`, the suite on OpenGL and on Vulkan, CTest, a validation-clean run, smoke snapshots.
  Evidence: `docs/evidence/opengl-adapter-windows-<date>.md` (F62) and
  `docs/evidence/vulkan-adapter-windows-<date>.md` (F59).
- After both pass on Windows, the Windows default flips to Vulkan and the default smoke snapshot
  matches the explicit `--renderer vulkan` snapshot there.

## Status, 2026-09-06

macOS through MoltenVK: every gate met (`docs/evidence/vulkan-adapter-macos-2026-09-06.md`). Windows:
build, CTest, smoke, comparisons, frame time and validation met for OpenGL and Vulkan; the Vulkan memory
delta (54–60 MiB, driver baseline) exceeded the spec 068 ceiling; the owner set a per-platform ceiling
of 64 MiB for Vulkan on Windows (accepted-criteria correction, charter revision record, KI-039), under
which the Windows render run passes (delta 60380 KiB) and F59 passes on its macOS and Windows evidence. The desktop suite passes
7 of 15 tests on Windows for reasons outside rendering (KI-038), so F62 stays open per decision 10 and
the Windows default stays SDL per decision 8.

## Deferred

A Quest build of the desktop (Android surface, OpenXR) is not part of this feature; the floor only
keeps the adapter runnable there. Linux is picked up when targeted.
