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


## F133, first step: the oracle, captured before the path that served it retires

D54's ordering is the whole point, so it was done first: **the reference frames were captured from
SDL_Renderer while it is still a shipping path.** Doing it afterwards would have meant recording
whatever the seam produced and calling it correct.

`orchestrator/tests/references/render-{workspace,terminal,primitives}.png` — 432 KiB for all three at
2560x1600, because 16 MiB of BMP each cannot live in a repository two games pin as a submodule.
`render_compare.py` gained a PNG reader (zlib plus the five PNG filters, about fifty lines, standard
library only) and `native-render.spec.mjs` now judges every backend against them.

Every backend matches: 392, 436 and 32,195 differing pixels on the three scenes, **none outside the
2px edge band**, and SDL matches its own recording exactly at zero.

### The sabotage that justifies the whole exercise

Charter D54 predicted that retiring SDL_Renderer would retire the only independent witness, because
once every backend renders through one seam a defect in that seam moves all of them together. That is
not a guess any more. Nudging one shared colour — `--re-gray-1`, the window clear — and rebuilding:

| gate | what it saw |
| --- | --- |
| cross-backend, OpenGL vs Metal vs Vulkan | **0 failures** — all three moved identically |
| the live SDL oracle | **0 failures** — SDL moved too |
| **the committed reference frames** | **2,467,394 pixels** outside the edge band on one scene alone |

A defect that moves everything at once is invisible to every comparison that shares the code, and
visible immediately to one that does not. The witness had to become data, and now it is.

### A second API gap, found the same way the first one was

Writing the draw list against the seam surfaced it before a line of the migration was finished:
**rEngine's UI vertex packs its colour as four bytes, and the seam's vertex layout could only
describe floats.** VtMB's note said a type enum before a second type exists would be speculative, and
that was right — until the second type turned up. Twelve bytes per vertex on a 65,536-vertex batch is
768 KiB a frame, so a UI renderer cannot adopt the seam without it.

`ReSeamVertexAttribute` gained a `type`, defaulting to float so every existing call site means what
it meant. All three backends implement it — `GL_UNSIGNED_BYTE` normalised, `VK_FORMAT_R8G8B8A8_UNORM`,
`MTLVertexFormatUChar4Normalized` — and the scene example now carries a packed per-vertex colour, so
three drivers agree it works rather than three implementations merely existing. Three sabotages, each
caught: reading the bytes unnormalised on OpenGL saturates every surface to white, and reading them
as floats on either of the others garbles the vertex stream.

The comparison after it: Vulkan differs from OpenGL in **1** pixel, Metal in **5**, none outside the
edge band.

### A third finding: the desktop already maintains its shader three times by hand

Measured while planning the port, and it strengthens the case for doing it:

| copy | form | where |
| --- | --- | --- |
| `backend_gl.c` | GLSL 3.30, inline | `vertex_source` / `fragment_source` |
| `shaders/ui.{vert,frag}` | GLSL, compiled to SPIR-V by `tools/shaders.py` | for the Vulkan backend |
| `backend_metal.m` | MSL, inline, translated by hand | `shader_source` |

All three implement the same five signed-distance modes, and they currently **agree** — the box
function, the corner selection, the ring's inner and outer clamps, the coverage and RGBA sampling are
the same expressions in three languages. Agreement maintained by hand is a risk that has not fired
yet, not an absence of risk: a fix to the ring's inner radius has to be made three times, in three
dialects, and nothing fails if it is made twice.

The pack's generator already turns one source into all three forms. Collapsing these into it is part
of the migration and worth doing for its own sake.

### What F133 still owes

The migration itself: rEngine's draw list rendering through the seam, and SDL_Renderer removed from
the selectable renderers. One design question has to be answered first and it is the owner's, because
it changes how the desktop is built and tested:

**The seam's backend is chosen at compile time (D14b/D51), and rEngine's desktop chooses its renderer
at run time (`--renderer opengl|metal|vulkan|sdl`).** Those cannot both survive the migration. Either
the desktop ships one binary per backend — which is what D51 intends for a game, and which means
`native-render.spec.mjs` builds three desktops instead of running one three times — or the desktop
keeps its own runtime-dispatched backends and gains the seam as a fourth, which leaves two OpenGL
paths in the tree and only half-proves the point.

The recommendation is the first: it is what D51 already decided for the consumers this pack exists to
serve, and the reference frames make a per-binary comparison as trustworthy as the runtime one was.
The cost is a longer desktop build in the suite, and it is worth stating before it is paid.


## F133, second step: one shader, and a third API gap

**The draw list's shader is now one source.** `shaders/ui.glsl` produces OpenGL 3.30, Vulkan SPIR-V
and Metal MSL into a committed `ui_shaders.h`, with a source hash so the header cannot drift from it.

Reading the three copies side by side to write it found more drift than the earlier count suggested.
They agreed on the signed-distance maths, and **disagreed about their own interfaces**:

| | attribute order | Y |
| --- | --- | --- |
| `backend_gl.c` | pos, uv, color, shape, radii, extra | `1.0 - y/h*2` |
| `shaders/ui.vert` | **shape, radii, pos, uv, extra, color** | `y/h*2 - 1` |
| `backend_metal.m` | shape, radii first, for 16-byte alignment | its own |

One layout now, and one Y — the OpenGL formula, everywhere, because the seam's backends already
store NDC −1 in row 0 on every API.

> **Corrected on 2026-09-11 — the Y half of this is wrong.** Storing NDC −1 in row 0 is a promise
> about memory and it holds; it does not settle which way is up on a *window*, whose image has a
> different memory orientation per API. One formula cannot serve OpenGL and Vulkan at once, and the
> three backends' differing expressions were not drift. See *"The correction: the per-API Y was not
> drift"* below. The attribute-layout half of this paragraph stands. The generated GLSL was checked by building a program on a real
GL driver, not by `glslc`: glslc always emits SPIR-V and so demands explicit locations and uniform
bindings that a GL 3.30 driver does not.

### A third gap the port found: the glyph atlas is one channel

`backend_gl.c` keeps coverage in a `GL_RED` page, and the seam had only RGBA. A 2048-square atlas is
**4 MiB at one byte a pixel and 16 MiB at four**, and vtmb-vr's font page pays the four today because
nothing offered it anything else.

`RE_SEAM_TEXTURE_COVERAGE` is the third addition this migration has produced, after the render target
and the packed-byte attribute — and like both of those it was found by writing a real consumer rather
than by imagining one. The OpenGL backend asks GL for the texture's own format at upload time rather
than keeping a table or growing the handle vtmb-vr's call sites carry; Vulkan and Metal already had
slot tables to record it in.

Two sabotages. Uploading a coverage page four bytes to the pixel is caught by the channel that comes
back — *"the single channel was read as coverage, not as one pixel of an RGBA page"*. Making the page
RGBA internally is **not**, and honestly cannot be: GL expands R to (r, 0, 0, 1), `.r` survives, and
the pixels are identical. What that sabotage costs is memory, which no pixel test can see — the same
category as the buffer usage hint spec 123 already records as untestable.

### The transition is checked, not trusted

`ui.vert` and `ui.frag` still feed `backend_vk.c` through `ui_spv.h` until `backend_seam.c` replaces
it. Leaving that pair unchecked while the new source is checked would have created, for the length of
the transition, exactly the drift this change removes — so `shaders.py check` verifies both, and says
so, until the old ones are deleted with the backend that reads them.


## F133, third step: the draw list renders through the seam, and is judged by the oracle

`backend_seam.c` is rEngine's draw list on the pack. It is **342 lines against `backend_gl.c`'s 520,
`backend_metal.m`'s 690 and `backend_vk.c`'s 703** — and it names no graphics API at all. The pieces
that used to be three near-copies (the vertex struct, the atlas, the shape and gradient emitters, the
glyph path, the clip handling) are now one, and the API-specific half that is left went into
`seam_host_gl.c`: the context, the drawable size, present, and the readback the snapshot needs.

That split is now stated in the build gate rather than reviewed. `design.py`'s render-layering rule
allowed graphics-API symbols in `render/backend_*.c` only; it now also allows `render/seam_host_*.c`,
because a seam host is the same layer a backend was — while `backend_seam.c` itself, which draws, sits
under the rule and mentions no API. The rule was confirmed still to catch a leak above the line.

### What the recorded frames say

`native-render.spec.mjs` names `seam` alongside `opengl`, `metal` and `vulkan` for the length of the
transition, so every gate the three hand-written backends pass is applied to the new path **before**
any of them is deleted — the recorded frames, the live SDL comparison, cross-backend comparison, the
frame ceiling and the memory budget.

| scene | against the recorded frame | outside the 2px band | vs. opengl / metal / vulkan |
| --- | --- | --- | --- |
| workspace | 392 of 4,096,000 px (0.0096%) | **0** | **0 pixels differ** |
| terminal | 436 px (0.011%) | **0** | **0 pixels differ** |
| primitives | 32,195 px (0.79%) | **0** | **0 pixels differ** |

The differing counts are *identical* to the three existing backends', which is the strong statement
here: the seam path is byte-for-byte the same frame as each of them, and the residual against the
recorded PNG is the anti-aliasing difference every GPU backend already carried against SDL.

Frame medians 0.476 / 0.614 / 0.655 ms against the 8 ms ceiling — between OpenGL's and Metal's, as a
path that renders through OpenGL should be. Resident memory 185,824 KiB, 13,728 above SDL's, inside
the 32 MiB budget. Vulkan's validation run stayed at 0 messages.

### Sabotages

The gate is only worth its runtime if it fails for its own reason, and it does — each of these turned
the `seam` row red on the recorded-frame assertion while the other three backends stayed green:

| Sabotage | Observed |
| --- | --- |
| the scissor never narrows | 129 differing pixels outside the 2px band |
| the scissor origin read as top-left | 212,381 outside the band, fraction 0.065 |
| the glyph's coverage never reaches the atlas | fraction 0.01002 exceeds 0.001 |

The third is worth naming. Text vanishing entirely left **0 pixels outside the edge band** — every
glyph is thin enough that its interior is within two pixels of an edge — so the band rule alone would
have called a frame with no text in it a pass. The differing-fraction rule is what caught it. Both
halves of the tolerance are load-bearing, and this is the case that shows it.

### The generated header, and a C limit worth recording

`ui_shaders.h` emits each dialect as a brace-initialised `char[]`, not a string literal. C99 only
guarantees 4,095 characters for a string literal **and applies the limit to the concatenation**, so
splitting one across adjacent literals — the obvious first fix — does not help. SPIRV-Cross writes a
whole MSL body on one line, 4,898 characters for the fragment stage, and `-Wpedantic` said so on every
build. The SPIR-V words beside it were already emitted as a brace list; the strings now match.

### What F133 still owes, after this step

`seam_host_vk.c` and `seam_host_metal.m` — the swapchain being most of `backend_vk.c`'s remaining
weight — then the three prefixed seam copies and the dispatch table that keeps `--renderer` a runtime
switch (spec 126 decision 3, which supersedes the per-binary recommendation recorded above: the owner
confirmed prefixed copies so one desktop build still serves the suite). Only then do `backend_gl.c`,
`backend_metal.m`, `backend_vk.c`, `backend_sdl.c`, `ui.vert`, `ui.frag` and `ui_spv.h` go, and
`seam` stops being a `--renderer` value of its own.


## F133, fourth step: two copies in one binary, and the three defects that found

`--renderer` stays a runtime switch (spec 126 decision 3), so one binary holds more than one seam —
and the seam's public symbols exist once per copy. **The pack learned to make prefixed copies**, which
is where the capability belongs: a consumer sets `RENGINE_GPU_TARGET_NAME`, `RENGINE_GPU_SEAM_BACKEND`
and `RENGINE_GPU_FORCE_INCLUDE` and adds the directory again with its own binary directory. The
force-included header is applied `PUBLIC`, so whatever links that copy is compiled against the same
names and needs no knowledge of the scheme. The pack's sources are untouched and a game, which ships
one backend, sets none of it.

`tools/seam_prefix.py` derives the rename — 67 symbols — from the pack's own headers plus rEngine's
two halves, rather than from a list maintained beside them. `init.sh` checks the generated headers
still match their sources.

### The guard that mattered more than the generator

A derivation can go stale, and a missed symbol **does not fail the link**: the linker takes the first
definition and two renderers quietly share one backend's function. So the archives are asked directly
after every build. `tools/seam_symbols.py` runs as a POST_BUILD step on each copy and requires every
exported `re_*` symbol to carry that copy's prefix.

It asks about `re_` rather than about the five families the rename covers, and the reason is the first
version of this file: it matched `re_seam_`, `re_gpu_` and friends — which a *correctly* renamed
`re_metal_seam_open` does not start with — so it examined **zero symbols and reported both copies
clean**. It now also fails when it examines nothing, because a check that looked at nothing has not
found nothing wrong. 65 and 66 symbols are what it actually checks.

### Three defects, all found by the second consumer

The Metal copy's first frame was wrong three separate ways. None of them could have been found by
reading, and none would have been found by a fourth backend written the same way as the first three.

**One: the draw list's MSL was flipped.** `tools/shaders.py` passed `--flip-vert-y`, copied from the
pack example's generator where it is right. A flip makes an OFF-SCREEN image come out the same way up
on every API, because there "the same way up" is a question about memory. This shader draws to the
WINDOW, where the question is what the viewer sees — and NDC +1 is the top of the image on OpenGL and
Metal alike. With the flip, the toolbar rendered along the bottom edge. The OpenGL host's snapshot
still flips, because `glReadPixels` is specified bottom-up; that is a read-back concern and it stayed
in the host.

**Two: `re_seam_scissor` and `re_seam_viewport` had no defined origin, and the three backends
disagreed.** Vulkan's `VkRect2D` and Metal's `MTLScissorRect` are measured from the top; OpenGL's are
measured from the bottom; the seam handed each API the caller's numbers unchanged. Every caller in the
repository happened to clip either the full height or nothing — `gpu_seam_test.c` clips the left half
at full height, the example only ever sets a full-surface viewport — so **no test could tell**, and
`backend_seam.c` carried `backend_gl.c`'s bottom-left expression with a comment claiming the seam had
made the origin uniform. It had not. The header now states top-left, matching
`re_seam_texture_update`; the OpenGL backend converts using the bound target's height; the other two
pass through as they always did. That the OpenGL copy stayed **byte-identical** across this change is
the evidence both halves were right: the seam gained a flip and the draw list lost one.

**Three: `re_seam_buffer_update` had no meaning for reuse inside a frame.** Metal and Vulkan both
`memcpy` into one buffer while the frame's draws are only *recorded*, so every draw in the frame reads
the **last** fill. OpenGL hides this — `glBufferData` orphans the storage and the driver renames it
underneath — and the pack's own example never noticed because it uploads its vertices once at setup.
Every batching 2D renderer hits it on the first frame: rEngine's draw list flushes on every clip
change, and the header itself says clipping is "per-control, not per-frame".

The Metal backend now does the renaming explicitly. Each update inside a frame takes the next
*generation* of its buffer, the counter resets at `frame_begin`, and `frame_end` waits — so
generations are reused every frame and the steady state allocates nothing. It is the same answer the
uniform ring beside it already used.

**Vulkan has the identical defect and is not fixed here**, because nothing in this repository exercises
it yet: the Vulkan seam is driven only by the example and the pixel test, both of which upload once.
It is KI-083, and F133's Vulkan host is the increment that can actually verify a fix.

### A fourth, found by reading the first three

`re_seam_target_adopt` on Metal wraps the host's image in a texture slot of its own making and retains
it; `re_seam_target_destroy` cleared only the target slot. A host that acquires a drawable per frame —
which is what a swapchain *is* — exhausts all 256 texture slots in four seconds and retains every
drawable it ever saw. The OpenGL host never showed this because framebuffer zero is a constant it
adopts once, and `adopt` allocates nothing at all on that backend.

Destroy now gives back everything adopt allocated and nothing the caller owns, and the header says so.
The three backends' adopt/destroy pairs had drifted the same way the scissor had, and for the same
reason: only one of them had ever had a real host.

### What the recorded frames say, with five GPU backends in the suite

| scene | every one of the five | outside the 2px band | each pair of the five |
| --- | --- | --- | --- |
| workspace | 392 px against the recorded frame | **0** | **0 pixels differ** |
| terminal | 436 px | **0** | **0 pixels differ** |
| primitives | 32,195 px | **0** | **0 pixels differ** |

Twenty-one cross-backend comparisons, all zero. `seam-metal` holds 146,288 KiB resident — *below*
SDL's 164,800 — and both copies sit under the 8 ms ceiling.

### Sabotages

| Sabotage | Observed |
| --- | --- |
| `--flip-vert-y` back on the draw list's MSL | `seam-metal`, 520,509 px outside the band |
| every in-frame buffer update takes generation 0 again | `seam-metal`, 1,393,629 px outside the band |
| `re_seam_target_destroy` keeps the slot `adopt` made | `native_seam_target`, *"adopt refused on round 256 of 2048"* |
| the OpenGL scissor conversion removed | `seam-opengl`, 212,381 px outside the band |

**The third one needed a test built for it, and that is the finding.** Run against the render suite,
the leak passed: three scenes at forty frames exhausts about half of the 256 texture slots, so a
defect that would kill a real window in four seconds is invisible in a captured frame. The suite was
measuring the wrong thing, not measuring it badly.

`packs/gpu/tests/gpu_seam_target_test.m` adopts and releases the host's image 2,048 times with no
window at all, and fails on round 256 naming the reason. It is checkable **only because rEngine now
links a prefixed copy per API** — the pack's own seam test builds against whichever single backend the
pack was configured with, and this is a question about one backend in particular. The prefix work paid
for itself before it shipped.


## F133, fifth step: the Vulkan host, and the Y story this spec had wrong

`seam_host_vk.c` is 410 lines and is the swapchain, nothing else: surface, formats, images, views,
acquire, the two layout transitions the seam will not make, present, and the read-back. It is still a
fifth of `backend_vk.c`, which had to carry a renderer as well.

**Synchronisation is CPU-side on purpose.** `re_seam_frame_end` submits with no semaphores and waits
the queue idle — one frame in flight, which the seam documents as its model — so a host that acquired
with a semaphore would have nothing to hand it. Acquiring with a **fence** and waiting before the
frame is the same guarantee through the only channel the seam leaves open, and costs nothing the
seam's own wait did not already cost. The layout cycle is the host's for the same reason: the seam
keeps every image in `GENERAL` and never transitions one it did not create, so `UNDEFINED → GENERAL`
before the frame and `GENERAL → PRESENT_SRC` after it are written here.

### The format gap: a swapchain that could not be adopted at all

`re_seam_target_adopt` hardcoded `VK_FORMAT_R8G8B8A8_UNORM`, and the header called that a narrowing a
host could work around. It was not a narrowing. MoltenVK's surface offers BGRA8, BGRA8_SRGB and three
HDR formats and **no RGBA8 at all**, and with dynamic rendering a pipeline's colour format must match
its attachment's exactly — so on this platform adopting a swapchain image was impossible, which is
the entire point of the call.

`adopt` now takes the format in the API's own terms, alongside the handle it already took in the
API's own terms. OpenGL ignores it (a framebuffer name carries its attachments) and Metal ignores it
(an `id<MTLTexture>` answers for itself); Vulkan is the only backend that cannot recover it, because
a `VkImageView` cannot be asked.

### The correction: the per-API Y was not drift

**This spec said, when it consolidated three shaders into one, that the backends "disagreed about
their own interfaces" in attribute order and in Y, and that one Y — the OpenGL formula — would serve
everywhere. The attribute half was right. The Y half was wrong, and the Vulkan host is what proved
it.**

The seam promises NDC −1 lands in **row 0** of the target on every API. That is a promise about
*memory*, and it is the right one for a render target: it is what lets an image one backend rendered
be sampled by another. It says nothing about which way is up on a **window**, because a window's image
has a different memory orientation per API — OpenGL's default framebuffer has row 0 at the bottom, a
Vulkan swapchain image and a Metal drawable have it at the top. Under one Y formula the two cannot
both be visually correct, and they were not: the Vulkan copy drew the toolbar along the bottom edge.

So the draw list's top is NDC **+1** on OpenGL and NDC **−1** on Vulkan — and on Metal, whose MSL is
cross-compiled from the Vulkan SPIR-V and then flipped back by `--flip-vert-y`, which is what makes
Metal keep the seam's memory promise. `backend_gl.c` used `1 - y/h*2` and `ui.vert` used `y/h*2 - 1`,
and **they were both right**. `ui.glsl` now writes `NDC_Y(t)` and each dialect's preamble defines it.

**Why nothing caught this earlier is the part worth keeping.** The pack's example established
cross-backend parity by reading each backend's frame back and comparing — and its OpenGL host and its
Vulkan host **both read pixels back without flipping**. That comparison is memory against memory. It
is a real result about the seam's memory promise and it was never a result about orientation on a
screen: no assertion in this repository had ever asked a viewer which way was up.

### KI-083, observed failing and then closed

The Vulkan seam's `re_seam_buffer_update` had the defect Metal's had — one buffer, `memcpy`ed into,
while the frame's draws are only recorded — and it was opened as KI-083 rather than fixed blind,
because nothing here exercised it and a fix could not have been watched going red. The Vulkan host is
that consumer. With the flip corrected and the format accepted, the frame came back with the toolbar
right way up and **most of its geometry replaced by the last batch's** — the same picture Metal had
shown. The Metal answer ported directly: a buffer generation per in-frame update, the counter reset at
`frame_begin`, reuse safe because `frame_end` waits.

### Validation, and proving the layers were listening

The new host writes its own barriers, its own layout transitions and its own present, so the render
spec now runs a validation capture for **every** Vulkan path, not just `backend_vk.c`'s.

A clean first run reported zero messages, which is the same reading a run with nothing listening
would give — `re_gpu_open` was being handed no `on_message` at all. Presenting straight from `GENERAL`
instead of `PRESENT_SRC` was used to tell the two apart, and the layers answered: *"images passed to
present must be in layout VK_IMAGE_LAYOUT_PRESENT_SRC_KHR … but VkImage 0"*. Six messages, then zero
again with the transition restored. The zero is a result now.

### Six GPU backends in the suite

| scene | all six, against the recorded frame | outside the 2px band | all 15 pairs |
| --- | --- | --- | --- |
| workspace | 392 px | **0** | **0 pixels differ** |
| terminal | 436 px | **0** | **0 pixels differ** |
| primitives | 32,195 px | **0** | **0 pixels differ** |

`vulkan` and `seam-vulkan` both report **0 validation messages**. Resident memory: `seam-opengl`
168,944 KiB, `seam-metal` 146,240, `seam-vulkan` 146,960, against SDL's 164,384 and a 32 MiB delta
budget.

**`seam-vulkan` is the slowest path in the suite** — 2.90 / 3.17 / 3.31 ms medians against the 8 ms
ceiling, roughly five times `backend_vk.c`'s. That is not mysterious and it is not the seam's drawing:
it is three submits-and-waits per frame where the old backend had one. The seam submits and waits at
`frame_end` by design (one frame in flight, no deletion queue), and the host adds a fence-waited
submit on each side of it for the two layout transitions. Pipelining is a real answer and it is a
change to the seam's frame model, not to this host; it is worth doing when a consumer needs the
frames, and worth not doing before that.

### Sabotages

| Sabotage | Observed |
| --- | --- |
| the Vulkan dialect takes OpenGL's `NDC_Y` — the single formula this spec used to claim | `seam-vulkan`, 520,509 px outside the band |
| every in-frame Vulkan buffer update takes generation 0 again (KI-083's defect) | `seam-vulkan`, 1,393,629 px outside the band |
| the host stops telling `adopt` the swapchain's format | validation: *"imageView format (VK_FORMAT_B8G8R8A8_UNORM) must match … pColorAttachmentFormats[0] (VK_FORMAT_R8G8B8A8_UNORM)"* |
| present straight from `GENERAL` instead of `PRESENT_SRC` | validation: *"images passed to present must be in layout VK_IMAGE_LAYOUT_PRESENT_SRC_KHR … but VkImage 0"*, 6 messages |

The last two are the argument for extending the validation gate to this path rather than leaving it
on `backend_vk.c` alone. Neither moves a pixel the reference comparison would notice — a format
mismatch on this driver renders the frame anyway — so without the layers listening, both would have
shipped green.


## F133, last step: the four backends are gone

`--renderer opengl|metal|vulkan` now names **one compile-time copy of the seam each**, reached through
`seam_backends.h`. The pack stays compile-time selected, so D14b's zero indirection holds for the games
it serves; the only runtime choice is which of the three copies a window opens. **2,082 lines across
15 files deleted**: `backend_gl.c`, `backend_metal.m`, `backend_vk.c`, `backend_sdl.c`, their headers
and sidecars, and `shaders/ui.vert`, `ui.frag`, `ui_spv.h`.

All three renderers are byte-identical to the frame the OpenGL backend drew before any of this began.

### SDL_Renderer, retired

`--renderer sdl` now answers *"Unknown renderer 'sdl'; use opengl, metal or vulkan."* That is charter
D49 carried out, and the reference frames are what make it safe: they were captured from that path
while it was still shipping, which is the ordering D54 required and the reason this could not have
been done in the other order.

The render spec loses its SDL capture, and two gates change shape as a consequence. Both are stated
here rather than absorbed, which criterion 4 asks for:

- **The live SDL comparison is gone** and the recorded frames are the only gate. Cross-backend
  comparison stays in the report as *information*: every backend now shares the seam, so agreeing with
  each other says only that they run the same code. A missing reference file is now a **failure**
  rather than a skip — silently having no oracle is the one way this suite could go green while
  measuring nothing.
- **The memory budget becomes absolute.** It was "32 MiB more than SDL_Renderer's resident set", and
  that figure is no longer a path that runs. SDL measured 164–170 MiB across runs, so the old rule
  effectively enforced about 200 MiB; the new ceiling is **208 MiB**, which keeps that with room for
  run-to-run variance and is still well clear of the 146–169 MiB the three copies measure.

Frame time is unchanged: the same absolute 8 ms ceiling, which never depended on SDL.

### The boundary is now checked, not described

`tools/design.py`'s render-layering rule allowed graphics-API symbols in `render/backend_*.c` because
the four hand-written backends each carried their own. They are gone, and the one backend left draws
through the pack and mentions no API at all — so the rule now allows **`render/seam_host_*.c` only**.
That is the migration's whole claim, expressed as something the build refuses rather than something a
spec asserts.

`tools/shaders.py` loses `check_legacy()` with the pair it was guarding. It existed to stop `ui.vert`
and `ui.frag` drifting from `ui.glsl` during the transition, and the transition is over.

### Windows

`RE_DEFAULT_BACKEND` there was `sdl`, "until it has its own evidence (KI-014)". It has had that
evidence since 2026-09-06 for both OpenGL and Vulkan, so the default is now `opengl`. What is **not**
verified on Windows is this migration: the seam copies, the `/FI` force-include and the draw list
through the pack have only ever run on macOS. The code path is the same one all three macOS copies
share, and the Windows host that produced the adapter evidence is the place to confirm it.

### What the suite says with the transition over

| scene | all three, against the recorded frame | outside the 2px band | cross-backend (information) |
| --- | --- | --- | --- |
| workspace | 392 px | **0** | 0 |
| terminal | 436 px | **0** | 0 |
| primitives | 32,195 px | **0** | 0 |

Vulkan validation: 0 messages. Memory 185,296 / 146,528 / 147,664 KiB against the 208 MiB ceiling.
Medians 0.56–1.45 (OpenGL), 1.80–2.50 (Metal), 3.95–4.81 (Vulkan) against 8 ms — **Vulkan is the one
worth watching**, at about 60% of the ceiling, for the three-submits-per-frame reason recorded above.

The spec also runs in **189 seconds instead of 821**: six backends and fifteen pairwise comparisons
became three and three.

**The missing-reference assertion was sabotage-verified** by taking `render-terminal.png` away — *"the
recorded reference frame … is the only oracle left and is missing"*. It matters more than it looks:
with SDL gone, a deleted or unreadable reference is the one way this suite could report success while
comparing nothing at all.

### F133's criteria, against what is here

1. **The desktop renders through the seam on every graphics API it supports.** Three copies, three
   `--renderer` values, workspace and terminal and primitives captured on each.
2. **The reference frames were captured from SDL_Renderer before it stopped shipping**, in the
   increment that added them, and every backend is judged against them.
3. **`--renderer sdl` says what to use instead**: *"Unknown renderer 'sdl'; use opengl, metal or
   vulkan."*
4. **The budgets are met, and the two that changed shape are stated** in this section rather than
   absorbed.
5. **Each regression was observed failing for its own reason** — eleven sabotages across the five
   increments, including the shared-defect one that only the recorded frames could catch.
6. **Nothing was lost in the move**: the frames are identical to the ones the hand-written backends
   produced, on all three scenes, to the pixel.

### The rows, and what is still owed

**F133's work is done and every criterion above is met; its row still reads `passes: false`.**
`features.py validate` refuses a passing feature whose dependencies are not passing, and F130 and
F131 have never been settled — KI-082's F123/F126 knot left the whole chain waiting. That is a
bookkeeping pass over F123 and F129–F132 against evidence this spec already records, not more
implementation, and it is **KI-085**.

Today's run re-confirmed several of those criteria incidentally, because the seam changed underneath
the example: it still **builds from the pack alone** on all three backends, and renders within **1, 4
and 5 pixels** of itself across them — which also shows the OpenGL scissor conversion is right for the
example's *off-screen* mirror pass and not only for a window.

**What no evidence covers anywhere is Windows.** The seam copies, the `/FI` force-include and the
draw list through the pack have only ever run on macOS. `RE_DEFAULT_BACKEND` there is now `opengl`,
on the strength of adapter evidence from 2026-09-06 that measured the *deleted* backend. The code
path is the one all three macOS copies share, and the host in KI-014 is where that gets answered.
