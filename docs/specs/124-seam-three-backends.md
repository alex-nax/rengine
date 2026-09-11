# The seam carries a real renderer: render targets, three backends, and the D14c verdict here

Date: 2026-09-11. Status: **F129 and F132 implemented and evidenced; F130 next.**

F129's row stays `passes: false` and not for want of evidence: `features.py validate` refuses a
passing feature that depends on a non-passing one, and F129 depends on F123, which cannot pass until
its eighth criterion has the Vulkan and Metal backends. So the whole chain in this spec completes at
F131 and flips backwards. That is KI-082's knot showing itself in the inventory rather than anything
owed by F129, and it is the cost of leaving the criterion unamended. Owner-directed, extending spec 123.

> "I like option 4, we can also write a small app for integration testing that displays some scene
> like in this forward plus vk rendering implementation" — owner, 2026-09-11, choosing to prove the
> seam in rEngine rather than wait for vtmb-vr
>
> "also do this for metal, retire plain sdl" — owner, on the backend set
>
> "Please include sh script to download sponza" — owner

## What this changes

Spec 123 shipped the seam with one backend and argued its Vulkan backend had to wait for F126,
because the render-target API it needs is shaped by call sites rEngine does not have. The owner's
answer is to **give rEngine those call sites**: a scene example that renders through the seam, and
rEngine's own draw list moved onto it. Then GL, Vulkan and Metal can be compared here, pixel for
pixel, through one set of call sites — which is exactly D14c's bet, tested before a game adopts
rather than after.

KI-082's knot dissolves without amending anything: F123's eighth criterion can be met in full.

## The measurements the API additions rest on

Two independent consumers, neither of them hypothetical.

**vtmb-vr's renderer**, every GL call its seam cannot express:

| cluster | calls |
| --- | --- |
| framebuffers and renderbuffers | **~140** (`glBindFramebuffer` 63, `glDeleteFramebuffers` 21, `glGenFramebuffers` 13, `glFramebufferTexture2D` 13, `glCheckFramebufferStatus` 13, renderbuffers 13) |
| querying ambient state to save and restore it | 29 (`glGetIntegerv` 19, `glIsEnabled` 7, `glGetBooleanv` 3) |
| pipeline state outside the small set | 25 (`glDepthFunc` 14, `glColorMask` 8, `glPolygonOffset` 3) |

**rEngine's own 2D draw-list backend**, what it uses that the seam lacks: `glScissor`,
`glTexSubImage2D`, `glBlendFuncSeparate`, `glUniform2f`, `glReadPixels`, `glFlush`.

And the check that says the seam is not simply incomplete: **the thirteen files already behind
vtmb-vr's seam contain zero raw GL calls.** D14's *"renderer code talks to this, never to GL
directly"* holds exactly for what it serves. The gap is in what it does not serve yet, and the gap is
dominated by one thing.

**Render targets are the addition.** Both consumers need it, by a wide margin, and neither can be
served without it. That is the difference between designing an API here and guessing one: two
codebases that have never coordinated arrive at the same missing call.

## What the seam grows

Each addition is justified by a measured call site on at least one side, and none is speculative.

| Addition | Why | GL | Vulkan | Metal |
| --- | --- | --- | --- | --- |
| **render target** — made from colour and depth textures the host owns, bound and unbound | ~140 calls in VtMB; the off-screen pass in the scene example | FBO | image views + dynamic rendering | `MTLRenderPassDescriptor` |
| **frame begin/end** | Vulkan needs a command buffer to record into and a submit; GL and Metal need the bracket too | a no-op plus `glFlush` | begin/end command buffer, submit | command buffer + encoder |
| **scissor** | microui clips every panel; VtMB uses it too | `glScissor` | `vkCmdSetScissor` (dynamic) | `setScissorRect` |
| **texture sub-upload** | the glyph atlas writes one rectangle per glyph | `glTexSubImage2D` | staging buffer + `vkCmdCopyBufferToImage` | `replaceRegion` |
| **separate alpha blend** | rEngine's draw list premultiplies | `glBlendFuncSeparate` | pipeline colour blend state | attachment blend state |
| **`vec2` uniform** | `u_size` in the draw list; 6 calls in VtMB | `glUniform2f` | push-constant offset | buffer offset |
| **depth compare function** | 14 calls in VtMB | `glDepthFunc` | pipeline depth state | depth-stencil state |

### The frame takes its target — found by the test, not by design

The first cut let a zero render target mean "the default framebuffer", which is what OpenGL calls
framebuffer 0. The pixel test failed immediately and for the right reason: it renders into its own
framebuffer, so "the default" was a 1×1 hidden window and everything after the first off-screen pass
read nothing.

**Vulkan has no default framebuffer at all.** There is no object to fall back on — the image a frame
draws into is the host's, chosen per frame, and on a desktop it is whichever swapchain image came
free. So the frame takes its target: `re_seam_frame_begin(seam, target)`, and a zero target inside
the frame means *back to the frame's target*, not *the window*.

That forces one escape hatch, `re_seam_target_adopt`, taking the host's own handle — a framebuffer
name on OpenGL, a `VkImageView` on Vulkan, an `id<MTLTexture>` on Metal. It is the single place the
seam is not API-neutral, and it is unavoidable: a window's back buffer belongs to the host, the seam
creates no swapchain, and every API names that image differently. The device layer has the same
hatch for the same reason — `re_gpu_instance` hands back a `VkInstance`.

This is the API question spec 123 said would be guessed if written without call sites. It was not
guessed; it was failed into, in about a minute, by a test that renders somewhere other than a window.

**Read-back is not added.** `glReadPixels` is how the snapshot path captures a frame, and a capture
is the host's business in the same way the window is — the scene example reads its own target, as
`gpu_seam_test.c` already does. Adding it would put a synchronisation point inside a seam whose whole
value is that the frame path is thin.

## Shaders: one source, three dialects, no new toolchain

The descriptor spec 123 introduced already answers this. `ReSeamShader` carries GLSL and SPIR-V;
Metal adds MSL. All three come from one pipeline that vtmb-vr already runs:

```
  shader.vert ──glslang──▶ SPIR-V ──┬──────────────────────▶ Vulkan
                                    ├─SPIRV-Cross──▶ GLSL ──▶ OpenGL / GLES
                                    └─SPIRV-Cross──▶ MSL  ──▶ Metal
```

VtMB's `cmake/shaders.cmake` already does the first two legs and discards the SPIR-V. Metal is one
more `spirv-cross --msl` invocation. No runtime compiler, no new dependency, and call sites still
name one symbol per stage.

## SDL_Renderer: what "retire" means, and the oracle problem

The owner asked to retire plain SDL. **The charter already decided this** — D49, written on
2026-09-09: *"`SDL_Renderer` stays the reference oracle (D29) and stops being a shipping path."* So
retiring it means removing it as a `--renderer` choice, which is that decision carried out.

But there is a consequence worth stating rather than discovering. `native-render.spec.mjs` compares
every backend **against SDL_Renderer**, and SDL is the only path that shares no code with the others.
Once GL, Vulkan and Metal all run through one seam, a seam defect that moves pixels identically in
all three is invisible to cross-comparison. Losing SDL as a live oracle loses the only independent
witness.

The answer is the one vtmb-vr already uses: **a reference-image gate.** Capture the reference from
today's SDL path before it stops shipping, commit those images, and the comparison becomes "every
backend still matches what was recorded" — an oracle that is data rather than a code path, and that
cannot drift along with the code it judges. SDL_Renderer then leaves the shipping renderer list
without taking the witness with it.

## The work, as features

```
F129  the seam grows render targets, frames, scissor, sub-upload and the state above   (rEngine) DONE
F132  the scene example: procedural by default, --scene for a real model               (rEngine) DONE
F130  the seam's Vulkan backend, judged against GL on the example's pixels             (rEngine) DONE
F131  the seam's Metal backend, judged the same way                                    (rEngine) DONE
F133  rEngine's draw list moves onto the seam; SDL_Renderer stops shipping and its
      frames become the committed reference                                            (rEngine)
```

The example comes before the Vulkan and Metal backends deliberately: it is the consumer whose call
sites shape the render-target API and whose pixels judge the backends. A backend written first would
be judged by compiling, which is the standard spec 122 refused.

## The scene

**Procedural, committed as code, is what every gate renders.** `AGENTS.md` forbids hidden downloads
and F123's sixth criterion says a consumer's build downloads nothing; a comparison that needs an
80 MB fetch fails on an aeroplane and cannot be a gate. The procedural scene is built to exercise
what the backends actually differ on — many draws with state changes between them, depth test and
write toggled, back-face culling on and off, several programs, textures at both filters and both
wraps, an off-screen pass sampled by a later draw, and an alpha-blended overlay.

**Sponza is for humans.** `packs/gpu/examples/scene/fetch-sponza.sh` fetches Crytek Sponza (Frank
Meinl, Crytek; republished by Morgan McGuire's Computer Graphics Archive; CC BY 3.0) — 80 MB, 21 MB
of OBJ, 393 materials, 54 textures — verified against a recorded SHA-256, unpacked **outside** the
repository, and refused if `--dest` points inside it. Nothing in the build or the suite references
it. It exists so the example can render a scene whose frame times mean something next to other
renderers' published numbers, which is why the owner named ForwardPlus_Vulkan: that project's
screenshots are this model.

A minimal OBJ reader in C comes with the example. `tinyobjloader` is C++ and would be a vendored
dependency for a feature no gate uses; positions, normals, uvs and material groups are a few hundred
lines.


## F129's evidence

Every addition is observable in rendered pixels through a real GL 4.1 driver, and **ten sabotages
were each observed failing on the assertion that owns the claim**:

| Sabotage | Observed |
| --- | --- |
| the scissor rectangle is ignored | `and stopped at its edge` |
| scissor never turns off | `a negative rectangle turns clipping off, and the next clear reaches both halves` |
| a sub-upload rewrites the whole texture | `and left the one it did not name` |
| binding a target renders to the default framebuffer anyway | `the pass rendered into the target and a later draw read it` |
| a zero target means the window rather than the frame's target | the same assertion — the later draw lands on a 1×1 window |
| a target ignores its depth attachment | `LESS rejects a fragment at the same depth` |
| the depth compare function is always LESS | `EQUAL accepts it` |
| separate blending uses one mode for both channels | `while the alpha channel accumulated` |
| an unbalanced frame is not reported | `an unbalanced frame is named, not ignored` |
| a depth attachment is made with a colour format | `a target made from the host's textures` |

**One of those assertions was blind when written, and the pass caught it.** *"A negative rectangle
turns clipping off"* cleared black onto an already-black right half, so it passed with clipping still
enabled — the failure only surfaced two assertions later, against something else. It now clears a
colour that is not already there and checks both halves. That is the second time in this pack's
history that the sabotage pass found a test asserting nothing; the first was the filter and wrap
checks in spec 123.

Two arithmetic corrections worth recording rather than hiding: the separate-alpha assertion was
written as "alpha above 200" from intuition, and the real values are 191 for accumulated alpha
against 127 for a single blend mode — so the test now states both and asserts the measured one. An
expectation nobody computed is not a measurement.


## F132's evidence

`packs/gpu/examples/scene` renders through the seam and nothing else: 14 parts, three programs, two
textures at both filters and both wraps, depth and culling toggled per part, an overhead pass into an
off-screen target that a later draw samples into the corner, and a blended overlay last. A project
outside this repository builds it from the pack and runs it; the pack itself builds it only when the
pack is the top-level project, so a consumer still receives the library and nothing else.

**With the optional model:** Crytek Sponza loads as **786,801 vertices in 393 parts** — 393 draws
with per-draw state, which is the per-draw stress a Vulkan backend has to survive, and far more of it
than the built-in scene alone would give.

Five sabotages, each observed failing on the assertion that owns it:

| Sabotage | Observed |
| --- | --- |
| the off-screen pass renders to the frame's target instead | `the off-screen pass reached its inset (luma 0.0 at 1150,60)` |
| the overlay is drawn opaque | `and it is blended rather than opaque (green 191, unblended would be 191)` |
| the overlay is not drawn at all | `the overlay band is present (blue 14 over 23)` |
| the scene stops advancing with the frame number | `frame 20 and frame 60 are different images` |
| the render is not reproducible between runs | `the same frame number renders the same bytes` |

Two of those sabotages did not work on the first attempt, and neither was a gap in the test. Freezing
`t` in `scene_draw` left `box_transform` computing its own, so the boxes still moved; and an unseeded
`rand()` returns the same sequence in every process, so two runs still matched. A sabotage that does
not do what it claims produces a false "not caught", which is the same lie in the other direction.

### Three defects the pictures found that no assertion would have

Each one rendered without an error and looked plausible until the image was actually examined.

**A backdrop animating.** `draw_parts` decided which parts move by testing `part->tint[2] < 0.35f`,
and the sky box's blue channel is 0.28. So the backdrop took the spinning-box transform and swung
through the scene, hiding the floor from the overhead pass. Parts now carry an `animate` flag.
Recovering an intent by sniffing a value that data could have carried is exactly how that happens.

**A depth clear that did nothing.** The frame ends with depth writes off for the blended overlay, so
from frame one the next frame's `clear(..., depth: true)` was a no-op — GL masks a depth clear by the
depth write mask, which the seam documents and preserves deliberately, quoting VtMB: *"a call site
that clears depth sets the write itself."* The overhead camera is static, so its floor then failed
`LESS` against its own stale depth while the moving boxes sometimes passed. It looked exactly like a
broken render target. The seam was right and the call site was wrong.

**A camera fitted to the wrong thing.** Fitting the orbit to the geometry's bounding sphere put the
camera outside the ±20 backdrop, looking at its back — a black frame. Backdrops now carry a flag
excluding them from the bounds, because "which geometry is the subject" is data, not a rule.

Framing itself is now the caller's: `--orbit` and `--eye`, in multiples of the fitted radius. One
heuristic cannot frame both a six-unit scene and a building you want to stand inside, and Sponza
wants about `--orbit 0.22 --eye 0.03`.


## The example's shaders, and a build step that failed silently

F130 and F131 need the example's shaders in three forms, and spec 123 already said where they come
from: one source, compiled by the build, carried by `ReSeamShader`. `shaders/generate.py` does it —
OpenGL 3.30 source and Vulkan SPIR-V from each `.glsl`, committed into `scene_shaders.h`, with a
source hash so the binary cannot drift from its source. `glslc` is needed to regenerate, never to
build, which is the rule `tools/shaders.py` already follows for the desktop.

**The first version expressed the dialect difference with a function-like GLSL macro** taking the
whole uniform list as one argument. The GLSL preprocessor does not accept a macro invocation spanning
lines. It expanded to **nothing**; the shaders compiled, linked, and reported no error; every uniform
location came back `-1`; and writing to `-1` is silently ignored by every graphics API. The scene
rendered black with nothing anywhere saying why.

Two changes came out of it, and the second matters more than the first:

- The uniforms are declared once in a comment block that only the generator reads, and **the
  generator writes the dialect**. A build step that cannot fail loudly is worse than one that cannot
  do the job, and dialect work belongs in the build rather than in a preprocessor that is allowed to
  quietly disagree.
- **The scene now refuses to start when a uniform it needs is missing.** That check would have turned
  a black frame into one sentence naming the uniform, and it costs ten lines.

### And the lighting had never worked

Switching to generated shaders changed every pixel in the frame. The inline version declared
`uniform vec3 u_light` while the scene set it with a four-float call; GL rejects the type mismatch,
so the light stayed at zero, `normalize(0,0,0)` gave no contribution, and everything rendered at the
0.35 ambient term. It looked like a dim scene, which is a thing scenes are allowed to be — so nothing
about it read as wrong until a change that should have been inert moved 921,600 pixels.

A test assertion was measuring the same thing badly: the overlay band was checked by absolute
brightness against the area above it, which broke the moment the lighting was fixed. It now measures
the band's **hue** — blue runs about 100 above red inside the band and 14 above it outside — because
that is what "the cyan overlay is present" actually means, and it does not move when something
unrelated gets brighter.


## F130: the D14c verdict

**The bet holds.** The scene example renders through a Vulkan backend with **no change to `scene.c`
at all** — a test asserts it calls no graphics API and includes no graphics header — and the two
backends produce the same frame:

| | differing pixels | outside a 2px edge band | validation messages |
| --- | --- | --- | --- |
| built-in scene, 14 draws | **2** of 921,600 | **0** | **0** |
| Crytek Sponza, 393 draws | **61** of 921,600 | **0** | **0** |

Every difference is a rasterisation tie at a shared edge, which is the same tolerance this repository
already applies to its own backends. So resource+draw granularity *can* carry Vulkan with command
buffers, render passes, barriers and pipelines built inside the backend. D14c was right, and it is no
longer a bet.

### How the three hard parts were answered

- **Uniforms by name.** The backend reflects each program's SPIR-V for member names and std140
  offsets, so `uniformLocation("u_model")` answers with a byte offset and `setUniform` writes into a
  CPU-side block flushed to a ring buffer per draw. A consumer's shader build changes in exactly one
  way: **it keeps the SPIR-V it already produces and throws away.**
- **Pipeline state.** Blend, depth, cull, primitive and vertex layout are recorded and resolved at
  draw time into a cached pipeline. The whole of the coalescing is one file, `gpu_seam_vk_draw.c`, so
  its cost can be read at a glance.
- **Render passes.** Dynamic rendering, which the device layer already required as a floor.

### What the sabotage pass and the validation layers found

Nine sabotages, each observed failing:

| Sabotage | Caught by |
| --- | --- |
| the pipeline ignores the blend state | pixels outside the edge band |
| the depth compare function is always LESS | the decal's second pass vanishes |
| the pipeline always culls back faces | the backdrop vanishes |
| the pipeline never culls | pixels outside the edge band |
| the front face is not adjusted for Vulkan's Y axis | geometry inverts |
| every draw shares one uniform slot | every draw takes the last one's uniforms |
| the viewport is flipped, as it was at first | the off-screen inset inverts |
| a depth clear ignores the write mask | the masked clear takes effect |
| textures lose TRANSFER_SRC | **3 validation messages** |

**Three of those were not caught at first, and each was a real gap rather than a flaky test.** The
scene never used a depth compare other than LESS, never drew anything whose back faces were visible,
and always enabled depth writes before clearing — so three of the seam's own additions were
uncovered by the comparison that was supposed to judge them. The scene gained a decal drawn twice,
and the OpenGL pixel test gained a masked-clear assertion.

**And the first decal was a z-fighting test in disguise.** Laid exactly on the floor and relying on
LESS_EQUAL to win a tie, it put 4,737 pixels between the backends with 133 outside the edge band —
because the two planes come from different geometry and their interpolated depths differ in the last
bits. It was testing floating point. Priming depth from the *same* geometry makes the compare
decisive and the result identical on both.

### Two things the validation layers caught that nothing else would

`TRANSFER_SRC` missing from the seam's images, so a host could not copy out of an image the seam had
handed it — the very thing `re_seam_texture_handle` exists to allow. It worked on this driver and
would not have elsewhere.

### The y-axis decision, which is the one a consumer inherits

OpenGL stores NDC −1 in row 0; Vulkan's framebuffer row 0 is the top of the screen. The usual fix is
a negative-height viewport, which is what this backend did first — and it made the main pass match
exactly while inverting **every render-to-texture**, because the flip puts NDC −1 in the last row
where OpenGL puts it in the first. The example's off-screen inset was the only part of the frame that
disagreed, which is how it was found.

There is no flip now. Both APIs store NDC −1 in row 0, so a texture rendered into and then sampled
means the same thing on both, and a read-back needs no correction. The cost is the presented window:
a swapchain image drawn this way is upside down, and a windowed Vulkan host must flip for its own
final pass. That is the right place for it — presentation belongs to whoever owns the swapchain,
which the seam deliberately is not — and it keeps the property a call site actually depends on.

### Frame time, measured so the two numbers mean the same thing

| scene | OpenGL | Vulkan |
| --- | --- | --- |
| built-in, 14 draws | 0.281 ms/frame | 1.010 ms/frame |
| Sponza, 393 draws | 1.321 ms/frame | 2.512 ms/frame |

**These are totals across the run, not per-frame medians, and the difference matters.** The OpenGL
backend's frame ends with a flush and returns while the GPU is still working; the Vulkan backend's
submits and waits. Comparing what the call site waited for would report a difference in
synchronisation as a difference in speed — the medians are 0.09 ms against 0.91 ms, which says
almost nothing. The totals end with a read-back that forces both to finish.

Vulkan is slower here, and the ratio **narrows as draws rise** — 3.6× at 14 draws, 1.9× at 393 —
which is the signature of a fixed per-frame cost rather than a per-draw one. The named causes are all
deliberate simplifications recorded at the top of `gpu_seam_vk.c`: one frame in flight with a full
queue wait, a descriptor set allocated per draw, host-visible vertex buffers, and every image in
`VK_IMAGE_LAYOUT_GENERAL`. None of them is about the seam's shape, which is what this feature was
asked to test; all of them are what a production backend does differently, and F131 and F133 will say
whether they need to change before a game adopts.


## F131: three backends, one frame

| | differs from OpenGL | outside a 2px edge band | ms/frame |
| --- | --- | --- | --- |
| OpenGL (the reference, D51) | — | — | 0.306 |
| Vulkan | **2** of 921,600 | **0** | 0.931 |
| Metal | **2** of 921,600 | **0** | 0.923 |

`scene.c` is the same source all three compile, and the spec asserts it calls no graphics API and
includes no graphics header. One authored shader reaches all three through glslang and SPIRV-Cross,
with no runtime compiler anywhere.

### One reflection serves Vulkan and Metal

SPIRV-Cross preserves a std140 block's memory layout when it emits MSL — `float4x4` at 64 bytes,
`float4` at 16 — so the offsets reflected once out of the SPIR-V are the offsets a Metal buffer
wants. The reflector is therefore not named for Vulkan and lives in `gpu_seam_spirv.c`. Set 0
binding 0 becomes `[[buffer(0)]]`; binding *n* becomes `[[texture(n-1)]]`.

### The Y axis, for the third time — and the three answers are all different

This is the part a consumer inherits, and it is worth stating once in full:

| | clip space | framebuffer row 0 | so NDC −1 lands in | what the seam does |
| --- | --- | --- | --- | --- |
| OpenGL | +Y up | bottom | row 0 | nothing |
| Vulkan | **+Y down** | top | row 0 | nothing — it already agrees |
| Metal | +Y up | top | the **last** row | flips, in the shader |

Vulkan needs no flip *because two differences cancel*, which is why the negative-height viewport that
seemed obvious was wrong there. Metal has only one of those differences, so it needs a flip and has
no negative viewport height to do it with — `spirv-cross --flip-vert-y` negates `gl_Position.y` in
the generated MSL instead. The flip is in the build, costs nothing at run time, and no call site can
see it.

### Sabotages

Seven, five caught by the comparison: the front face unadjusted for Metal's Y axis, the cull mode
ignored, the depth compare always LESS, blending never enabled, and every draw sharing one uniform
slot. Two were not, and both are honest limits rather than flaky tests:

**A depth clear that ignores the write mask.** The masking rule cannot be exercised by a scene at
all, and finding out why is worth more than the test would have been: `re_seam_clear` always clears
colour, so a scene that clears depth with writes off destroys the very frame it is being compared on.
Tried, reverted, and the observation recorded on the API — vtmb-vr's seam has no depth-only clear
either, and the right time to add one is when a call site wants it rather than when a test does. The
rule is verified on OpenGL by the pack's pixel test and carried by construction on the other two.

**A frame that never synchronises its managed target.** Undetectable on Apple Silicon, where unified
memory makes a managed texture readable without the blit. It would matter on a discrete GPU, and the
blit stays for that reason; this machine cannot be the evidence.

### What Metal cost, and what it did not

The backend is 800 lines against the Vulkan backend's 990, and the difference is where you would
expect: no instance, no physical-device selection, no descriptor sets, no explicit image layouts or
barriers. What it added is one genuine structural difference, stated at the top of the file: **Metal
has no mid-pass clear**, because a clear is a load action chosen when an encoder begins. So
`re_seam_clear` ends the encoder and begins another — which is what Metal applications do, and which
carries one consequence a call site could see: a clear is not clipped by the scissor here. Nothing in
this repository clears inside a scissor; something that did would differ, and that is written down
rather than discovered.
