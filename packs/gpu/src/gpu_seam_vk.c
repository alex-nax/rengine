/* The seam's Vulkan backend (F130, charter D52/D53, spec 124).
 *
 * This is the verdict on D14c's bet: that a resource-and-draw API — buffers, textures, programs, a
 * small pipeline state, a draw — can carry Vulkan with command buffers, render passes and barriers
 * built INSIDE the backend, so no call site has to know which graphics API it is talking to. The
 * scene example renders through this file without one line of its drawing code changing.
 *
 * HOW THE THREE HARD PARTS ARE ANSWERED
 *
 * Uniforms by name. Vulkan has no default uniform block; a uniform is a byte range. The backend
 * reflects each program's SPIR-V for its members' names and std140 offsets (gpu_seam_vk_spirv.c), so
 * `uniformLocation("u_model")` answers with an offset and `setUniform` writes into a CPU-side copy.
 * The copy is flushed into a ring buffer at draw time and bound with a dynamic offset. A consumer's
 * shader build therefore changes in exactly one way: it keeps the SPIR-V it already produces.
 *
 * Pipeline state. Blend, depth, cull, the primitive and the vertex layout are loose state in OpenGL
 * and baked into a pipeline in Vulkan. They are collected here and resolved at draw time into a
 * pipeline looked up by that state, created once and cached. This is the part D14c said a backend
 * "can build internally", and it is why the call sites do not change.
 *
 * Render passes. Dynamic rendering, which the pack's device layer already requires as a floor, means
 * a pass is a begin and an end around the target the frame or a call site bound — no VkRenderPass
 * objects and no framebuffers to keep in step with anything.
 *
 * ONE DELIBERATE SIMPLIFICATION, NAMED. Every image lives in VK_IMAGE_LAYOUT_GENERAL. It is legal
 * for both sampling and attachment, and it removes a layout-tracking state machine from a backend
 * whose job here is to answer a design question. It costs bandwidth on tiled hardware, which is
 * exactly where it would matter for the games this is aimed at — so a production backend tracks
 * layouts per image, and this one records the debt instead of pretending it does not exist.
 */
#include "gpu_seam_vk_internal.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "gpu_seam_vk_internal.h"

static _Thread_local ReSeam *current;

static bool say(char *error, size_t size, const char *format, ...) {
  if (error != NULL && size > 0) {
    va_list args; va_start(args, format);
    vsnprintf(error, size, format, args);
    va_end(args);
  }
  return false;
}
void re_seam_vk_report(ReSeam *seam, const char *format, ...) {
  if (seam == NULL || seam->on_message == NULL) return;
  char message[1024];
  va_list args; va_start(args, format);
  vsnprintf(message, sizeof(message), format, args);
  va_end(args);
  seam->on_message(seam->message_user, message);
}
#define report re_seam_vk_report

const char *re_seam_backend(void) { return "vulkan"; }
void re_seam_make_current(ReSeam *seam) { current = seam; }
ReSeam *re_seam_current(void) { return current; }

/* ---- memory ------------------------------------------------------------------------------------- */

static bool make_buffer(ReSeam *seam, BufferSlot *slot, VkDeviceSize size, VkBufferUsageFlags usage) {
  VkBufferCreateInfo info = {.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, .size = size,
                             .usage = usage, .sharingMode = VK_SHARING_MODE_EXCLUSIVE};
  if (seam->vkCreateBuffer(seam->device, &info, NULL, &slot->buffer) != VK_SUCCESS) return false;
  VkMemoryRequirements need;
  seam->vkGetBufferMemoryRequirements(seam->device, slot->buffer, &need);
  /* Host-visible and coherent throughout. A staging-and-copy path would be faster for static
     geometry and is what a production backend does; this one keeps the upload path to one memcpy
     because the question being answered is about the API's shape, not its bandwidth. */
  uint32_t type = re_gpu_memory_type(seam->gpu, need.memoryTypeBits,
                                     VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
  if (type == UINT32_MAX) return false;
  VkMemoryAllocateInfo allocate = {.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
                                   .allocationSize = need.size, .memoryTypeIndex = type};
  if (seam->vkAllocateMemory(seam->device, &allocate, NULL, &slot->memory) != VK_SUCCESS) return false;
  seam->vkBindBufferMemory(seam->device, slot->buffer, slot->memory, 0);
  seam->counters.allocations++;
  if (seam->vkMapMemory(seam->device, slot->memory, 0, VK_WHOLE_SIZE, 0, &slot->mapped) != VK_SUCCESS)
    return false;
  slot->size = size;
  return true;
}

static void drop_buffer(ReSeam *seam, BufferSlot *slot) {
  if (slot->mapped) seam->vkUnmapMemory(seam->device, slot->memory);
  if (slot->buffer) seam->vkDestroyBuffer(seam->device, slot->buffer, NULL);
  if (slot->memory) seam->vkFreeMemory(seam->device, slot->memory, NULL);
  memset(slot, 0, sizeof(*slot));
}

static void drop_generations(ReSeam *seam, VertexBuffer *vertex) {
  for (int i = 0; i < vertex->capacity; i++) drop_buffer(seam, &vertex->pool[i]);
  free(vertex->pool);
  vertex->pool = NULL;
  vertex->capacity = 0;
  vertex->used = 0;
  memset(&vertex->current, 0, sizeof(vertex->current));
}

/* ---- open and close ------------------------------------------------------------------------------
 * The host has already made a device: `options->user` is its `ReGpu *`. The OpenGL backend takes a
 * `glGetProcAddress` for the same reason — entry points are the host's, and on Vulkan the host's
 * device choice is too, because only it can answer which adapter its window or its headset is on. */

ReSeam *re_seam_open(const ReSeamOpen *options, char *error, size_t error_size) {
  if (options == NULL || options->user == NULL) {
    say(error, error_size, "the Vulkan backend needs the host's ReGpu* in ReSeamOpen.user "
                           "(re_gpu_open made it; the seam creates no device of its own)");
    return NULL;
  }
  ReSeam *seam = calloc(1, sizeof(*seam));
  if (seam == NULL) { say(error, error_size, "out of memory"); return NULL; }
  seam->gpu = (ReGpu *)options->user;
  seam->device = re_gpu_device(seam->gpu);
  seam->queue = re_gpu_queue(seam->gpu);
  seam->on_message = options->on_message;
  seam->message_user = options->message_user;

#define RE_SEAM_VK_LOAD(name)                                                                       \
  seam->name = (PFN_##name)re_gpu_device_proc(seam->gpu, #name);                                    \
  if (seam->name == NULL) {                                                                          \
    say(error, error_size, "the device has no %s", #name);                                           \
    free(seam);                                                                                      \
    return NULL;                                                                                     \
  }
  RE_SEAM_VK_DEVICE_FUNCTIONS(RE_SEAM_VK_LOAD)
#undef RE_SEAM_VK_LOAD

  VkCommandPoolCreateInfo pool = {.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,
                                  .flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT,
                                  .queueFamilyIndex = re_gpu_family(seam->gpu)};
  if (seam->vkCreateCommandPool(seam->device, &pool, NULL, &seam->pool) != VK_SUCCESS) {
    say(error, error_size, "vkCreateCommandPool failed");
    free(seam);
    return NULL;
  }
  VkCommandBufferAllocateInfo allocate = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
                                          .commandPool = seam->pool,
                                          .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
                                          .commandBufferCount = 1};
  if (seam->vkAllocateCommandBuffers(seam->device, &allocate, &seam->cmd) != VK_SUCCESS) {
    say(error, error_size, "vkAllocateCommandBuffers failed");
    free(seam);
    return NULL;
  }

  VkDescriptorPoolSize sizes[2] = {
    {VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, UNIFORM_SLOTS},
    {VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, UNIFORM_SLOTS},
  };
  VkDescriptorPoolCreateInfo descriptors = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
                                            .maxSets = UNIFORM_SLOTS, .poolSizeCount = 2,
                                            .pPoolSizes = sizes};
  if (seam->vkCreateDescriptorPool(seam->device, &descriptors, NULL, &seam->descriptors) != VK_SUCCESS) {
    say(error, error_size, "vkCreateDescriptorPool failed");
    free(seam);
    return NULL;
  }

  /* One slot per draw. The alignment is the device's, asked rather than assumed — 256 on many
     desktops and 64 on some mobile parts, and a wrong guess is a validation error per draw. */
  VkPhysicalDeviceProperties properties;
  PFN_vkGetPhysicalDeviceProperties get_properties =
    (PFN_vkGetPhysicalDeviceProperties)re_gpu_instance_proc(seam->gpu, "vkGetPhysicalDeviceProperties");
  get_properties(re_gpu_physical(seam->gpu), &properties);
  VkDeviceSize alignment = properties.limits.minUniformBufferOffsetAlignment;
  seam->uniform_stride = ((256u + alignment - 1) / (alignment ? alignment : 1)) * (alignment ? alignment : 1);
  if (!make_buffer(seam, &seam->uniform_ring, seam->uniform_stride * UNIFORM_SLOTS,
                   VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT)) {
    say(error, error_size, "the uniform ring buffer could not be allocated");
    free(seam);
    return NULL;
  }
  seam->depth_compare = RE_SEAM_DEPTH_LESS;
  return seam;
}

void re_seam_close(ReSeam *seam) {
  if (seam == NULL) return;
  seam->vkDeviceWaitIdle(seam->device);
  for (uint32_t i = 0; i < seam->pipeline_count; i++)
    seam->vkDestroyPipeline(seam->device, seam->pipelines[i].pipeline, NULL);
  for (int i = 0; i < MAX_BUFFERS; i++) drop_generations(seam, &seam->buffers[i]);
  for (int i = 0; i < MAX_TEXTURES; i++) {
    TextureSlot *t = &seam->textures[i];
    if (t->view) seam->vkDestroyImageView(seam->device, t->view, NULL);
    if (t->sampler) seam->vkDestroySampler(seam->device, t->sampler, NULL);
    if (t->image) seam->vkDestroyImage(seam->device, t->image, NULL);
    if (t->memory) seam->vkFreeMemory(seam->device, t->memory, NULL);
  }
  for (int i = 0; i < MAX_PROGRAMS; i++) {
    ProgramSlot *p = &seam->programs[i];
    if (p->vertex) seam->vkDestroyShaderModule(seam->device, p->vertex, NULL);
    if (p->fragment) seam->vkDestroyShaderModule(seam->device, p->fragment, NULL);
    if (p->layout) seam->vkDestroyPipelineLayout(seam->device, p->layout, NULL);
    if (p->set_layout) seam->vkDestroyDescriptorSetLayout(seam->device, p->set_layout, NULL);
    free(p->uniforms);
  }
  drop_buffer(seam, &seam->uniform_ring);
  if (seam->descriptors) seam->vkDestroyDescriptorPool(seam->device, seam->descriptors, NULL);
  if (seam->pool) seam->vkDestroyCommandPool(seam->device, seam->pool, NULL);
  if (current == seam) current = NULL;
  free(seam);
}

const char *re_seam_api_version(ReSeam *seam) {
  return seam != NULL ? re_gpu_device_name(seam->gpu) : "unknown";
}

/* ---- buffers -------------------------------------------------------------------------------------- */

static uint32_t claim(const void *table, size_t stride, int count, size_t live_offset) {
  for (int i = 0; i < count; i++) {
    const char *entry = (const char *)table + (size_t)i * stride;
    if (*(const void *const *)(entry + live_offset) == NULL) return (uint32_t)(i + 1);
  }
  return 0;   /* 0 is "none", so a full table reports failure the same way an error does */
}

ReSeamBuffer re_seam_buffer(ReSeam *seam) {
  ReSeamBuffer handle = {0};
  if (seam == NULL) return handle;
  uint32_t id = claim(seam->buffers, sizeof(VertexBuffer), MAX_BUFFERS, offsetof(VertexBuffer, current.buffer));
  if (id == 0) { report(seam, "gpu: out of buffer slots"); return handle; }
  /* Vulkan needs a size up front and the seam's API does not carry one, so a buffer starts empty and
     re_seam_buffer_update makes it the size it is asked for. */
  handle.id = id;
  return handle;
}

void re_seam_buffer_destroy(ReSeam *seam, ReSeamBuffer *buffer) {
  if (seam == NULL || buffer == NULL || buffer->id == 0) return;
  drop_generations(seam, &seam->buffers[buffer->id - 1]);
  buffer->id = 0;
}

void re_seam_buffer_update(ReSeam *seam, ReSeamBuffer buffer, const void *data, size_t bytes,
                           ReSeamBufferUsage usage) {
  (void)usage;   /* a hint with no Vulkan equivalent; recorded as untested in spec 123 */
  if (seam == NULL || buffer.id == 0 || bytes == 0) return;
  VertexBuffer *vertex = &seam->buffers[buffer.id - 1];
  int generation = vertex->used;
  if (generation >= vertex->capacity) {
    int capacity = vertex->capacity ? vertex->capacity * 2 : 8;
    BufferSlot *pool = realloc(vertex->pool, (size_t)capacity * sizeof(*pool));
    if (pool == NULL) { report(seam, "gpu: out of memory growing a buffer pool"); return; }
    memset(pool + vertex->capacity, 0, (size_t)(capacity - vertex->capacity) * sizeof(*pool));
    vertex->pool = pool;
    vertex->capacity = capacity;
  }
  BufferSlot *slot = &vertex->pool[generation];
  if (slot->size < bytes) {
    /* Growing means the old buffer may still be referenced by commands in flight. The frame is
       submitted and waited on at its end, so nothing is in flight here — a pipelined backend would
       need a deletion queue, and that is the cost of the simple submit model this uses. */
    if (slot->buffer) {
      seam->vkDeviceWaitIdle(seam->device);
      drop_buffer(seam, slot);
    }
    if (!make_buffer(seam, slot, bytes, VK_BUFFER_USAGE_VERTEX_BUFFER_BIT)) {
      report(seam, "gpu: a vertex buffer of %zu bytes could not be allocated", bytes);
      return;
    }
  }
  vertex->used = generation + 1;
  vertex->current = *slot;
  if (data != NULL) memcpy(slot->mapped, data, bytes);
}

ReSeamCounters re_seam_counters(ReSeam *seam) {
  ReSeamCounters none = {0, 0, 0};
  return seam ? seam->counters : none;
}

/* ---- textures ------------------------------------------------------------------------------------- */

static void barrier(ReSeam *seam, VkImage image, VkImageAspectFlags aspect) {
  /* Everything stays in GENERAL, so this is purely an execution and memory barrier: what was written
     before is visible to what reads after. It is deliberately the widest one that is correct. */
  VkImageMemoryBarrier change = {
    .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
    .srcAccessMask = VK_ACCESS_MEMORY_WRITE_BIT, .dstAccessMask = VK_ACCESS_MEMORY_READ_BIT | VK_ACCESS_MEMORY_WRITE_BIT,
    .oldLayout = VK_IMAGE_LAYOUT_GENERAL, .newLayout = VK_IMAGE_LAYOUT_GENERAL,
    .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED, .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
    .image = image,
    .subresourceRange = {.aspectMask = aspect, .levelCount = 1, .layerCount = 1},
  };
  seam->vkCmdPipelineBarrier(seam->cmd, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT,
                             VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, 0, 0, NULL, 0, NULL, 1, &change);
}

static void upload(ReSeam *seam, TextureSlot *slot, int x, int y, int width, int height, const void *rgba) {
  BufferSlot staging = {0};
  size_t bytes = (size_t)width * (size_t)height * (slot->coverage ? 1u : 4u);
  if (!make_buffer(seam, &staging, bytes, VK_BUFFER_USAGE_TRANSFER_SRC_BIT)) {
    report(seam, "gpu: no staging memory for a %dx%d upload", width, height);
    return;
  }
  memcpy(staging.mapped, rgba, bytes);
  /* Uploads happen outside the frame's command buffer on a one-shot buffer of their own: a texture
     can be created at any time, including before the first frame has begun. */
  VkCommandBuffer cmd;
  VkCommandBufferAllocateInfo allocate = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
                                          .commandPool = seam->pool,
                                          .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY, .commandBufferCount = 1};
  if (seam->vkAllocateCommandBuffers(seam->device, &allocate, &cmd) != VK_SUCCESS) {
    drop_buffer(seam, &staging);
    return;
  }
  VkCommandBufferBeginInfo begin = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
                                    .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT};
  seam->vkBeginCommandBuffer(cmd, &begin);
  VkBufferImageCopy region = {
    .imageSubresource = {.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT, .layerCount = 1},
    .imageOffset = {x, y, 0},
    .imageExtent = {(uint32_t)width, (uint32_t)height, 1},
  };
  seam->vkCmdCopyBufferToImage(cmd, staging.buffer, slot->image, VK_IMAGE_LAYOUT_GENERAL, 1, &region);
  seam->vkEndCommandBuffer(cmd);
  VkSubmitInfo submit = {.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &cmd};
  seam->vkQueueSubmit(seam->queue, 1, &submit, VK_NULL_HANDLE);
  seam->vkQueueWaitIdle(seam->queue);
  drop_buffer(seam, &staging);
}

/* A new image starts in UNDEFINED and must reach GENERAL before anything touches it. */
static void settle(ReSeam *seam, TextureSlot *slot) {
  VkCommandBuffer cmd;
  VkCommandBufferAllocateInfo allocate = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
                                          .commandPool = seam->pool,
                                          .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY, .commandBufferCount = 1};
  if (seam->vkAllocateCommandBuffers(seam->device, &allocate, &cmd) != VK_SUCCESS) return;
  VkCommandBufferBeginInfo begin = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
                                    .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT};
  seam->vkBeginCommandBuffer(cmd, &begin);
  VkImageMemoryBarrier change = {
    .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
    .dstAccessMask = VK_ACCESS_MEMORY_READ_BIT | VK_ACCESS_MEMORY_WRITE_BIT,
    .oldLayout = VK_IMAGE_LAYOUT_UNDEFINED, .newLayout = VK_IMAGE_LAYOUT_GENERAL,
    .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED, .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
    .image = slot->image,
    .subresourceRange = {.aspectMask = slot->depth ? VK_IMAGE_ASPECT_DEPTH_BIT : VK_IMAGE_ASPECT_COLOR_BIT,
                         .levelCount = 1, .layerCount = 1},
  };
  seam->vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT,
                             0, 0, NULL, 0, NULL, 1, &change);
  seam->vkEndCommandBuffer(cmd);
  VkSubmitInfo submit = {.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &cmd};
  seam->vkQueueSubmit(seam->queue, 1, &submit, VK_NULL_HANDLE);
  seam->vkQueueWaitIdle(seam->queue);
}

ReSeamTexture re_seam_texture_2d_for(ReSeam *seam, const void *rgba, int width, int height,
                                     ReSeamFilter filter, ReSeamWrap wrap, ReSeamTextureUse use) {
  ReSeamTexture handle = {0};
  if (seam == NULL || width <= 0 || height <= 0) return handle;
  uint32_t id = claim(seam->textures, sizeof(TextureSlot), MAX_TEXTURES, offsetof(TextureSlot, image));
  if (id == 0) { report(seam, "gpu: out of texture slots"); return handle; }
  TextureSlot *slot = &seam->textures[id - 1];
  memset(slot, 0, sizeof(*slot));
  slot->width = width;
  slot->height = height;
  slot->depth = use == RE_SEAM_TEXTURE_DEPTH;
  slot->coverage = use == RE_SEAM_TEXTURE_COVERAGE;
  slot->format = slot->depth ? VK_FORMAT_D32_SFLOAT
               : slot->coverage ? VK_FORMAT_R8_UNORM : VK_FORMAT_R8G8B8A8_UNORM;

  VkImageCreateInfo info = {
    .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D,
    .format = slot->format, .extent = {(uint32_t)width, (uint32_t)height, 1},
    .mipLevels = 1, .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT,
    .tiling = VK_IMAGE_TILING_OPTIMAL,
    /* TRANSFER_SRC as well as DST, because `re_seam_texture_handle` promises a host the image and a
       host's reason for wanting it is usually to copy out of it — a read-back, an encoder, a
       runtime. Leaving it off made the first validated run report a legal-use error on the example's
       own snapshot path, which is the sort of thing that works on one driver and not the next. */
    .usage = (VkImageUsageFlags)(VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT |
             VK_IMAGE_USAGE_TRANSFER_SRC_BIT |
             (slot->depth ? VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT : VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT)),
    .sharingMode = VK_SHARING_MODE_EXCLUSIVE, .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
  };
  if (seam->vkCreateImage(seam->device, &info, NULL, &slot->image) != VK_SUCCESS) {
    report(seam, "gpu: vkCreateImage failed for %dx%d", width, height);
    return handle;
  }
  VkMemoryRequirements need;
  seam->vkGetImageMemoryRequirements(seam->device, slot->image, &need);
  uint32_t type = re_gpu_memory_type(seam->gpu, need.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
  VkMemoryAllocateInfo allocate = {.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
                                   .allocationSize = need.size, .memoryTypeIndex = type};
  if (type == UINT32_MAX ||
      seam->vkAllocateMemory(seam->device, &allocate, NULL, &slot->memory) != VK_SUCCESS) {
    report(seam, "gpu: no device memory for a %dx%d image", width, height);
    return handle;
  }
  seam->vkBindImageMemory(seam->device, slot->image, slot->memory, 0);

  VkImageViewCreateInfo view = {
    .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = slot->image,
    .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = slot->format,
    .subresourceRange = {.aspectMask = slot->depth ? VK_IMAGE_ASPECT_DEPTH_BIT : VK_IMAGE_ASPECT_COLOR_BIT,
                         .levelCount = 1, .layerCount = 1},
  };
  seam->vkCreateImageView(seam->device, &view, NULL, &slot->view);
  seam->counters.allocations++;

  VkFilter gl_filter = filter == RE_SEAM_FILTER_NEAREST ? VK_FILTER_NEAREST : VK_FILTER_LINEAR;
  VkSamplerAddressMode mode = wrap == RE_SEAM_WRAP_REPEAT ? VK_SAMPLER_ADDRESS_MODE_REPEAT
                                                          : VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
  VkSamplerCreateInfo sampler = {
    .sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO, .magFilter = gl_filter, .minFilter = gl_filter,
    .mipmapMode = VK_SAMPLER_MIPMAP_MODE_NEAREST,
    .addressModeU = mode, .addressModeV = mode, .addressModeW = mode, .maxLod = 0.0f,
  };
  seam->vkCreateSampler(seam->device, &sampler, NULL, &slot->sampler);

  settle(seam, slot);
  if (rgba != NULL && !slot->depth) upload(seam, slot, 0, 0, width, height, rgba);
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
  upload(seam, &seam->textures[texture.id - 1], x, y, width, height, rgba);
}

void re_seam_texture_destroy(ReSeam *seam, ReSeamTexture *texture) {
  if (seam == NULL || texture == NULL || texture->id == 0) return;
  TextureSlot *slot = &seam->textures[texture->id - 1];
  seam->vkDeviceWaitIdle(seam->device);
  if (slot->view) seam->vkDestroyImageView(seam->device, slot->view, NULL);
  if (slot->sampler) seam->vkDestroySampler(seam->device, slot->sampler, NULL);
  if (slot->image) seam->vkDestroyImage(seam->device, slot->image, NULL);
  if (slot->memory) seam->vkFreeMemory(seam->device, slot->memory, NULL);
  memset(slot, 0, sizeof(*slot));
  texture->id = 0;
  texture->width = 0;
  texture->height = 0;
}

uintptr_t re_seam_texture_handle(ReSeam *seam, ReSeamTexture texture) {
  if (seam == NULL || texture.id == 0) return 0;
  return (uintptr_t)seam->textures[texture.id - 1].image;
}

void re_seam_texture_bind(ReSeam *seam, ReSeamTexture texture, int unit) {
  if (seam == NULL || unit < 0 || unit >= MAX_UNITS) return;
  seam->units[unit] = texture.id;
}

/* ---- programs --------------------------------------------------------------------------------------
 * A program is two shader modules, a descriptor set layout holding the uniform block and its
 * samplers, and the reflected map from uniform NAME to byte offset — which is the whole of what
 * makes `uniformLocation("u_model")` mean anything on an API that has no such call. */

static VkShaderModule module_of(ReSeam *seam, const ReSeamShader *stage, const char *debug_name) {
  if (stage == NULL || stage->spirv == NULL || stage->spirv_bytes == 0) {
    report(seam, "gpu: %s has no SPIR-V for this stage — the Vulkan backend needs ReSeamShader.spirv, "
                 "which the shader generator emits alongside the GLSL", debug_name);
    return VK_NULL_HANDLE;
  }
  VkShaderModuleCreateInfo info = {.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
                                   .codeSize = stage->spirv_bytes, .pCode = stage->spirv};
  VkShaderModule module = VK_NULL_HANDLE;
  if (seam->vkCreateShaderModule(seam->device, &info, NULL, &module) != VK_SUCCESS) {
    report(seam, "gpu: %s: vkCreateShaderModule failed", debug_name);
    return VK_NULL_HANDLE;
  }
  return module;
}

ReSeamProgram re_seam_program(ReSeam *seam, const ReSeamShader *vertex, const ReSeamShader *fragment,
                              const char *debug_name) {
  ReSeamProgram handle = {0};
  if (seam == NULL) return handle;
  uint32_t id = claim(seam->programs, sizeof(ProgramSlot), MAX_PROGRAMS, offsetof(ProgramSlot, vertex));
  if (id == 0) { report(seam, "gpu: out of program slots"); return handle; }
  ProgramSlot *slot = &seam->programs[id - 1];
  memset(slot, 0, sizeof(*slot));

  slot->vertex = module_of(seam, vertex, debug_name);
  slot->fragment = module_of(seam, fragment, debug_name);
  if (slot->vertex == VK_NULL_HANDLE || slot->fragment == VK_NULL_HANDLE) {
    if (slot->vertex) seam->vkDestroyShaderModule(seam->device, slot->vertex, NULL);
    if (slot->fragment) seam->vkDestroyShaderModule(seam->device, slot->fragment, NULL);
    memset(slot, 0, sizeof(*slot));
    return handle;
  }

  char error[256] = {0};
  if (!re_spirv_reflect(vertex->spirv, vertex->spirv_bytes, &slot->reflect, error, sizeof(error)) ||
      !re_spirv_reflect(fragment->spirv, fragment->spirv_bytes, &slot->reflect, error, sizeof(error))) {
    report(seam, "gpu: %s: %s", debug_name, error);
    seam->vkDestroyShaderModule(seam->device, slot->vertex, NULL);
    seam->vkDestroyShaderModule(seam->device, slot->fragment, NULL);
    memset(slot, 0, sizeof(*slot));
    return handle;
  }
  if (slot->reflect.block_size > 0) {
    slot->uniforms = calloc(1, slot->reflect.block_size);
    if (slot->uniforms == NULL) { report(seam, "gpu: %s: out of memory", debug_name); return handle; }
  }

  VkDescriptorSetLayoutBinding bindings[1 + RE_SPIRV_MAX_SAMPLERS];
  uint32_t binding_count = 0;
  bindings[binding_count++] = (VkDescriptorSetLayoutBinding){
    .binding = slot->reflect.block_binding, .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC,
    .descriptorCount = 1, .stageFlags = VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT};
  for (uint32_t i = 0; i < slot->reflect.sampler_count; i++)
    bindings[binding_count++] = (VkDescriptorSetLayoutBinding){
      .binding = slot->reflect.samplers[i].binding,
      .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, .descriptorCount = 1,
      .stageFlags = VK_SHADER_STAGE_FRAGMENT_BIT};
  VkDescriptorSetLayoutCreateInfo set_info = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
                                              .bindingCount = binding_count, .pBindings = bindings};
  seam->vkCreateDescriptorSetLayout(seam->device, &set_info, NULL, &slot->set_layout);
  VkPipelineLayoutCreateInfo layout_info = {.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                            .setLayoutCount = 1, .pSetLayouts = &slot->set_layout};
  seam->vkCreatePipelineLayout(seam->device, &layout_info, NULL, &slot->layout);
  handle.id = id;
  return handle;
}

void re_seam_program_destroy(ReSeam *seam, ReSeamProgram *program) {
  if (seam == NULL || program == NULL || program->id == 0) return;
  ProgramSlot *slot = &seam->programs[program->id - 1];
  seam->vkDeviceWaitIdle(seam->device);
  /* A pipeline outlives nothing: it names this program's layout, so it goes first. */
  for (uint32_t i = 0; i < seam->pipeline_count;) {
    if (seam->pipelines[i].key.program == program->id) {
      seam->vkDestroyPipeline(seam->device, seam->pipelines[i].pipeline, NULL);
      seam->pipelines[i] = seam->pipelines[--seam->pipeline_count];
    } else i++;
  }
  if (slot->vertex) seam->vkDestroyShaderModule(seam->device, slot->vertex, NULL);
  if (slot->fragment) seam->vkDestroyShaderModule(seam->device, slot->fragment, NULL);
  if (slot->layout) seam->vkDestroyPipelineLayout(seam->device, slot->layout, NULL);
  if (slot->set_layout) seam->vkDestroyDescriptorSetLayout(seam->device, slot->set_layout, NULL);
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
  /* A sampler is not in the block, so its "location" is its binding with a bit set. The caller then
     passes that location to setUniform with a texture unit, exactly as it does on OpenGL, and this
     backend ignores the unit because the binding already says where the texture goes. */
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

void re_seam_uniform_int(ReSeam *seam, int location, int value) {
  write_uniform(seam, location, &value, sizeof(value));
}
void re_seam_uniform_float(ReSeam *seam, int location, float value) {
  write_uniform(seam, location, &value, sizeof(value));
}
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

/* ---- state ------------------------------------------------------------------------------------------
 * All of it is recorded and none of it is acted on until a draw, because in Vulkan it is not state at
 * all — it is part of a pipeline. This is the "coalesce at draw time" D14c bet, and it is four lines. */

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
void re_seam_cull(ReSeam *seam, ReSeamCull cull) {
  if (seam != NULL) seam->cull = (uint8_t)cull;
}
void re_seam_viewport(ReSeam *seam, int x, int y, int width, int height) {
  if (seam == NULL) return;
  /* NO viewport flip, and that is the interesting decision in this file.

     Vulkan's clip space has +Y down where OpenGL's has it up, and the usual fix is a negative-height
     viewport. That was the first version here, and it made the main pass match OpenGL exactly while
     breaking every render-to-texture: with the flip, NDC -1 lands in the LAST row of the image,
     where OpenGL puts it in the first. Sampling that texture then reads it upside down — which is
     what the example's off-screen inset showed, and the only place in the whole frame where the two
     backends disagreed.

     Without the flip both APIs store NDC -1 in row 0, so a texture rendered into and sampled gives
     the same image on both, and a read-back needs no correction either. What it costs is the
     presented window: a swapchain image drawn this way appears upside down, and a windowed Vulkan
     host has to flip for its own final pass. That is the right place for it — presentation belongs
     to whoever owns the swapchain, which the seam deliberately is not — and it keeps the property a
     call site actually depends on, which is that a texture means the same thing on every backend. */
  seam->viewport = (VkViewport){.x = (float)x, .y = (float)y,
                                .width = (float)width, .height = (float)height,
                                .minDepth = 0.0f, .maxDepth = 1.0f};
  if (!seam->scissor_on)
    seam->scissor = (VkRect2D){{x, y}, {(uint32_t)(width < 0 ? 0 : width), (uint32_t)(height < 0 ? 0 : height)}};
}
void re_seam_scissor(ReSeam *seam, int x, int y, int width, int height) {
  if (seam == NULL) return;
  if (width < 0 || height < 0) {
    seam->scissor_on = false;
    seam->scissor = (VkRect2D){{(int32_t)seam->viewport.x, (int32_t)seam->viewport.y},
                               {(uint32_t)seam->viewport.width, (uint32_t)seam->viewport.height}};
    return;
  }
  seam->scissor_on = true;
  seam->scissor = (VkRect2D){{x, y}, {(uint32_t)width, (uint32_t)height}};
}

/* ---- targets and the frame -------------------------------------------------------------------------- */

ReSeamTarget re_seam_target(ReSeam *seam, ReSeamTexture color, ReSeamTexture depth) {
  ReSeamTarget handle = {0};
  if (seam == NULL || color.id == 0) {
    report(seam, "gpu: a render target needs a colour texture");
    return handle;
  }
  uint32_t id = 0;
  for (int i = 0; i < MAX_TARGETS; i++) if (seam->targets[i].color == VK_NULL_HANDLE) { id = (uint32_t)(i + 1); break; }
  if (id == 0) { report(seam, "gpu: out of render-target slots"); return handle; }
  TargetSlot *slot = &seam->targets[id - 1];
  memset(slot, 0, sizeof(*slot));
  TextureSlot *colour = &seam->textures[color.id - 1];
  slot->color = colour->view;
  slot->color_texture = color.id;
  slot->color_format = colour->format;
  slot->width = colour->width;
  slot->height = colour->height;
  if (depth.id != 0) {
    TextureSlot *z = &seam->textures[depth.id - 1];
    slot->depth = z->view;
    slot->depth_texture = depth.id;
    slot->depth_format = z->format;
  }
  handle.id = id;
  handle.width = slot->width;
  handle.height = slot->height;
  return handle;
}

ReSeamTarget re_seam_target_adopt(ReSeam *seam, uintptr_t handle, int width, int height, int format) {
  ReSeamTarget target = {0};
  if (seam == NULL || handle == 0) return target;
  uint32_t id = 0;
  for (int i = 0; i < MAX_TARGETS; i++) if (seam->targets[i].color == VK_NULL_HANDLE) { id = (uint32_t)(i + 1); break; }
  if (id == 0) { report(seam, "gpu: out of render-target slots"); return target; }
  TargetSlot *slot = &seam->targets[id - 1];
  memset(slot, 0, sizeof(*slot));
  /* The host's handle is a VkImageView here, as the header says, and it brings no depth attachment.
     Its FORMAT the host must state, because a view cannot be asked for one and the pipeline needs
     it exactly right; 0 keeps the long-standing assumption for a caller that has none. */
  slot->color = (VkImageView)handle;
  slot->color_format = format ? (VkFormat)format : VK_FORMAT_R8G8B8A8_UNORM;
  slot->width = width;
  slot->height = height;
  target.id = id;
  target.width = width;
  target.height = height;
  return target;
}

void re_seam_target_destroy(ReSeam *seam, ReSeamTarget *target) {
  if (seam == NULL || target == NULL || target->id == 0) return;
  memset(&seam->targets[target->id - 1], 0, sizeof(TargetSlot));
  target->id = 0;
  target->width = 0;
  target->height = 0;
}

static void end_pass(ReSeam *seam) {
  if (!seam->pass_open) return;
  seam->vkCmdEndRendering(seam->cmd);
  seam->pass_open = false;
  /* What the pass wrote must be visible to whatever samples it next — the off-screen pass shown in
     the example's corner is exactly this case, and without the barrier it is a race. */
  const TargetSlot *slot = &seam->targets[seam->bound.id - 1];
  if (slot->color_texture)
    barrier(seam, seam->textures[slot->color_texture - 1].image, VK_IMAGE_ASPECT_COLOR_BIT);
}

static void begin_pass(ReSeam *seam, ReSeamTarget target) {
  if (target.id == 0) target = seam->frame_target;
  if (target.id == 0) return;
  const TargetSlot *slot = &seam->targets[target.id - 1];
  VkRenderingAttachmentInfo colour = {
    .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = slot->color,
    .imageLayout = VK_IMAGE_LAYOUT_GENERAL, .loadOp = VK_ATTACHMENT_LOAD_OP_LOAD,
    .storeOp = VK_ATTACHMENT_STORE_OP_STORE};
  VkRenderingAttachmentInfo depth = {
    .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = slot->depth,
    .imageLayout = VK_IMAGE_LAYOUT_GENERAL, .loadOp = VK_ATTACHMENT_LOAD_OP_LOAD,
    .storeOp = VK_ATTACHMENT_STORE_OP_STORE};
  VkRenderingInfo info = {
    .sType = VK_STRUCTURE_TYPE_RENDERING_INFO,
    .renderArea = {{0, 0}, {(uint32_t)slot->width, (uint32_t)slot->height}},
    .layerCount = 1, .colorAttachmentCount = 1, .pColorAttachments = &colour,
    .pDepthAttachment = slot->depth ? &depth : NULL};
  seam->vkCmdBeginRendering(seam->cmd, &info);
  seam->pass_open = true;
  seam->bound = target;
}

void re_seam_target_bind(ReSeam *seam, ReSeamTarget target) {
  if (seam == NULL || !seam->in_frame) {
    if (seam != NULL) seam->bound = target;
    return;
  }
  end_pass(seam);
  begin_pass(seam, target);
}

void re_seam_frame_begin(ReSeam *seam, ReSeamTarget target) {
  if (seam == NULL) return;
  if (seam->in_frame) report(seam, "gpu: re_seam_frame_begin inside a frame that never ended");
  seam->vkResetDescriptorPool(seam->device, seam->descriptors, 0);
  seam->uniform_offset = 0;
  /* Every buffer starts the frame at its first generation: the previous frame was waited on at its
     end, so nothing still reads them. */
  for (int i = 0; i < MAX_BUFFERS; i++) seam->buffers[i].used = 0;
  VkCommandBufferBeginInfo begin = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
                                    .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT};
  seam->vkBeginCommandBuffer(seam->cmd, &begin);
  seam->counters.frames++;
  seam->in_frame = true;
  seam->frame_target = target;
  begin_pass(seam, target);
}

void re_seam_frame_end(ReSeam *seam) {
  if (seam == NULL) return;
  if (!seam->in_frame) { report(seam, "gpu: re_seam_frame_end outside a frame"); return; }
  end_pass(seam);
  seam->vkEndCommandBuffer(seam->cmd);
  VkSubmitInfo submit = {.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1,
                         .pCommandBuffers = &seam->cmd};
  seam->vkQueueSubmit(seam->queue, 1, &submit, VK_NULL_HANDLE);
  /* One frame in flight. A pipelined backend would use fences and a deletion queue; this one waits,
     which is honest about what it is for and keeps every resource path free of lifetime puzzles. */
  seam->vkQueueWaitIdle(seam->queue);
  seam->in_frame = false;
}

void re_seam_clear(ReSeam *seam, float r, float g, float b, float a, bool depth) {
  if (seam == NULL || !seam->pass_open) return;
  VkClearAttachment attachments[2];
  uint32_t count = 0;
  attachments[count++] = (VkClearAttachment){
    .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT, .colorAttachment = 0,
    .clearValue = {.color = {{r, g, b, a}}}};
  /* A depth clear is a no-op unless depth writes are on — GL masks the clear by the write mask, and
     matching that here is what "no call-site difference between backends" has to mean: a call site
     that relies on the masking must see the same thing on both. */
  const TargetSlot *slot = &seam->targets[seam->bound.id - 1];
  if (depth && slot->depth && seam->depth_write == RE_SEAM_DEPTH_WRITE_ENABLED)
    attachments[count++] = (VkClearAttachment){.aspectMask = VK_IMAGE_ASPECT_DEPTH_BIT,
                                               .clearValue = {.depthStencil = {1.0f, 0}}};
  VkClearRect rect = {.rect = {{0, 0}, {(uint32_t)slot->width, (uint32_t)slot->height}}, .layerCount = 1};
  if (seam->scissor_on) rect.rect = seam->scissor;
  seam->vkCmdClearAttachments(seam->cmd, count, attachments, 1, &rect);
}
