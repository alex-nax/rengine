# The resource-and-draw seam (F123's second half)

Date: 2026-09-10. Status: **implemented, with the Vulkan backend deliberately not written.**
Charter D52's "the pack's design starts from VtMB's `device.h`", and the half spec 122 said was
blocked.

## What changed since spec 122 said this could not be written

Spec 122 argued the seam should wait for its first consumer, because "a seam's shape is settled by
the call sites it has to serve, and rEngine has no 3D renderer to serve". The first half of that is
right and the conclusion did not follow: **the call sites exist.** They are in `~/vtmb-vr`, thirteen
files behind its own `gpu::Device`, and they can be read, counted and compiled against today. Waiting
for F126 to *read* them was waiting for nothing.

What genuinely cannot be settled here is the **Vulkan backend**, and for a different reason — see
the last section. The interface and the GL backend can, and now are.

## Measured before designing

| | |
| --- | --- |
| `device.h` | 174 lines, 25 methods, **no virtuals, no templates, no inheritance, no data members** |
| `device_gl.cpp` | 319 lines |
| Files calling the seam | **13** |
| Distinct methods actually called | **23** of 25 |
| Call sites that must change to adopt | **1** of **195** (see *The one call that changes*) |

The shape of `class Device` is the whole language answer: it is an opaque handle with free functions,
written in C++ syntax. So the pack is **a C core with a header-only C++ facade of inline forwarding**.
rEngine's tree stays C, as `AGENTS.md` requires, and VtMB's call sites are untouched. There was no
tradeoff to put to the owner, which is why escalating it in spec 122 was the wrong call.

## What is taken from VtMB unchanged, and what is new

**Unchanged, because it was earned in a real renderer:** resource+draw granularity (D14c, explicitly
not command buffers or render passes); compile-time backend selection (D14b/D51); depth and cull set
piecemeal rather than bundled, because call sites toggle them independently and bundling during a
migration "could move pixels"; uniforms looked up by name, because binding numbers "would leak
GL/Vulkan differences into call sites".

Three things are new, and each answers a question spec 121 said the pack had to settle:

**1. Entry points come from the host.** `re_seam_open` takes a `glGetProcAddress` exactly as
`re_gpu_open` takes a `vkGetInstanceProcAddr`. Both layers of the pack now take their entry points
from the caller, which is one rule rather than two. It links no graphics library — so it cannot clash
with the loader a consumer already links (VtMB links glad, and two glad implementations in one binary
is a symbol clash), and it builds on a machine with no GL headers at all.

**2. A shader is a descriptor, not a source string.** This was the question that looked like it would
break D14c. `createProgram` takes GLSL text, and a Vulkan backend cannot honour that without
embedding a GLSL compiler — megabytes of dependency, and a per-program cost on Quest.

*It does not have to.* VtMB's own build already runs `glslang -> SPIR-V -> SPIRV-Cross` to produce
its GL 4.10 and GLES 3.2 dialects, and **throws the SPIR-V away** in a work directory
(`cmake/shaders.cmake`, `${work}/${var}.gl.spv`). The form a Vulkan backend needs is one the build
already produces. So `ReSeamShader` carries every form, the generator emits it, and each backend
takes its own half. Call sites do not change: `createProgram(k_ui_vert, k_ui_frag, "ui")` compiles
whether those symbols are `const char*` or descriptors, because the type is the generator's business.

**3. A handle's id stays 32 bits.** Spec 121 called this "the first real question F123 has to
answer": VtMB's ids are GL names, and a `VkBuffer` is 64 bits. The answer is that the id is the
*backend's* name for the object — a GL name in the GL backend, a slot index into a backend-owned
table in a Vulkan one. That costs one array lookup per resource call, keeps `0 == none`, and keeps
these structs exactly the size VtMB's call sites already assume.

## Evidence

### The GL backend renders, judged on pixels

`packs/gpu/tests/gpu_seam_test.c` opens a real GL context (`4.1 Metal - 89.4`), renders through the
seam into a framebuffer **the test created itself** — render targets come from outside, the same rule
the device layer follows — and reads the result back. Clear, programs, uniforms, buffers, vertex
layouts, textures, filtering, wrapping, blending, both primitives, and the failure paths.

**Thirteen sabotages, each observed:**

| Sabotage | Observed |
| --- | --- |
| the texture unit is ignored | `the texel the uv named landed there` |
| alpha blending is never enabled | `the blend mode asked for is the one used` |
| the vertex attribute offset is ignored | `the texel the uv named landed there` |
| the vertex layout stride is ignored | `the texel the uv named landed there` |
| setUniform vec4 is dropped | `setUniform reaches the shader, not a cached value` |
| the clear channels are reordered | `the channels arrive in the order they were passed` |
| a failed link still hands back its id | `a program that compiles but does not link yields no program either` |
| a destroyed handle keeps its id | `a destroyed handle reads as none, so a double free is not a live id` |
| the requested filter is ignored | `nearest returns a texel, not a mix of two` |
| the requested wrap is ignored | `clamping holds the last texel past the edge` |
| the primitive is always triangles | `a line primitive drew a line; two vertices as triangles would have drawn nothing` |
| the wrong-form guard is removed | **SIGSEGV** — no assertion; see below |
| the buffer usage hint is ignored | **nothing**; see below |

### Four of those were found by the sabotage pass, not by writing the test

This is the part worth recording, because the first version of the test passed all of its own
assertions while missing four real faults:

- **The filter was never checked.** Every sample sat at a clamped edge, where nearest and linear
  return the same texel. Fixed by sampling at u = 0.6, where they differ by 77 in one channel.
- **The wrap was never checked.** Every uv stayed inside [0, 1], where clamp and repeat are the same
  thing. Fixed by running uv out to 2.
- **The line primitive was never drawn.** Nothing but triangles, so the argument was never read.
- **uv was mistakable for position.** The texture ran left to right, the same way position does, so
  reading the attribute from the wrong offset produced the same two halves. Fixed by mirroring the
  texture across the quad, which makes the wrong read put the *wrong* texel on each side rather than
  none.

A fifth was a test-design fault rather than a gap: the coverage assertion used a uniform-coloured
shader, so dropping `setUniform` turned the triangle black and failed *"the draw covered the vertices
it was given"* — an assertion claiming something it was not testing. Split into a constant-coloured
program for coverage and a uniform-driven one for the uniform.

And a sixth was in the assertion text itself. The wrong-form check asked whether the diagnostic
contained "GLSL" — which a *driver's* own compile error also says, so it proved nothing. It now asks
for `ReSeamShader.glsl`, the field name, which only the pack says.

### The two the test cannot catch, stated rather than hidden

- **The wrong-form guard** (`stage->glsl == NULL`) does not fail an assertion when removed: the
  process **segfaults**, because `glShaderSource` is handed a null source pointer. That is a
  detection, and it is the reason the guard exists rather than a nicety.
- **The buffer usage hint** (`STATIC` vs `DYNAMIC`) cannot be observed at all. It is a hint with no
  defined behavioural difference, so no pixel and no query can separate the two. Recorded as an
  untested line rather than counted as covered.

### The facade preserves vtmb-vr's call sites, checked by compiling them

`packs/gpu/tests/gpu_seam_facade_test.cpp` writes VtMB's call expressions the way VtMB writes them —
its casts, its enum spellings, its reference arguments, `bindVertexArray(gpu::VertexArray{})`,
`createTexture2D(reinterpret_cast<const std::byte*>(...), ...)`, all three `setUniform` overloads,
handles declared without an initialiser — and `pack-gpu-seam.test.mjs` builds it as a **C++ project
outside this repository** that adds the pack and links it.

The same spec re-derives, from `~/vtmb-vr` itself, the set of methods actually called on a
`gpu::Device` (**23**) and fails if any is missing from the facade or from the fixture, so a
hand-written fixture cannot drift away from the code it stands for. Anchoring on the declared
variables is what makes that number mean anything: grepping for method names alone counted 442 calls
to `clear`, nearly all of them `std::vector::clear`.

Three sabotages, each observed: dropping `setCull` from the fixture fails the drift check naming it;
renaming a facade method fails both the compile and the drift check; making the pack
`find_package(OpenGL)` fails *"the pack must not drag a graphics library into a consumer"*.

### The guard

`tools/design.py check` gained a second rule beside the device layer's: the seam's sources may not
include a graphics API header, and may not mention `SDL_`. Both observed failing by name and line:

```
packs/gpu/src/gpu_seam_gl.c:398: #include <GL links a graphics API into the pack; the seam takes its
  entry points from the host's loader so a consumer can keep its own (spec 122)
packs/gpu/src/gpu_seam_gl.c:399: SDL_ is windowing; the seam draws into whatever target the host
  bound and never makes one (spec 122)
```

## The one call that changes

`AGENTS.md` asks for adoption costs to be stated rather than discovered. Of **195** call sites across
those thirteen files, **one** must change: `menu_eye_renderer.h:77`, `m_draw.init(nullptr)`, commented *"no loader on
GLES; nullptr is the documented no-op path"*. VtMB's backend reads a null window as "glad already
ran, use the global entry points". A library that links no GL has no global entry points to use —
and that is the same property that lets a consumer keep its own loader and lets the pack build on a
machine with no GL at all. Such a call site passes a loader instead (`eglGetProcAddress` on GLES).

It fails to **compile** rather than at runtime, which is the right way for it to fail.

One behaviour also generalises away: VtMB's backend prepends `glslPrefixFor(source)` before
compiling a stage, empty for a cross-compiled shader and a `#version` line for one embedded verbatim.
A library cannot know a consumer's preamble convention, and the shader descriptor exists so the build
hands over a complete stage. VtMB's F800 cross-compilation is on by default and its shaders carry
their own `#version`; a build with `VTMB_SHADER_CROSS=OFF` would need its generator to prepend one.

## Why the Vulkan backend is not here — a concrete blocker, not a scheduling preference

Spec 122 gave a weak reason for deferring this ("rEngine has no 3D renderer to serve"). Building the
GL backend surfaced a hard one.

**The seam has no render-target concept, because GL let its call sites do that behind its back.**
`clear` and `draw` render into whatever framebuffer is currently bound, and the binding happens
outside the seam entirely — this test does it too, and spec 122 called that a virtue, correctly, for
the *device* layer. In Vulkan there is no such ambient state: a draw is inside a render pass against
images the caller named. So a Vulkan backend needs an API the seam does not have.

Measured in the code that would have to use it:

| | files | calls |
| --- | --- | --- |
| behind the seam (`gpu::Device`) | 13 | 195 |
| binding a render target with raw `glBindFramebuffer` | **13** | 63 |
| **in both sets** | **0** | — |

Two disjoint groups of thirteen. Every call site that would need the new render-target API is one of
the 49 files **not yet migrated**, so its shape would be guessed here and discovered wrong there —
which is exactly the outcome D52's sequencing exists to prevent, now with an example instead of a
worry.

The other reason still holds and is worth keeping: **the GL backend was judged on pixels, and a
Vulkan one written here could not be.** rEngine has no 3D renderer calling this seam, so it would
ship compile-checked — the standard spec 122 refused for the device layer, and refusing it there is
what led to actually running the thing.

`RENGINE_GPU_SEAM_BACKEND=vulkan` therefore fails the configure with a message that says so.

### This is also a correction to spec 121's order

Spec 121 has F126 as "VtMB adopts the pack for its 13 already-migrated files" and F127 as "migrate
the remaining 49". If the render-target API has to come from the second group, then a Vulkan backend
cannot be complete at F126 — F126 proves the adoption and the resource+draw half on GL, and the
render-target seam arrives with the files that need it. Flagged for the owner rather than edited into
the feature rows, per `AGENTS.md`.

What it will have to solve, named now while the analysis is fresh:

- **Uniforms by name.** Vulkan has no default uniform block. The backend collects a program's
  uniforms into a push-constant block and maps `uniformLocation(program, name)` to an offset in it
  via SPIR-V reflection; `setUniform` writes into a CPU-side block pushed at draw time. Name lookup
  survives — which is the half of D14c most likely to have been thought impossible.
- **Pipelines.** `setBlend`/`setDepth`/`setCull`/the bound vertex layout are pipeline state in
  Vulkan and loose state in GL. The backend coalesces them at draw time into a pipeline it caches,
  keyed by that state. This is what D14c bet could be "built internally", and it is the claim F126
  tests.
- **The render pass.** `clear` and `draw` outside a render pass have no meaning in Vulkan. Dynamic
  rendering (which `re_gpu` already requires as a device floor) makes this a begin/end the backend
  can insert around a run of draws, with the target supplied from outside as it already is.
