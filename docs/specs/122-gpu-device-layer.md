# The SDL-free GPU device layer (F120)

Date: 2026-09-10. Status: **F120 passing.** First of the pre-adoption work: charter D49 and D52's
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

## What was owed — and why it turned out not to be owed at all

This section previously said the Vulkan backend could not run here, and that F120's render-identity
criterion was owed on another host. **That was wrong, and the way it was wrong is the useful part.**

`--renderer vulkan --smoke-test` answered *"Failed to load Vulkan Portability library"*, and
`native-render.spec.mjs` printed *"vulkan unavailable on this machine"*. Both are true statements
about what was observed and neither is evidence about the machine. Homebrew had already installed
`molten-vk`, `vulkan-loader` and `vulkan-validationlayers`; the loader was even being found, because
the spec already sets `SDL_VULKAN_LIBRARY`. What was missing was the **ICD manifest**. Homebrew puts
MoltenVK's at `/opt/homebrew/etc/vulkan/icd.d/MoltenVK_icd.json`, and the loader searches
`share/vulkan/icd.d`, not `etc/` — so it loaded, enumerated no drivers, and failed in a way
indistinguishable from a machine with no Vulkan at all.

`vulkanEnv()` now discovers that manifest the same way it already discovers the loader and the
validation-layer path. One variable.

### So the device layer is exercised on a real driver

```
Vulkan device: Apple M3 Max
Native microui frame rendered: 1280x800, renderer=cocoa, backend=vulkan
```

| | measured against the SDL reference |
| --- | --- |
| workspace | 0.0096% differing, max delta 165, **0 pixels outside the edge band** |
| terminal | 0.011% differing, max delta 165, 0 outside |
| primitives | 0.79% differing, max delta 213, 0 outside |
| cross-backend | `opengl-vs-vulkan` and `metal-vs-vulkan` both clean |
| validation layers | **0 messages** |
| frame medians | 0.222 / 0.319 / 0.348 ms against a 4 ms ceiling — 0.20–0.23× the SDL reference |
| resident memory | 144,976 KiB against SDL's 163,424 — below the reference |

Every instance, physical-device, device and queue call behind those numbers goes through the
extracted layer. That is the criterion, and it is met.

**F120 therefore passes.** KI-079 closes with the correction recorded rather than deleted, because
*"unavailable on this machine"* is a claim about the environment that deserves the same suspicion as
any other unverified claim — and `brew list` answered it in one command, a day late.

## The selection logic, checked without a GPU

The render comparison proves the layer works on *this* machine's single Apple GPU. It cannot prove
the parts that only matter on a machine that has choices: what happens with two queue families, a
host predicate that refuses, a device below the feature floor, a missing extension. Those are decided
entirely through the `vkGetInstanceProcAddr` the **caller** supplies — which is a seam a test can
stand in front of.

`packs/gpu/tests/gpu_device_test.c` supplies a loader of its own making and checks the decisions:
handles and memory types on the happy path, a predicate that refuses everything, a predicate that
picks family 1 of 2, a device without `dynamicRendering`, an API-1.2 device, a missing required
device extension, and a null loader. Five sabotages, each observed failing on its own assertion:

| Sabotage | Observed |
| --- | --- |
| ignore `options->accepts` | `"a host that accepts nothing gets nothing"`, line 158 |
| drop the feature floor | `"dynamic rendering is required"`, line 173 |
| drop the required-extension check | `"a missing required device extension refuses"`, line 182 |
| pass `enabledExtensionCount = 0` to `vkCreateDevice` | `"the caller's device extension reached vkCreateDevice"`, line 165 |
| pass `enabledExtensionCount = 0` to `vkCreateInstance` | `"the caller's instance extension reached vkCreateInstance"`, line 164 |

The last two are worth naming. A layer that validates the caller's extension list and then hands
Vulkan its own would leave an OpenXR host with a device missing exactly what its runtime demanded —
**while reporting success**. No test that only asks whether `re_gpu_open` returned non-null can see
that, and F120's sixth criterion names it specifically.

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

## What F123 still owed, and where it went

The seam is now written: **spec 123** carries it, along with the language answer, the shader-form
answer, the handle-width answer, and the reason its Vulkan backend is sequenced with the files that
need a render-target API rather than written here.

Two things recorded in this spec were wrong and are corrected there rather than deleted:

- **"VtMB's seam is C++ and this pack is C" was raised as the owner's decision.** It is not one.
  `class Device` has no virtuals, no templates, no inheritance and no data members — an opaque handle
  with free functions in C++ syntax — so a C core with a header-only C++ facade satisfies both
  constraints with nothing left to trade off.
- **"A seam's shape is settled by the call sites it has to serve, and rEngine has no 3D renderer to
  serve"** — the first half is right, the conclusion was not. The call sites exist, in `~/vtmb-vr`,
  and can be read and compiled against today. Waiting for F126 to read them was waiting for nothing.
