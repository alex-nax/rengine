/* The resource-and-draw seam: renderer code talks to this, never to a graphics API directly.
 *
 * Generalised from vtmb-vr's `src/renderer/gpu/device.h`, which earned this shape in a real renderer
 * across thirteen migrated files (its F801/D14). rEngine curates what a game proved rather than
 * inventing an abstraction in a test suite — charter D01, D08 and D52. The decisions below are
 * VtMB's; what is new is the C form, the shader descriptor, and the loader.
 *
 * WHAT IS TAKEN FROM VtMB UNCHANGED
 *
 *   Granularity is resource + draw (D14c): buffers, textures, programs, vertex layouts, a small
 *   pipeline state, a draw. Deliberately NOT command buffers, render passes or barriers — a Vulkan
 *   backend builds those internally, whereas making GL 4.1 emulate them would rewrite every call
 *   site for no present gain.
 *
 *   Selection is compile-time (D14b/D51): exactly one backend is compiled into a binary, so nothing
 *   here is a function pointer and nothing costs an indirection. Two binaries, not two paths.
 *
 *   Depth and cull are set piecemeal rather than as one pipeline object, because call sites toggle
 *   them independently and bundling them during a migration would change state a call site used to
 *   inherit — it could move pixels, which a reference-image gate forbids.
 *
 *   Uniforms are looked up BY NAME and cached by the caller. Name lookup is what every backend can
 *   honour; explicit binding numbers would leak GL/Vulkan differences into call sites.
 *
 * WHAT THIS ADDS, AND WHY
 *
 *   1. Entry points come from the host, exactly as the device layer's do. `re_gpu_open` takes a
 *      `vkGetInstanceProcAddr`; `re_seam_open` takes a `glGetProcAddress`. The pack therefore has no
 *      loader of its own, links no GL library, and cannot collide with the loader a consumer already
 *      links — which VtMB does (glad). It is also what keeps the pack windowing-free: see
 *      `gpu_device.h` for the same argument on the other layer.
 *
 *   2. A shader is a DESCRIPTOR, not a source string. VtMB's `createProgram` takes GLSL text, and a
 *      Vulkan backend cannot honour that without embedding a GLSL compiler. It does not have to:
 *      VtMB's own build already runs `glslang -> SPIR-V -> SPIRV-Cross` and then *discards the
 *      SPIR-V*. So the form that serves every backend is the one the build already produces — carry
 *      both, choose in the backend. `ReSeamShader` is that carrier, and the convenience overload in
 *      the C++ facade keeps every existing GLSL call site compiling today.
 *
 *   3. A handle's id is the BACKEND'S SLOT, not the API's object. VtMB documents its ids as opaque
 *      and they happen to be GL names; a `VkBuffer` is 64 bits and would not fit. Keeping the id a
 *      32-bit slot index into a backend-owned table costs one array lookup per resource call, keeps
 *      `0 == none`, and keeps these structs the size and shape VtMB's call sites already assume.
 *      That is the answer to the first question spec 121 said the pack had to settle.
 */
#ifndef RENGINE_GPU_SEAM_H
#define RENGINE_GPU_SEAM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- handles ---------------------------------------------------------------------------------
 * Opaque. `0` always means "none", so a zero-initialised handle is safe to pass anywhere. */
typedef struct { uint32_t id; } ReSeamBuffer;
typedef struct { uint32_t id; int width; int height; } ReSeamTexture;
typedef struct { uint32_t id; } ReSeamProgram;
typedef struct { uint32_t id; } ReSeamVertexArray;
/* A place to render. Made from textures the host already owns — the seam never creates one, which is
 * the same rule the device layer follows and the reason an OpenXR host can hand either layer images
 * from `xrCreateSwapchain`. A zero handle means "the target this frame was begun with", so an
 * off-screen pass returns to the frame's own target without having to remember what it was. */
typedef struct { uint32_t id; int width; int height; } ReSeamTarget;

/* ---- small enumerations -----------------------------------------------------------------------
 * The values are VtMB's declaration order deliberately: the C++ facade static_asserts each mapping,
 * so a reordering here fails the build rather than silently swapping a blend mode. */
typedef enum { RE_SEAM_BUFFER_STATIC = 0, RE_SEAM_BUFFER_DYNAMIC = 1 } ReSeamBufferUsage;
typedef enum { RE_SEAM_FILTER_NEAREST = 0, RE_SEAM_FILTER_LINEAR = 1 } ReSeamFilter;
typedef enum { RE_SEAM_WRAP_CLAMP_TO_EDGE = 0, RE_SEAM_WRAP_REPEAT = 1 } ReSeamWrap;
/* `PREMULTIPLIED` takes the source as already multiplied by its own alpha: src + dst*(1-srcA).
 * It is what the ALPHA channel of an ordinary composite needs — rEngine's draw list has always
 * asked GL for exactly this and the seam could not say it, because `ALPHA` on the alpha channel
 * squares the coverage. Found by porting a real renderer onto the seam rather than by design. */
typedef enum {
  RE_SEAM_BLEND_NONE = 0, RE_SEAM_BLEND_ALPHA = 1, RE_SEAM_BLEND_ADDITIVE = 2,
  RE_SEAM_BLEND_PREMULTIPLIED = 3
} ReSeamBlend;
typedef enum { RE_SEAM_PRIMITIVE_TRIANGLES = 0, RE_SEAM_PRIMITIVE_LINES = 1 } ReSeamPrimitive;
typedef enum { RE_SEAM_DEPTH_TEST_DISABLED = 0, RE_SEAM_DEPTH_TEST_ENABLED = 1 } ReSeamDepthTest;
typedef enum { RE_SEAM_DEPTH_WRITE_DISABLED = 0, RE_SEAM_DEPTH_WRITE_ENABLED = 1 } ReSeamDepthWrite;
typedef enum { RE_SEAM_CULL_NONE = 0, RE_SEAM_CULL_BACK = 1 } ReSeamCull;
/* Depth comparison. `LESS` is every backend's default and what a call site gets without asking;
 * `LESS_EQUAL` and `EQUAL` are what a depth pre-pass needs, which is 14 calls in vtmb-vr. */
typedef enum {
  RE_SEAM_DEPTH_LESS = 0, RE_SEAM_DEPTH_LESS_EQUAL = 1, RE_SEAM_DEPTH_EQUAL = 2, RE_SEAM_DEPTH_ALWAYS = 3
} ReSeamDepthCompare;
/* How a texture's memory is used. A target's colour and depth attachments are written by the GPU
 * rather than uploaded, and a depth attachment has no colour format at all — so the two cases a
 * render target needs are named rather than inferred from a null pixel pointer. */
typedef enum {
  RE_SEAM_TEXTURE_SAMPLED = 0,  /* four channels, uploaded and read by a shader — the ordinary case */
  RE_SEAM_TEXTURE_COLOR = 1,    /* rendered into, then sampled */
  RE_SEAM_TEXTURE_DEPTH = 2,    /* rendered into as depth; sampling it is not promised */
  /* One channel, read in `.r`. A glyph atlas is the case this exists for, and the case that found
   * it: rEngine's draw list keeps coverage in a 2048-square page, which is 4 MiB at one byte a
   * pixel and 16 MiB at four. vtmb-vr's font page pays the four today because nothing offered it
   * anything else. Uploads are one byte per pixel, not four. */
  RE_SEAM_TEXTURE_COVERAGE = 3
} ReSeamTextureUse;

/* How a vertex attribute's bytes are read. VtMB's seam had only floats, with a note saying a type
 * enum before a second type exists would be speculative — and that was right until a second type
 * turned up. rEngine's own UI vertex packs its colour as four bytes, which is 12 bytes saved on
 * every vertex of a 65,536-vertex batch, so a UI renderer cannot adopt the seam without this. */
typedef enum {
  RE_SEAM_ATTRIBUTE_FLOAT = 0,  /* `components` floats */
  RE_SEAM_ATTRIBUTE_UNORM8 = 1  /* `components` bytes, each scaled from 0..255 to 0.0..1.0 */
} ReSeamAttributeType;

/* One vertex attribute. `components` is 1-4. `type` defaults to float, so a zero-initialised
 * attribute and every call site written before this existed mean exactly what they meant. */
typedef struct {
  int location;
  int components;
  size_t offset;
  ReSeamAttributeType type;
} ReSeamVertexAttribute;
typedef struct { const ReSeamVertexAttribute *attributes; int count; size_t stride; } ReSeamVertexLayout;

/* ---- shaders ----------------------------------------------------------------------------------
 * One stage, in whichever forms the build produced. A backend takes the form it can use and says so
 * by name when the form it needs is absent — the failure a consumer hits is then "this build emitted
 * no SPIR-V for `ui.vert`", pointing at the build step, rather than a compile error inside a driver.
 *
 * Both fields may be set. That is the intended steady state for a project that ships two binaries:
 * one generator emits one header, and each backend reads its own half. */
typedef struct {
  const char *glsl;         /* dialect source for a GL backend, or NULL */
  const uint32_t *spirv;    /* SPIR-V words for a Vulkan backend, or NULL */
  size_t spirv_bytes;       /* size of `spirv` in bytes, not words */
  const char *msl;          /* Metal Shading Language source for a Metal backend, or NULL */
  const char *entry_point;  /* entry point name; NULL means each backend's default */
} ReSeamShader;

/* ---- opening ----------------------------------------------------------------------------------
 * `get_proc` is the host's own entry-point loader: SDL_GL_GetProcAddress, eglGetProcAddress, or the
 * platform window's. It is not optional — the pack links no graphics library, which is exactly what
 * lets a consumer keep the loader it already has.
 *
 * `on_message` receives shader compile and link diagnostics. VtMB's backend logged them through its
 * own LOGE; a library cannot assume a logger, so it hands them back. */
typedef struct ReSeam ReSeam;
typedef void *(*ReSeamGetProc)(void *user, const char *name);
typedef void (*ReSeamOnMessage)(void *user, const char *message);

typedef struct {
  ReSeamGetProc get_proc;
  void *user;
  ReSeamOnMessage on_message;
  void *message_user;
} ReSeamOpen;

/* Binds the seam to the graphics context that is current on THIS thread, loading what it needs
 * through `get_proc`. Must be called on the thread that owns the context. Returns NULL and fills
 * `error` on failure. */
ReSeam *re_seam_open(const ReSeamOpen *options, char *error, size_t error_size);
void re_seam_close(ReSeam *seam);

/* VtMB's call sites declare `gpu::Device dev;` as a local wherever they need one, because its Device
 * is stateless — GL keeps the state in the current context. The pack keeps that idiom working by
 * making the currency explicit: a default-constructed facade Device forwards to whatever was made
 * current on this thread. Callers that want no ambient state ignore this and pass the seam. */
void re_seam_make_current(ReSeam *seam);
ReSeam *re_seam_current(void);

/* ---- programs --------------------------------------------------------------------------------
 * `debug_name` appears in the diagnostic if compilation or linking fails; it is the only way to tell
 * two failed programs apart, so it is required rather than defaulted. A failure returns id 0. */
ReSeamProgram re_seam_program(ReSeam *seam, const ReSeamShader *vertex, const ReSeamShader *fragment,
                              const char *debug_name);
void re_seam_program_destroy(ReSeam *seam, ReSeamProgram *program);
void re_seam_program_use(ReSeam *seam, ReSeamProgram program);
int re_seam_uniform_location(ReSeam *seam, ReSeamProgram program, const char *name);
void re_seam_uniform_int(ReSeam *seam, int location, int value);
void re_seam_uniform_float(ReSeam *seam, int location, float value);
void re_seam_uniform_vec2(ReSeam *seam, int location, float x, float y);
void re_seam_uniform_vec4(ReSeam *seam, int location, float x, float y, float z, float w);
void re_seam_uniform_mat4(ReSeam *seam, int location, const float *value);

/* ---- buffers ---------------------------------------------------------------------------------- */
ReSeamBuffer re_seam_buffer(ReSeam *seam);
void re_seam_buffer_destroy(ReSeam *seam, ReSeamBuffer *buffer);
void re_seam_buffer_update(ReSeam *seam, ReSeamBuffer buffer, const void *data, size_t bytes,
                           ReSeamBufferUsage usage);

/* ---- vertex layout ---------------------------------------------------------------------------- */
ReSeamVertexArray re_seam_vertex_array(ReSeam *seam, ReSeamBuffer buffer, const ReSeamVertexLayout *layout);
void re_seam_vertex_array_destroy(ReSeam *seam, ReSeamVertexArray *array);
void re_seam_vertex_array_bind(ReSeam *seam, ReSeamVertexArray array);

/* ---- textures --------------------------------------------------------------------------------- */
ReSeamTexture re_seam_texture_2d(ReSeam *seam, const void *rgba, int width, int height,
                                 ReSeamFilter filter, ReSeamWrap wrap);
/* The same, saying what the texture is for. `re_seam_texture_2d` is this with SAMPLED, kept because
 * it is what every existing call site writes. */
ReSeamTexture re_seam_texture_2d_for(ReSeam *seam, const void *rgba, int width, int height,
                                     ReSeamFilter filter, ReSeamWrap wrap, ReSeamTextureUse use);
/* Replace a rectangle of an existing texture. A glyph atlas writes one of these per glyph, and
 * re-uploading the whole page for a 12x16 rectangle is the difference between a frame and a stall. */
void re_seam_texture_update(ReSeam *seam, ReSeamTexture texture, int x, int y, int width, int height,
                            const void *rgba);
void re_seam_texture_destroy(ReSeam *seam, ReSeamTexture *texture);
void re_seam_texture_bind(ReSeam *seam, ReSeamTexture texture, int unit);
/* The backend's own object behind a texture: a texture name on OpenGL, a `VkImage` on Vulkan, an
 * `id<MTLTexture>` on Metal. The mirror of `re_seam_target_adopt`, and the second and last place the
 * seam is not API-neutral.
 *
 * It exists because a host sometimes has to do something to an image the seam made — read a frame
 * back, hand it to a video encoder, pass it to an XR runtime — and the alternative is for the seam to
 * grow those features itself. Read-back in particular is a synchronisation point, and a frame path
 * whose whole value is being thin is the wrong place for one. */
uintptr_t re_seam_texture_handle(ReSeam *seam, ReSeamTexture texture);

/* ---- render targets ----------------------------------------------------------------------------
 * `depth` may be a zero handle for a colour-only target. Binding a zero target returns to whatever
 * the host had bound, which is how the window's back buffer stays the host's business. */
ReSeamTarget re_seam_target(ReSeam *seam, ReSeamTexture color, ReSeamTexture depth);
/* The target the HOST already has, named in the backend's own terms: a framebuffer object on
 * OpenGL, a `VkImageView` on Vulkan, an `id<MTLTexture>` on Metal.
 *
 * This is the one place the seam is not API-neutral, and it is unavoidable rather than an oversight.
 * A window's back buffer belongs to the host — the seam creates no swapchain, exactly as the device
 * layer creates no surface — and every graphics API names that image differently. The alternative is
 * for the seam to own a window, which is the coupling both layers exist to refuse. The device layer
 * has the same escape hatch for the same reason: `re_gpu_instance` hands back a `VkInstance`.
 *
 * A host that only ever renders off-screen never calls this. */
ReSeamTarget re_seam_target_adopt(ReSeam *seam, uintptr_t handle, int width, int height);
/* Destroy gives back everything the seam allocated and nothing the caller owns. For a target made by
 * `re_seam_target` that is the target slot alone -- the textures stay yours. For an ADOPTED one it is
 * also the wrapper the seam had to build around your image, which is why an adopted target must be
 * destroyed even though the image inside it was never the seam's. A host that acquires a swapchain
 * image per frame therefore destroys per frame; one that adopts a constant image (an OpenGL host
 * adopting framebuffer zero) can adopt once and keep it. */
void re_seam_target_destroy(ReSeam *seam, ReSeamTarget *target);
void re_seam_target_bind(ReSeam *seam, ReSeamTarget target);

/* ---- the frame ----------------------------------------------------------------------------------
 * Everything between these two calls is one submission. OpenGL needs no such bracket and treats it
 * as a flush; Vulkan and Metal need somewhere to record commands and a moment to submit them, and
 * without the bracket they would have to guess where a frame ends — which is the one thing an
 * immediate-mode-looking API cannot infer.
 *
 * The frame takes the target it renders into, because Vulkan has no default framebuffer to fall back
 * on: the image a frame draws to is the host's, chosen per frame, and on a desktop it is whichever
 * swapchain image came free. Binding a zero target inside the frame returns here. */
void re_seam_frame_begin(ReSeam *seam, ReSeamTarget target);
void re_seam_frame_end(ReSeam *seam);

/* ---- state and draw ---------------------------------------------------------------------------- */
void re_seam_blend(ReSeam *seam, ReSeamBlend blend);
void re_seam_depth(ReSeam *seam, ReSeamDepthTest test, ReSeamDepthWrite write);
void re_seam_cull(ReSeam *seam, ReSeamCull cull);
/* Both rectangles are in PIXELS OF THE BOUND TARGET WITH ROW 0 AT THE TOP -- the same convention
 * re_seam_texture_update already takes, and the opposite of glViewport/glScissor.
 *
 * This is stated rather than inherited because the three backends did not agree and nothing noticed.
 * Vulkan's VkRect2D and Metal's MTLScissorRect are both measured from the top; OpenGL's are measured
 * from the bottom, and the seam used to hand each API the caller's numbers unchanged. Every caller
 * in this repository happened to clip either the full height or nothing, so no test could tell --
 * until rEngine's draw list clipped a pane on Metal and the panes were upside down (spec 124, F133).
 * The OpenGL backend now converts; the other two pass through, as they always did. */
void re_seam_viewport(ReSeam *seam, int x, int y, int width, int height);
/* Clip to a rectangle in the same coordinates as the viewport. A width or height below zero turns
 * clipping off. Every panel microui draws is clipped, so this is per-control, not per-frame. */
void re_seam_scissor(ReSeam *seam, int x, int y, int width, int height);
/* Separate alpha blending, for a call site that composites premultiplied colour. `re_seam_blend`'s
 * three modes stay the common path; this is the escape hatch, not a replacement. */
void re_seam_blend_separate(ReSeam *seam, ReSeamBlend color, ReSeamBlend alpha);
void re_seam_depth_compare(ReSeam *seam, ReSeamDepthCompare compare);
/* `depth` is separate from the colour clear because a call site that clears colour only must keep
 * doing so; clearing depth as well would be a behaviour change smuggled in by a refactor.
 *
 * A depth clear is masked by the depth write state, in every backend, because OpenGL masks it and a
 * call site relying on that must see the same thing everywhere. There is deliberately NO depth-only
 * clear — vtmb-vr's seam has none and nothing has asked for one — and the cost of that showed up
 * while testing: the masking rule cannot be exercised by a scene, because doing so means clearing
 * the colour that scene is being compared on. It is verified on OpenGL by the pack's pixel test and
 * carried by construction on the others. A depth-only clear would close that, and is the right thing
 * to add the first time a call site wants one rather than the first time a test does. */
void re_seam_clear(ReSeam *seam, float r, float g, float b, float a, bool depth);
void re_seam_draw(ReSeam *seam, ReSeamPrimitive primitive, int first, int count);

/* Human-readable backend/API version, for a startup log. Never parse it — a runtime feature check
 * that matters should query the capability rather than sniff a string. */
const char *re_seam_api_version(ReSeam *seam);

/* Which backend this binary was built with, as a stable lowercase word ("opengl", "vulkan"). The
 * switch is compile-time, so this answers what the build chose — it is not a selector. */
const char *re_seam_backend(void);

#ifdef __cplusplus
}
#endif
#endif
