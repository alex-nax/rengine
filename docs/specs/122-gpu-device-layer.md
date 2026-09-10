# The SDL-free GPU device layer (F120)

Date: 2026-09-10. Status: **implementing.** First of the pre-adoption work: charter D49 and D52's
layer 1, and the thing F123's pack packages.

## What moves, and what deliberately does not

`render/backend_vk.c` is 750 lines and uses SDL **23 times**. Those references are concentrated, and
they are exactly the ones OpenXR replaces: `SDL_Vulkan_LoadLibrary` and
`SDL_Vulkan_GetVkGetInstanceProcAddr` (the loader), `SDL_Vulkan_GetInstanceExtensions` (what the
instance must enable), `SDL_Vulkan_CreateSurface`, `SDL_Vulkan_GetDrawableSize`, and `SDL_SetError`.

**Only creation moves.** `re_gpu` owns the loader, the instance, physical-device selection, the
device, the queue and the memory-type lookup. The backend keeps its own `Vk` function table, its
surface, its swapchain, its present and its whole drawing path — and fills that table through the
device layer's proc getters. A refactor that also rewrote the drawing path would be a rewrite, and
this one cannot be run on the development machine (see *What is owed*), so it is deliberately the
smallest change that removes the coupling.

**The two things the caller must supply**, because they are exactly what differs between a window
and a headset:

- **required instance and device extensions.** The desktop passes what SDL asks for plus
  `VK_KHR_swapchain`; an OpenXR host passes what `xrGetVulkanInstanceExtensions` names and no
  swapchain at all.
- **a physical-device predicate.** The desktop asks *"can this queue family present to my surface?"*;
  an OpenXR host asks *"is this the adapter the runtime named?"*. The device layer cannot ask either
  question — one needs a surface, the other needs an XR instance — so it asks the caller.

**Swapchain and surface entry points stay out of the device layer entirely.** They are loaded by the
host through `re_gpu_instance_proc` / `re_gpu_device_proc`, so the device layer's translation unit
mentions no surface, no swapchain and no present. That is checkable, and it is checked.

## The guard

A layer that is *supposed* to have no windowing dependency should fail the build when it grows one,
not be reviewed for it. `tools/design.py check` already refuses hand-edited generated files and
hard-coded colours in native sources; it gains one more rule: **`render/gpu_device.c` and its header
may not mention `SDL_`, `VkSurface`, `Swapchain` or `Present`.** Adding any of them turns the gate
red and names the symbol.

## What is owed, and why it cannot be closed here

**The Vulkan backend does not run on this machine.** `--renderer vulkan --smoke-test` answers
*"Failed to load Vulkan Portability library"*; there is no MoltenVK and no `VULKAN_SDK`.
`native-render.spec.mjs` already handles this — it probes Vulkan, prints *"vulkan unavailable on this
machine"*, and compares the backends that do run. So the desktop suite's 71/71 has never exercised
this code path here, before or after this change.

What that means, stated plainly rather than glossed:

- **Verified here**: it compiles; the guard holds; the SDL, OpenGL and Metal backends are untouched
  and still match under the recorded tolerance; nothing outside `backend_vk.c` and the new files
  changed.
- **Owed**: that the Vulkan backend still renders identically. That needs a host with a Vulkan
  loader — Windows, which is where F59 was verified, or MoltenVK installed here. Until then this
  change is a compile-checked, guard-checked move, and it should not be described as more than that.

This is why the change is scoped as a move rather than a rewrite: the parts that cannot be observed
are the parts that were copied unchanged.

## Evidence

**The guard, observed failing twice** — each naming the symbol and line:

| Sabotage | Observed |
| --- | --- |
| a `VkSurfaceKHR` field in the device layer's struct | `gpu_device.c:24: VkSurface is windowing; the GPU device layer must stay usable without a window` |
| an `SDL_GetError` reference in the implementation | `gpu_device.c:172: SDL_ is windowing; …` |

**Built clean** under the project's picky set (`-Wall -Wextra -Wpedantic -Wconversion
-Wmissing-prototypes -Wshorten-64-to-32` and the rest), with **zero** `SDL_` occurrences in
`gpu_device.c`.

**Nothing else moved**: `npm test` 230/230, `npm run test:desktop` 71/71, `native-render.spec.mjs`
green — SDL, OpenGL and Metal still match under the recorded tolerance.

**And the Vulkan path is exactly as unverified as it was before.** `--renderer vulkan --smoke-test`
answers *"Failed to load Vulkan Portability library"* both before and after this change, because that
failure comes from `SDL_Vulkan_LoadLibrary` — the first line of the host's `open_gpu`, before any
device-layer code runs. The failure mode is identical, which is evidence that the change is inert on
this machine and evidence of nothing else.

**F120 therefore stays `passes: false`.** Its fourth criterion is that the desktop renders identically
after the extraction, judged by R0/R1's reference comparison, and that cannot be judged where the
backend cannot start. The work is done; the verification is owed on a host with a Vulkan loader.
Recorded as KI-079 rather than waved through, because marking this passing would put a green row
against a claim nobody has tested.

## The pack (F123's shipped half)

The device layer is not in `orchestrator/native/render/` any more: it lives at **`packs/gpu/`**, and
rEngine consumes it from there. That ordering matters — the suite builds the same bytes a project
outside this repository does, rather than a copy that can drift, which is F123's fifth criterion.

- `packs/gpu/include/rengine/gpu_device.h` — the entire public surface, one header.
- `packs/gpu/src/gpu_device.c` — private; a consumer cannot reach it, and that is asserted.
- `packs/gpu/CMakeLists.txt` — hand-written, because a pack is consumed by projects that have never
  heard of cmkr and should not need a generator to read one library. It returns early when it is not
  the top-level project, which is the shape iklib already proves in this family.
- `packs/gpu/pack.json` — the two-part pin contract 9 takes: a spoken version and a checked revision.

**Vulkan headers are a PUBLIC dependency, not a private one**, because the public header includes
`<vulkan/vulkan.h>`. rEngine vendors them beside the pack; a consumer with its own passes
`-DRENGINE_GPU_VULKAN_INCLUDE=<dir>`, the same shape `NOLF_IKLIB_DIR` uses. A missing directory is a
refusal that says what to pass, rather than a header-not-found fifty lines later.

### The evidence, which is a project outside this build

`orchestrator/tests/pack-gpu.test.mjs` writes a CMake project that has never heard of rEngine's
build, `add_subdirectory`s the pack, links `rengine::gpu`, includes the public header, and runs the
resulting binary. It then asserts the two properties that make this a pack rather than a directory,
and both were observed failing for their own reason:

| Sabotage | Observed |
| --- | --- |
| publish `src/` alongside `include/` | *"Missing expected rejection: the implementation is not reachable through the public include path"* |
| drop the not-top-level early return, leaking a target into the consumer | *"the consumer configured the pack's library and no other rEngine target: … rengine_desktop_core, rengine_gpu …"* |

The second assertion first asked `CMakeCache.txt`, which mentions target names for unrelated reasons
and therefore always passed. It now asks the build system's own target list, which is the thing that
actually answers the question.

## What F123 still owes, and a design obstacle found while doing it

D52 says the pack also carries **the resource-and-draw seam generalised from VtMB's `device.h`**, with
GL and Vulkan backends. That is not written, and it should not be written blind:

**VtMB's seam is C++ and this pack is C.** `device.h` uses `namespace vtmb::renderer::gpu`,
`enum class BufferUsage : std::uint8_t` and struct member initialisers — fifteen C++ constructs in
one header — while `packs/gpu` is `c_std_11`, as all of rEngine's native code is. D52 says VtMB
adopts the pack *by deleting its own copy*, and that cannot happen across a language boundary without
either the pack becoming C++ (a language rEngine's native tree does not currently contain) or VtMB
rewriting every call site (which is the opposite of adopting by deletion).

That is a decision, not a detail, and it was not visible until the pack existed. It belongs to the
owner before the seam is authored.
