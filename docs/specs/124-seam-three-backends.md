# The seam carries a real renderer: render targets, three backends, and the D14c verdict here

Date: 2026-09-11. Status: **F129 implemented and evidenced; F132 next.**

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
F132  the scene example: procedural by default, --scene for a real model               (rEngine)
F130  the seam's Vulkan backend, judged against GL on the example's pixels             (rEngine)
F131  the seam's Metal backend, judged the same way                                    (rEngine)
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
