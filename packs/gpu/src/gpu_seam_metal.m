/* The seam's Metal backend (F131, charter D53, spec 124).
 *
 * The third graphics API rEngine's desktop already ships, and the one charter D29 puts between
 * OpenGL and Vulkan. Nothing above this file changes to use it: `scene.c` is the same source the
 * other two backends compile, and a test asserts it names no graphics API at all.
 *
 * WHAT IS THE SAME AS THE VULKAN BACKEND, and for the same reasons:
 *
 *   Uniforms by name come from reflecting the SPIR-V (gpu_seam_spirv.c). SPIRV-Cross preserves a
 *   std140 block's memory layout when it emits MSL — float4x4 at 64 bytes, float4 at 16 — so the
 *   offsets one reflection produces are the offsets a Metal buffer wants, and no second reflector
 *   exists. Set 0 binding 0 becomes [[buffer(0)]]; binding n becomes [[texture(n-1)]].
 *
 *   Pipeline state is collected and resolved at draw time into a cached pipeline. Metal splits it
 *   across two objects — MTLRenderPipelineState for blending and vertex layout, MTLDepthStencilState
 *   for depth — so the cache holds both against one key.
 *
 *   The viewport is NOT flipped. Metal's framebuffer origin is top-left like Vulkan's, so the same
 *   reasoning applies and reaches the same answer: row 0 means what it means on OpenGL, a texture
 *   rendered into and sampled is the same image on every backend, and a presented window is the
 *   host's to flip. See the long note in gpu_seam_vk.c.
 *
 * WHAT IS DIFFERENT, AND VISIBLE FROM THE CALL SITE:
 *
 *   Metal has no mid-pass clear. A clear is a load action on an attachment, chosen when an encoder
 *   begins, and there is no vkCmdClearAttachments equivalent. So `re_seam_clear` ends the current
 *   encoder and begins another with clear load actions — which is what Metal applications do, and
 *   which costs an encoder per clear rather than a command. One consequence is honest to state: a
 *   clear is not clipped by the scissor here, because a load action covers the whole attachment.
 *   No call site in this repository clears inside a scissor; one that did would see a difference.
 *
 * MEMORY. Compiled WITHOUT ARC, unlike rEngine's own backend_metal.m. This file owns objects in
 * plain C tables with create/destroy pairs, which is the discipline the rest of the pack already
 * follows; ARC would mean either bridging casts at every slot or a parallel Objective-C object to
 * hold strong references. The frame is wrapped in an autorelease pool for the descriptors Metal
 * hands back autoreleased.
 */
#import <Metal/Metal.h>

#include "rengine/gpu_seam.h"
#include "gpu_seam_spirv.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_BUFFERS 256
#define MAX_TEXTURES 256
#define MAX_PROGRAMS 32
#define MAX_ARRAYS 64
#define MAX_TARGETS 32
#define MAX_PIPELINES 128
#define MAX_UNITS 8
#define UNIFORM_SLOTS 2048
#define UNIFORM_STRIDE 256
#define SAMPLER_LOCATION_BIT 0x40000000

typedef struct { id<MTLBuffer> buffer; size_t size; } BufferSlot;
typedef struct {
  id<MTLTexture> texture; id<MTLSamplerState> sampler;
  int width, height; bool depth;
} TextureSlot;
typedef struct {
  id<MTLFunction> vertex, fragment;
  ReSpirvLayout reflect;
  uint8_t *uniforms;
} ProgramSlot;
typedef struct {
  uint32_t buffer;
  ReSeamVertexAttribute attributes[8];
  int count;
  uint32_t stride;
} ArraySlot;
typedef struct {
  uint32_t color_texture, depth_texture;
  int width, height;
  MTLPixelFormat color_format, depth_format;
} TargetSlot;
typedef struct {
  uint32_t program, array;
  uint8_t blend_color, blend_alpha, depth_test, depth_write, depth_compare, cull, primitive;
  int color_format, depth_format;
} PipelineKey;

struct ReSeam {
  id<MTLDevice> device;
  id<MTLCommandQueue> queue;
  id<MTLCommandBuffer> commands;
  id<MTLRenderCommandEncoder> encoder;
  id<MTLBuffer> uniform_ring;
  size_t uniform_offset;
  ReSeamOnMessage on_message;
  void *message_user;

  BufferSlot buffers[MAX_BUFFERS];
  TextureSlot textures[MAX_TEXTURES];
  ProgramSlot programs[MAX_PROGRAMS];
  ArraySlot arrays[MAX_ARRAYS];
  TargetSlot targets[MAX_TARGETS];
  struct { PipelineKey key; id<MTLRenderPipelineState> pipeline; id<MTLDepthStencilState> depth; }
    pipelines[MAX_PIPELINES];
  uint32_t pipeline_count;

  uint32_t program, array;
  uint8_t blend_color, blend_alpha, depth_test, depth_write, depth_compare, cull;
  uint32_t units[MAX_UNITS];
  MTLViewport viewport;
  MTLScissorRect scissor;
  bool scissor_on;
  ReSeamTarget frame_target, bound;
  bool in_frame, encoding;
  void *pool;
};

static _Thread_local ReSeam *current;

static bool say(char *error, size_t size, const char *format, ...) {
  if (error != NULL && size > 0) {
    va_list args; va_start(args, format);
    vsnprintf(error, size, format, args);
    va_end(args);
  }
  return false;
}
static void report(ReSeam *seam, const char *format, ...) {
  if (seam == NULL || seam->on_message == NULL) return;
  char message[1024];
  va_list args; va_start(args, format);
  vsnprintf(message, sizeof(message), format, args);
  va_end(args);
  seam->on_message(seam->message_user, message);
}

const char *re_seam_backend(void) { return "metal"; }
void re_seam_make_current(ReSeam *seam) { current = seam; }
ReSeam *re_seam_current(void) { return current; }

/* ---- open and close ------------------------------------------------------------------------------ */

ReSeam *re_seam_open(const ReSeamOpen *options, char *error, size_t error_size) {
  if (options == NULL || options->user == NULL) {
    say(error, error_size, "the Metal backend needs the host's id<MTLDevice> in ReSeamOpen.user "
                           "(the seam creates no device of its own)");
    return NULL;
  }
  ReSeam *seam = calloc(1, sizeof(*seam));
  if (seam == NULL) { say(error, error_size, "out of memory"); return NULL; }
  seam->device = (id<MTLDevice>)options->user;
  [seam->device retain];
  seam->queue = [seam->device newCommandQueue];
  if (seam->queue == nil) {
    say(error, error_size, "the device would not make a command queue");
    free(seam);
    return NULL;
  }
  seam->on_message = options->on_message;
  seam->message_user = options->message_user;
  seam->uniform_ring = [seam->device newBufferWithLength:UNIFORM_STRIDE * UNIFORM_SLOTS
                                                 options:MTLResourceStorageModeShared];
  if (seam->uniform_ring == nil) {
    say(error, error_size, "the uniform ring buffer could not be allocated");
    [seam->queue release];
    free(seam);
    return NULL;
  }
  seam->depth_compare = RE_SEAM_DEPTH_LESS;
  return seam;
}

void re_seam_close(ReSeam *seam) {
  if (seam == NULL) return;
  for (uint32_t i = 0; i < seam->pipeline_count; i++) {
    [seam->pipelines[i].pipeline release];
    [seam->pipelines[i].depth release];
  }
  for (int i = 0; i < MAX_BUFFERS; i++) [seam->buffers[i].buffer release];
  for (int i = 0; i < MAX_TEXTURES; i++) {
    [seam->textures[i].texture release];
    [seam->textures[i].sampler release];
  }
  for (int i = 0; i < MAX_PROGRAMS; i++) {
    [seam->programs[i].vertex release];
    [seam->programs[i].fragment release];
    free(seam->programs[i].uniforms);
  }
  [seam->uniform_ring release];
  [seam->queue release];
  [seam->device release];
  if (current == seam) current = NULL;
  free(seam);
}

const char *re_seam_api_version(ReSeam *seam) {
  static char name[128];
  if (seam == NULL) return "unknown";
  snprintf(name, sizeof(name), "%s", [[seam->device name] UTF8String]);
  return name;
}

/* ---- buffers -------------------------------------------------------------------------------------- */

ReSeamBuffer re_seam_buffer(ReSeam *seam) {
  ReSeamBuffer handle = {0};
  if (seam == NULL) return handle;
  for (int i = 0; i < MAX_BUFFERS; i++)
    if (seam->buffers[i].buffer == nil) { handle.id = (uint32_t)(i + 1); return handle; }
  report(seam, "gpu: out of buffer slots");
  return handle;
}

void re_seam_buffer_destroy(ReSeam *seam, ReSeamBuffer *buffer) {
  if (seam == NULL || buffer == NULL || buffer->id == 0) return;
  BufferSlot *slot = &seam->buffers[buffer->id - 1];
  [slot->buffer release];
  slot->buffer = nil;
  slot->size = 0;
  buffer->id = 0;
}

void re_seam_buffer_update(ReSeam *seam, ReSeamBuffer buffer, const void *data, size_t bytes,
                           ReSeamBufferUsage usage) {
  (void)usage;
  if (seam == NULL || buffer.id == 0 || bytes == 0) return;
  BufferSlot *slot = &seam->buffers[buffer.id - 1];
  if (slot->size < bytes) {
    [slot->buffer release];
    slot->buffer = [seam->device newBufferWithLength:bytes options:MTLResourceStorageModeShared];
    if (slot->buffer == nil) { report(seam, "gpu: a %zu-byte buffer was refused", bytes); return; }
    slot->size = bytes;
  }
  if (data != NULL) memcpy([slot->buffer contents], data, bytes);
}

/* ---- textures ------------------------------------------------------------------------------------- */

ReSeamTexture re_seam_texture_2d_for(ReSeam *seam, const void *rgba, int width, int height,
                                     ReSeamFilter filter, ReSeamWrap wrap, ReSeamTextureUse use) {
  ReSeamTexture handle = {0};
  if (seam == NULL || width <= 0 || height <= 0) return handle;
  uint32_t id = 0;
  for (int i = 0; i < MAX_TEXTURES; i++) if (seam->textures[i].texture == nil) { id = (uint32_t)(i + 1); break; }
  if (id == 0) { report(seam, "gpu: out of texture slots"); return handle; }
  TextureSlot *slot = &seam->textures[id - 1];
  memset(slot, 0, sizeof(*slot));
  slot->width = width;
  slot->height = height;
  slot->depth = use == RE_SEAM_TEXTURE_DEPTH;

  MTLTextureDescriptor *descriptor = [MTLTextureDescriptor
    texture2DDescriptorWithPixelFormat:(slot->depth ? MTLPixelFormatDepth32Float : MTLPixelFormatRGBA8Unorm)
                                 width:(NSUInteger)width height:(NSUInteger)height mipmapped:NO];
  descriptor.usage = MTLTextureUsageShaderRead |
                     (use == RE_SEAM_TEXTURE_SAMPLED ? 0 : MTLTextureUsageRenderTarget);
  /* Depth lives in private storage because Metal requires it on macOS; colour stays managed so the
     host can read a frame back through re_seam_texture_handle without a blit of its own. */
  descriptor.storageMode = slot->depth ? MTLStorageModePrivate : MTLStorageModeManaged;
  slot->texture = [seam->device newTextureWithDescriptor:descriptor];
  if (slot->texture == nil) {
    report(seam, "gpu: a %dx%d texture was refused", width, height);
    memset(slot, 0, sizeof(*slot));
    return handle;
  }
  if (rgba != NULL && !slot->depth)
    [slot->texture replaceRegion:MTLRegionMake2D(0, 0, (NSUInteger)width, (NSUInteger)height)
                     mipmapLevel:0 withBytes:rgba bytesPerRow:(NSUInteger)width * 4];

  MTLSamplerDescriptor *sampler = [[MTLSamplerDescriptor alloc] init];
  MTLSamplerMinMagFilter mode = filter == RE_SEAM_FILTER_NEAREST ? MTLSamplerMinMagFilterNearest
                                                                : MTLSamplerMinMagFilterLinear;
  sampler.minFilter = mode;
  sampler.magFilter = mode;
  MTLSamplerAddressMode address = wrap == RE_SEAM_WRAP_REPEAT ? MTLSamplerAddressModeRepeat
                                                             : MTLSamplerAddressModeClampToEdge;
  sampler.sAddressMode = address;
  sampler.tAddressMode = address;
  slot->sampler = [seam->device newSamplerStateWithDescriptor:sampler];
  [sampler release];

  handle.id = id;
  handle.width = width;
  handle.height = height;
  return handle;
}

ReSeamTexture re_seam_texture_2d(ReSeam *seam, const void *rgba, int width, int height,
                                 ReSeamFilter filter, ReSeamWrap wrap) {
  return re_seam_texture_2d_for(seam, rgba, width, height, filter, wrap, RE_SEAM_TEXTURE_SAMPLED);
}

void re_seam_texture_update(ReSeam *seam, ReSeamTexture texture, int x, int y, int width, int height,
                            const void *rgba) {
  if (seam == NULL || texture.id == 0 || rgba == NULL || width <= 0 || height <= 0) return;
  TextureSlot *slot = &seam->textures[texture.id - 1];
  [slot->texture replaceRegion:MTLRegionMake2D((NSUInteger)x, (NSUInteger)y, (NSUInteger)width,
                                               (NSUInteger)height)
                   mipmapLevel:0 withBytes:rgba bytesPerRow:(NSUInteger)width * 4];
}

void re_seam_texture_destroy(ReSeam *seam, ReSeamTexture *texture) {
  if (seam == NULL || texture == NULL || texture->id == 0) return;
  TextureSlot *slot = &seam->textures[texture->id - 1];
  [slot->texture release];
  [slot->sampler release];
  memset(slot, 0, sizeof(*slot));
  texture->id = 0;
  texture->width = 0;
  texture->height = 0;
}

void re_seam_texture_bind(ReSeam *seam, ReSeamTexture texture, int unit) {
  if (seam == NULL || unit < 0 || unit >= MAX_UNITS) return;
  seam->units[unit] = texture.id;
}

uintptr_t re_seam_texture_handle(ReSeam *seam, ReSeamTexture texture) {
  if (seam == NULL || texture.id == 0) return 0;
  return (uintptr_t)seam->textures[texture.id - 1].texture;
}

/* ---- programs --------------------------------------------------------------------------------------
 * MSL is compiled at runtime here. Metal's offline path (a .metallib) is what a shipping game uses,
 * and the shader descriptor already carries whatever form the build produced — this backend takes
 * `msl` because that is what the example's generator emits, and a consumer emitting a library would
 * pass its bytes through the same field. The SPIR-V is read too, for the uniform offsets: see the
 * note at the top of gpu_seam_spirv.h for why one reflection serves both APIs. */

static id<MTLFunction> function_of(ReSeam *seam, const ReSeamShader *stage, const char *debug_name) {
  if (stage == NULL || stage->msl == NULL) {
    report(seam, "gpu: %s has no MSL for this stage — the Metal backend needs ReSeamShader.msl, "
                 "which the shader generator emits alongside the GLSL and the SPIR-V", debug_name);
    return nil;
  }
  NSError *failure = nil;
  NSString *source = [[NSString alloc] initWithUTF8String:stage->msl];
  id<MTLLibrary> library = [seam->device newLibraryWithSource:source options:nil error:&failure];
  [source release];
  if (library == nil) {
    report(seam, "gpu: %s: %s", debug_name,
           failure ? [[failure localizedDescription] UTF8String] : "the MSL would not compile");
    return nil;
  }
  /* SPIRV-Cross renames every entry point to "main0"; a descriptor may name its own. */
  NSString *name = [[NSString alloc] initWithUTF8String:
                    stage->entry_point != NULL ? stage->entry_point : "main0"];
  id<MTLFunction> function = [library newFunctionWithName:name];
  [name release];
  [library release];
  if (function == nil) report(seam, "gpu: %s: the library has no such entry point", debug_name);
  return function;
}

ReSeamProgram re_seam_program(ReSeam *seam, const ReSeamShader *vertex, const ReSeamShader *fragment,
                              const char *debug_name) {
  ReSeamProgram handle = {0};
  if (seam == NULL) return handle;
  uint32_t id = 0;
  for (int i = 0; i < MAX_PROGRAMS; i++) if (seam->programs[i].vertex == nil) { id = (uint32_t)(i + 1); break; }
  if (id == 0) { report(seam, "gpu: out of program slots"); return handle; }
  ProgramSlot *slot = &seam->programs[id - 1];
  memset(slot, 0, sizeof(*slot));

  slot->vertex = function_of(seam, vertex, debug_name);
  slot->fragment = function_of(seam, fragment, debug_name);
  if (slot->vertex == nil || slot->fragment == nil) {
    [slot->vertex release];
    [slot->fragment release];
    memset(slot, 0, sizeof(*slot));
    return handle;
  }
  char error[256] = {0};
  if (vertex->spirv == NULL || fragment->spirv == NULL) {
    report(seam, "gpu: %s has no SPIR-V, which this backend reads for the uniform block's layout — "
                 "MSL text carries no offsets, and the generator emits both from one module", debug_name);
    return handle;
  }
  if (!re_spirv_reflect(vertex->spirv, vertex->spirv_bytes, &slot->reflect, error, sizeof(error)) ||
      !re_spirv_reflect(fragment->spirv, fragment->spirv_bytes, &slot->reflect, error, sizeof(error))) {
    report(seam, "gpu: %s: %s", debug_name, error);
    return handle;
  }
  if (slot->reflect.block_size > 0) {
    slot->uniforms = calloc(1, slot->reflect.block_size);
    if (slot->uniforms == NULL) { report(seam, "gpu: %s: out of memory", debug_name); return handle; }
  }
  handle.id = id;
  return handle;
}

void re_seam_program_destroy(ReSeam *seam, ReSeamProgram *program) {
  if (seam == NULL || program == NULL || program->id == 0) return;
  for (uint32_t i = 0; i < seam->pipeline_count;) {
    if (seam->pipelines[i].key.program == program->id) {
      [seam->pipelines[i].pipeline release];
      [seam->pipelines[i].depth release];
      seam->pipelines[i] = seam->pipelines[--seam->pipeline_count];
    } else i++;
  }
  ProgramSlot *slot = &seam->programs[program->id - 1];
  [slot->vertex release];
  [slot->fragment release];
  free(slot->uniforms);
  memset(slot, 0, sizeof(*slot));
  program->id = 0;
}

void re_seam_program_use(ReSeam *seam, ReSeamProgram program) {
  if (seam != NULL) seam->program = program.id;
}

int re_seam_uniform_location(ReSeam *seam, ReSeamProgram program, const char *name) {
  if (seam == NULL || program.id == 0 || name == NULL) return -1;
  const ReSpirvLayout *reflect = &seam->programs[program.id - 1].reflect;
  for (uint32_t i = 0; i < reflect->member_count; i++)
    if (!strcmp(reflect->members[i].name, name)) return (int)reflect->members[i].offset;
  for (uint32_t i = 0; i < reflect->sampler_count; i++)
    if (!strcmp(reflect->samplers[i].name, name))
      return (int)(SAMPLER_LOCATION_BIT | reflect->samplers[i].binding);
  return -1;
}

static void write_uniform(ReSeam *seam, int location, const void *data, size_t bytes) {
  if (seam == NULL || location < 0 || (location & SAMPLER_LOCATION_BIT) || seam->program == 0) return;
  ProgramSlot *slot = &seam->programs[seam->program - 1];
  if (slot->uniforms == NULL || (size_t)location + bytes > slot->reflect.block_size) return;
  memcpy(slot->uniforms + location, data, bytes);
}

void re_seam_uniform_int(ReSeam *seam, int location, int value) { write_uniform(seam, location, &value, sizeof(value)); }
void re_seam_uniform_float(ReSeam *seam, int location, float value) { write_uniform(seam, location, &value, sizeof(value)); }
void re_seam_uniform_vec2(ReSeam *seam, int location, float x, float y) {
  const float v[2] = {x, y};
  write_uniform(seam, location, v, sizeof(v));
}
void re_seam_uniform_vec4(ReSeam *seam, int location, float x, float y, float z, float w) {
  const float v[4] = {x, y, z, w};
  write_uniform(seam, location, v, sizeof(v));
}
void re_seam_uniform_mat4(ReSeam *seam, int location, const float *value) {
  write_uniform(seam, location, value, 16 * sizeof(float));
}

/* ---- vertex layout ---------------------------------------------------------------------------------- */

ReSeamVertexArray re_seam_vertex_array(ReSeam *seam, ReSeamBuffer buffer, const ReSeamVertexLayout *layout) {
  ReSeamVertexArray handle = {0};
  if (seam == NULL || layout == NULL) return handle;
  uint32_t id = 0;
  for (int i = 0; i < MAX_ARRAYS; i++) if (seam->arrays[i].count == 0) { id = (uint32_t)(i + 1); break; }
  if (id == 0) { report(seam, "gpu: out of vertex-array slots"); return handle; }
  ArraySlot *slot = &seam->arrays[id - 1];
  memset(slot, 0, sizeof(*slot));
  slot->buffer = buffer.id;
  slot->count = layout->count < 8 ? layout->count : 8;
  slot->stride = (uint32_t)layout->stride;
  for (int i = 0; i < slot->count; i++) slot->attributes[i] = layout->attributes[i];
  handle.id = id;
  return handle;
}

void re_seam_vertex_array_destroy(ReSeam *seam, ReSeamVertexArray *array) {
  if (seam == NULL || array == NULL || array->id == 0) return;
  memset(&seam->arrays[array->id - 1], 0, sizeof(ArraySlot));
  array->id = 0;
}

void re_seam_vertex_array_bind(ReSeam *seam, ReSeamVertexArray array) {
  if (seam != NULL) seam->array = array.id;
}

/* ---- state ------------------------------------------------------------------------------------------ */

void re_seam_blend(ReSeam *seam, ReSeamBlend blend) {
  if (seam == NULL) return;
  seam->blend_color = (uint8_t)blend;
  seam->blend_alpha = (uint8_t)blend;
}
void re_seam_blend_separate(ReSeam *seam, ReSeamBlend color, ReSeamBlend alpha) {
  if (seam == NULL) return;
  seam->blend_color = (uint8_t)color;
  seam->blend_alpha = (uint8_t)alpha;
}
void re_seam_depth(ReSeam *seam, ReSeamDepthTest test, ReSeamDepthWrite write) {
  if (seam == NULL) return;
  seam->depth_test = (uint8_t)test;
  seam->depth_write = (uint8_t)write;
}
void re_seam_depth_compare(ReSeam *seam, ReSeamDepthCompare compare) {
  if (seam != NULL) seam->depth_compare = (uint8_t)compare;
}
void re_seam_cull(ReSeam *seam, ReSeamCull cull) { if (seam != NULL) seam->cull = (uint8_t)cull; }

void re_seam_viewport(ReSeam *seam, int x, int y, int width, int height) {
  if (seam == NULL) return;
  seam->viewport = (MTLViewport){(double)x, (double)y, (double)width, (double)height, 0.0, 1.0};
  if (!seam->scissor_on)
    seam->scissor = (MTLScissorRect){(NSUInteger)x, (NSUInteger)y,
                                     (NSUInteger)(width < 0 ? 0 : width), (NSUInteger)(height < 0 ? 0 : height)};
  if (seam->encoding) {
    [seam->encoder setViewport:seam->viewport];
    [seam->encoder setScissorRect:seam->scissor];
  }
}

void re_seam_scissor(ReSeam *seam, int x, int y, int width, int height) {
  if (seam == NULL) return;
  if (width < 0 || height < 0) {
    seam->scissor_on = false;
    seam->scissor = (MTLScissorRect){(NSUInteger)seam->viewport.originX, (NSUInteger)seam->viewport.originY,
                                     (NSUInteger)seam->viewport.width, (NSUInteger)seam->viewport.height};
  } else {
    seam->scissor_on = true;
    seam->scissor = (MTLScissorRect){(NSUInteger)x, (NSUInteger)y, (NSUInteger)width, (NSUInteger)height};
  }
  if (seam->encoding) [seam->encoder setScissorRect:seam->scissor];
}

/* ---- targets, the frame, and the encoder ---------------------------------------------------------- */

ReSeamTarget re_seam_target(ReSeam *seam, ReSeamTexture color, ReSeamTexture depth) {
  ReSeamTarget handle = {0};
  if (seam == NULL || color.id == 0) { report(seam, "gpu: a render target needs a colour texture"); return handle; }
  uint32_t id = 0;
  for (int i = 0; i < MAX_TARGETS; i++) if (seam->targets[i].color_texture == 0) { id = (uint32_t)(i + 1); break; }
  if (id == 0) { report(seam, "gpu: out of render-target slots"); return handle; }
  TargetSlot *slot = &seam->targets[id - 1];
  memset(slot, 0, sizeof(*slot));
  slot->color_texture = color.id;
  slot->depth_texture = depth.id;
  slot->width = seam->textures[color.id - 1].width;
  slot->height = seam->textures[color.id - 1].height;
  slot->color_format = [seam->textures[color.id - 1].texture pixelFormat];
  slot->depth_format = depth.id ? [seam->textures[depth.id - 1].texture pixelFormat] : MTLPixelFormatInvalid;
  handle.id = id;
  handle.width = slot->width;
  handle.height = slot->height;
  return handle;
}

ReSeamTarget re_seam_target_adopt(ReSeam *seam, uintptr_t handle, int width, int height) {
  ReSeamTarget target = {0};
  if (seam == NULL || handle == 0) return target;
  /* The host's handle is an id<MTLTexture> — a drawable's texture, usually. It is wrapped in a
     texture slot so everything downstream treats it like any other target; the slot does not own it,
     which is why the sampler stays nil and destroy releases nothing it did not create. */
  uint32_t texture_id = 0;
  for (int i = 0; i < MAX_TEXTURES; i++) if (seam->textures[i].texture == nil) { texture_id = (uint32_t)(i + 1); break; }
  if (texture_id == 0) { report(seam, "gpu: out of texture slots for an adopted target"); return target; }
  TextureSlot *texture = &seam->textures[texture_id - 1];
  memset(texture, 0, sizeof(*texture));
  texture->texture = [(id<MTLTexture>)handle retain];
  texture->width = width;
  texture->height = height;
  ReSeamTexture wrapper = {texture_id, width, height};
  ReSeamTexture none = {0, 0, 0};
  return re_seam_target(seam, wrapper, none);
}

void re_seam_target_destroy(ReSeam *seam, ReSeamTarget *target) {
  if (seam == NULL || target == NULL || target->id == 0) return;
  memset(&seam->targets[target->id - 1], 0, sizeof(TargetSlot));
  target->id = 0;
  target->width = 0;
  target->height = 0;
}

/* Begins an encoder on `target`. `clear_*` decide the load actions, which is the only moment Metal
 * offers for a clear — hence re_seam_clear ending an encoder to start another. */
static void begin_encoder(ReSeam *seam, ReSeamTarget target, bool clear_color, const float rgba[4],
                          bool clear_depth) {
  if (target.id == 0) target = seam->frame_target;
  if (target.id == 0 || seam->commands == nil) return;
  const TargetSlot *slot = &seam->targets[target.id - 1];
  MTLRenderPassDescriptor *pass = [MTLRenderPassDescriptor renderPassDescriptor];
  pass.colorAttachments[0].texture = seam->textures[slot->color_texture - 1].texture;
  pass.colorAttachments[0].loadAction = clear_color ? MTLLoadActionClear : MTLLoadActionLoad;
  pass.colorAttachments[0].storeAction = MTLStoreActionStore;
  if (clear_color)
    pass.colorAttachments[0].clearColor = MTLClearColorMake(rgba[0], rgba[1], rgba[2], rgba[3]);
  if (slot->depth_texture) {
    pass.depthAttachment.texture = seam->textures[slot->depth_texture - 1].texture;
    pass.depthAttachment.loadAction = clear_depth ? MTLLoadActionClear : MTLLoadActionLoad;
    pass.depthAttachment.storeAction = MTLStoreActionStore;
    pass.depthAttachment.clearDepth = 1.0;
  }
  seam->encoder = [[seam->commands renderCommandEncoderWithDescriptor:pass] retain];
  seam->encoding = seam->encoder != nil;
  seam->bound = target;
  if (seam->encoding) {
    [seam->encoder setViewport:seam->viewport];
    [seam->encoder setScissorRect:seam->scissor];
  }
}

static void end_encoder(ReSeam *seam) {
  if (!seam->encoding) return;
  [seam->encoder endEncoding];
  [seam->encoder release];
  seam->encoder = nil;
  seam->encoding = false;
}

void re_seam_target_bind(ReSeam *seam, ReSeamTarget target) {
  if (seam == NULL) return;
  if (!seam->in_frame) { seam->bound = target; return; }
  end_encoder(seam);
  begin_encoder(seam, target, false, NULL, false);
}

void re_seam_frame_begin(ReSeam *seam, ReSeamTarget target) {
  if (seam == NULL) return;
  if (seam->in_frame) report(seam, "gpu: re_seam_frame_begin inside a frame that never ended");
  seam->pool = [[NSAutoreleasePool alloc] init];
  seam->commands = [[seam->queue commandBuffer] retain];
  seam->uniform_offset = 0;
  seam->in_frame = true;
  seam->frame_target = target;
  begin_encoder(seam, target, false, NULL, false);
}

void re_seam_frame_end(ReSeam *seam) {
  if (seam == NULL) return;
  if (!seam->in_frame) { report(seam, "gpu: re_seam_frame_end outside a frame"); return; }
  end_encoder(seam);
  /* Managed colour targets need their contents synchronised before the CPU can read them, which is
     what a host doing a read-back is about to do. A blit for every target every frame is more than
     is needed, and it is what keeps re_seam_texture_handle's promise true on this backend. */
  id<MTLBlitCommandEncoder> blit = [seam->commands blitCommandEncoder];
  for (int i = 0; i < MAX_TARGETS; i++) {
    const TargetSlot *slot = &seam->targets[i];
    if (slot->color_texture == 0) continue;
    id<MTLTexture> texture = seam->textures[slot->color_texture - 1].texture;
    if ([texture storageMode] == MTLStorageModeManaged) [blit synchronizeResource:texture];
  }
  [blit endEncoding];
  [seam->commands commit];
  [seam->commands waitUntilCompleted];
  [seam->commands release];
  seam->commands = nil;
  seam->in_frame = false;
  [(NSAutoreleasePool *)seam->pool release];
  seam->pool = NULL;
}

void re_seam_clear(ReSeam *seam, float r, float g, float b, float a, bool depth) {
  if (seam == NULL || !seam->in_frame) return;
  /* Metal has no mid-pass clear: a clear is a load action, so this ends the encoder and begins
     another. The depth half is still masked by the depth write state, because OpenGL masks it and a
     call site relying on that must see the same thing here. */
  const float rgba[4] = {r, g, b, a};
  ReSeamTarget target = seam->bound;
  end_encoder(seam);
  begin_encoder(seam, target, true, rgba, depth && seam->depth_write == RE_SEAM_DEPTH_WRITE_ENABLED);
}

/* ---- pipelines and the draw -------------------------------------------------------------------------- */

static MTLBlendFactor destination(uint8_t blend) {
  return blend == RE_SEAM_BLEND_ADDITIVE ? MTLBlendFactorOne : MTLBlendFactorOneMinusSourceAlpha;
}
static MTLCompareFunction compare_of(uint8_t compare) {
  switch (compare) {
    case RE_SEAM_DEPTH_LESS_EQUAL: return MTLCompareFunctionLessEqual;
    case RE_SEAM_DEPTH_EQUAL: return MTLCompareFunctionEqual;
    case RE_SEAM_DEPTH_ALWAYS: return MTLCompareFunctionAlways;
    default: return MTLCompareFunctionLess;
  }
}
static MTLVertexFormat attribute_format(const ReSeamVertexAttribute *attribute) {
  if (attribute->type == RE_SEAM_ATTRIBUTE_UNORM8) {
    switch (attribute->components) {
      case 1: return MTLVertexFormatUCharNormalized;
      case 2: return MTLVertexFormatUChar2Normalized;
      case 3: return MTLVertexFormatUChar3Normalized;
      default: return MTLVertexFormatUChar4Normalized;
    }
  }
  switch (attribute->components) {
    case 1: return MTLVertexFormatFloat;
    case 2: return MTLVertexFormatFloat2;
    case 3: return MTLVertexFormatFloat3;
    default: return MTLVertexFormatFloat4;
  }
}

/* The vertex buffer sits at index 1 because SPIRV-Cross puts the uniform block at buffer(0), and
 * both live in the same argument table on Metal — unlike Vulkan, where one is a descriptor set and
 * the other a vertex binding. */
#define VERTEX_BUFFER_INDEX 1

static bool pipeline_for(ReSeam *seam, const PipelineKey *key, id<MTLRenderPipelineState> *pipeline,
                         id<MTLDepthStencilState> *depth) {
  for (uint32_t i = 0; i < seam->pipeline_count; i++)
    if (memcmp(&seam->pipelines[i].key, key, sizeof(*key)) == 0) {
      *pipeline = seam->pipelines[i].pipeline;
      *depth = seam->pipelines[i].depth;
      return true;
    }
  if (seam->pipeline_count == MAX_PIPELINES) {
    report(seam, "gpu: the pipeline cache is full (%d); a state combination was not drawn", MAX_PIPELINES);
    return false;
  }
  const ProgramSlot *program = &seam->programs[key->program - 1];
  const ArraySlot *array = &seam->arrays[key->array - 1];

  MTLVertexDescriptor *vertex = [MTLVertexDescriptor vertexDescriptor];
  for (int i = 0; i < array->count; i++) {
    NSUInteger at = (NSUInteger)array->attributes[i].location;
    vertex.attributes[at].format = attribute_format(&array->attributes[i]);
    vertex.attributes[at].offset = (NSUInteger)array->attributes[i].offset;
    vertex.attributes[at].bufferIndex = VERTEX_BUFFER_INDEX;
  }
  vertex.layouts[VERTEX_BUFFER_INDEX].stride = array->stride;
  vertex.layouts[VERTEX_BUFFER_INDEX].stepFunction = MTLVertexStepFunctionPerVertex;

  MTLRenderPipelineDescriptor *descriptor = [[MTLRenderPipelineDescriptor alloc] init];
  descriptor.vertexFunction = program->vertex;
  descriptor.fragmentFunction = program->fragment;
  descriptor.vertexDescriptor = vertex;
  descriptor.colorAttachments[0].pixelFormat = (MTLPixelFormat)key->color_format;
  descriptor.depthAttachmentPixelFormat = (MTLPixelFormat)key->depth_format;
  bool blending = key->blend_color != RE_SEAM_BLEND_NONE || key->blend_alpha != RE_SEAM_BLEND_NONE;
  descriptor.colorAttachments[0].blendingEnabled = blending;
  if (blending) {
    descriptor.colorAttachments[0].sourceRGBBlendFactor =
      key->blend_color == RE_SEAM_BLEND_NONE ? MTLBlendFactorOne : MTLBlendFactorSourceAlpha;
    descriptor.colorAttachments[0].destinationRGBBlendFactor =
      key->blend_color == RE_SEAM_BLEND_NONE ? MTLBlendFactorZero : destination(key->blend_color);
    descriptor.colorAttachments[0].sourceAlphaBlendFactor =
      key->blend_alpha == RE_SEAM_BLEND_NONE ? MTLBlendFactorOne : MTLBlendFactorSourceAlpha;
    descriptor.colorAttachments[0].destinationAlphaBlendFactor =
      key->blend_alpha == RE_SEAM_BLEND_NONE ? MTLBlendFactorZero : destination(key->blend_alpha);
  }
  NSError *failure = nil;
  id<MTLRenderPipelineState> made = [seam->device newRenderPipelineStateWithDescriptor:descriptor
                                                                                error:&failure];
  [descriptor release];
  if (made == nil) {
    report(seam, "gpu: this state combination would not make a pipeline: %s",
           failure ? [[failure localizedDescription] UTF8String] : "unknown");
    return false;
  }
  MTLDepthStencilDescriptor *depth_descriptor = [[MTLDepthStencilDescriptor alloc] init];
  depth_descriptor.depthCompareFunction =
    key->depth_test == RE_SEAM_DEPTH_TEST_ENABLED ? compare_of(key->depth_compare) : MTLCompareFunctionAlways;
  depth_descriptor.depthWriteEnabled = key->depth_write == RE_SEAM_DEPTH_WRITE_ENABLED;
  id<MTLDepthStencilState> depth_state = [seam->device newDepthStencilStateWithDescriptor:depth_descriptor];
  [depth_descriptor release];

  seam->pipelines[seam->pipeline_count].key = *key;
  seam->pipelines[seam->pipeline_count].pipeline = made;
  seam->pipelines[seam->pipeline_count].depth = depth_state;
  seam->pipeline_count++;
  *pipeline = made;
  *depth = depth_state;
  return true;
}

void re_seam_draw(ReSeam *seam, ReSeamPrimitive primitive, int first, int count) {
  if (seam == NULL || !seam->encoding || seam->program == 0 || seam->array == 0 || count <= 0) return;
  const ArraySlot *array = &seam->arrays[seam->array - 1];
  if (array->buffer == 0 || seam->buffers[array->buffer - 1].buffer == nil) return;
  const TargetSlot *target = &seam->targets[seam->bound.id - 1];
  ProgramSlot *program = &seam->programs[seam->program - 1];

  PipelineKey key = {
    .program = seam->program, .array = seam->array,
    .blend_color = seam->blend_color, .blend_alpha = seam->blend_alpha,
    .depth_test = seam->depth_test, .depth_write = seam->depth_write,
    .depth_compare = seam->depth_compare, .cull = seam->cull, .primitive = (uint8_t)primitive,
    .color_format = (int)target->color_format, .depth_format = (int)target->depth_format,
  };
  id<MTLRenderPipelineState> pipeline = nil;
  id<MTLDepthStencilState> depth = nil;
  if (!pipeline_for(seam, &key, &pipeline, &depth)) return;

  if (seam->uniform_offset + UNIFORM_STRIDE > UNIFORM_STRIDE * UNIFORM_SLOTS) {
    report(seam, "gpu: more than %d draws in one frame; the uniform ring wrapped", UNIFORM_SLOTS);
    return;
  }
  size_t slot = seam->uniform_offset;
  if (program->uniforms != NULL)
    memcpy((char *)[seam->uniform_ring contents] + slot, program->uniforms, program->reflect.block_size);
  seam->uniform_offset += UNIFORM_STRIDE;

  [seam->encoder setRenderPipelineState:pipeline];
  [seam->encoder setDepthStencilState:depth];
  /* OpenGL's front face is counter-clockwise and Metal's framebuffer Y runs the other way, which
     mirrors every triangle and reverses the winding it presents — the same reasoning as the Vulkan
     backend's, reaching the same answer. */
  [seam->encoder setFrontFacingWinding:MTLWindingClockwise];
  [seam->encoder setCullMode:(seam->cull == RE_SEAM_CULL_BACK ? MTLCullModeBack : MTLCullModeNone)];
  [seam->encoder setVertexBuffer:seam->uniform_ring offset:slot atIndex:0];
  [seam->encoder setFragmentBuffer:seam->uniform_ring offset:slot atIndex:0];
  [seam->encoder setVertexBuffer:seam->buffers[array->buffer - 1].buffer offset:0
                         atIndex:VERTEX_BUFFER_INDEX];
  for (uint32_t i = 0; i < program->reflect.sampler_count; i++) {
    uint32_t unit = program->reflect.samplers[i].binding - 1u;
    uint32_t texture = unit < MAX_UNITS ? seam->units[unit] : 0;
    if (texture == 0) texture = seam->units[0];
    if (texture == 0) continue;
    [seam->encoder setFragmentTexture:seam->textures[texture - 1].texture atIndex:i];
    [seam->encoder setFragmentSamplerState:seam->textures[texture - 1].sampler atIndex:i];
  }
  [seam->encoder drawPrimitives:(primitive == RE_SEAM_PRIMITIVE_LINES ? MTLPrimitiveTypeLine
                                                                     : MTLPrimitiveTypeTriangle)
                    vertexStart:(NSUInteger)first vertexCount:(NSUInteger)count];
}
