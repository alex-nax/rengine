/* Vulkan adapter for the draw-list contract (spec 073): Vulkan 1.3 core, dynamic rendering, entry
 * points loaded through SDL, shaders from the committed SPIR-V in shaders/ui_spv.h. */
#define VK_NO_PROTOTYPES
#include <vulkan/vulkan.h>
#if VK_HEADER_VERSION != 328
#error "Build against the vendored Vulkan headers in third_party/vulkan (tag v1.4.328)"
#endif
#include <SDL.h>
#include <SDL_vulkan.h>
#include "render/backend_vk.h"
#include "render/gpu_device.h"
#include "render/utf8.h"
#include "render/shaders/ui_spv.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ATLAS_SIZE 2048
#define GLYPH_SLOTS 4096
#define GLYPH_PROBES 8
#define CHUNK_VERTICES 16384 /* 0.94 MiB per chunk; chains grow to the largest frame seen */
#define FRAMES 2
#define MAX_IMAGES 8
#define MAX_REGIONS 1024
#define TEXTURE_SETS 256
#define STAGING_SIZE ((VkDeviceSize)1 << 20) /* glyph uploads per frame; a fuller atlas takes more frames */
enum { MODE_SOLID = 0, MODE_FILL = 1, MODE_RING = 2, MODE_SHADOW = 3, MODE_COVERAGE = 4, MODE_RGBA = 5 };
enum { PREPARE_OK, PREPARE_ATLAS_FULL, PREPARE_FRAME_FULL };

/* Creation moved to render/gpu_device.c (spec 122); what stays here is what this backend calls
 * itself. The surface and swapchain entry points are deliberately loaded HERE rather than there —
 * the device layer must remain usable by a host that has no window at all. */
#define RE_VK_INSTANCE(X) X(vkGetPhysicalDeviceSurfaceCapabilitiesKHR) X(vkGetPhysicalDeviceSurfaceFormatsKHR) X(vkDestroySurfaceKHR)
#define RE_VK_DEVICE(X) X(vkCreateSwapchainKHR) X(vkDestroySwapchainKHR) \
  X(vkGetSwapchainImagesKHR) X(vkAcquireNextImageKHR) X(vkQueuePresentKHR) X(vkCreateImageView) X(vkDestroyImageView) \
  X(vkCreateCommandPool) X(vkDestroyCommandPool) X(vkAllocateCommandBuffers) X(vkBeginCommandBuffer) X(vkEndCommandBuffer) \
  X(vkCreateFence) X(vkDestroyFence) X(vkWaitForFences) X(vkResetFences) X(vkCreateSemaphore) X(vkDestroySemaphore) \
  X(vkQueueSubmit2) X(vkDeviceWaitIdle) X(vkCreateBuffer) X(vkDestroyBuffer) X(vkGetBufferMemoryRequirements) \
  X(vkAllocateMemory) X(vkFreeMemory) X(vkBindBufferMemory) X(vkMapMemory) X(vkCreateImage) X(vkDestroyImage) \
  X(vkGetImageMemoryRequirements) X(vkBindImageMemory) X(vkCreateSampler) X(vkDestroySampler) X(vkCreateDescriptorSetLayout) \
  X(vkDestroyDescriptorSetLayout) X(vkCreateDescriptorPool) X(vkDestroyDescriptorPool) X(vkAllocateDescriptorSets) \
  X(vkFreeDescriptorSets) X(vkUpdateDescriptorSets) X(vkCreatePipelineLayout) X(vkDestroyPipelineLayout) X(vkCreateShaderModule) \
  X(vkDestroyShaderModule) X(vkCreateGraphicsPipelines) X(vkDestroyPipeline) X(vkCmdBeginRendering) X(vkCmdEndRendering) \
  X(vkCmdPipelineBarrier2) X(vkCmdCopyBufferToImage) X(vkCmdCopyImageToBuffer) X(vkCmdBindPipeline) X(vkCmdSetViewport) \
  X(vkCmdSetScissor) X(vkCmdBindVertexBuffers) X(vkCmdBindDescriptorSets) X(vkCmdPushConstants) X(vkCmdDraw)

typedef struct {
#define RE_VK_FIELD(name) PFN_##name name;
  RE_VK_INSTANCE(RE_VK_FIELD) RE_VK_DEVICE(RE_VK_FIELD)
#undef RE_VK_FIELD
} Vk;

/* float4 attributes first so their offsets are 16-byte aligned; 60-byte stride (as backend_metal.m). */
typedef struct { float shape[4]; float radii[4]; float pos[2]; float uv[2]; float extra[2]; uint8_t color[4]; } Vertex;
typedef struct { uint32_t codepoint, stamp; uint8_t face; int16_t size; bool used, present; int ax, ay, w, h, dx, dy; } Glyph;
typedef struct { VkBuffer buffer; VkDeviceMemory memory; void *map; VkDeviceSize size; } Buffer;
typedef struct Chunk { Buffer buffer; struct Chunk *next; } Chunk;
typedef struct { VkCommandBuffer cmd; VkFence fence; VkSemaphore acquired; bool in_flight; Chunk *chunks; Buffer staging; } Frame;
typedef struct Texture {
  ReTexture base; VkImage image; VkDeviceMemory memory; VkImageView view; VkDescriptorSet set; Buffer staging;
  bool dirty, initialised; int pending_frame; struct Texture *next;
} Texture;
typedef struct {
  ReBackend base; SDL_Window *window; Vk vk; ReGpu *gpu; PFN_vkGetInstanceProcAddr gipa;
  VkInstance instance; VkSurfaceKHR surface; VkPhysicalDevice physical; VkDevice device;
  VkQueue queue; uint32_t family;
  VkSwapchainKHR swapchain; VkFormat format; VkExtent2D extent; uint32_t image_count;
  VkImage images[MAX_IMAGES]; VkImageView views[MAX_IMAGES]; VkSemaphore finished[MAX_IMAGES]; bool outdated;
  VkCommandPool pool; Frame frames[FRAMES]; int frame; uint32_t image_index; bool recording, rendering, submitted;
  VkDescriptorSetLayout set_layout; VkDescriptorPool descriptor_pool; VkPipelineLayout layout; VkPipeline pipeline; VkSampler sampler;
  VkImage atlas; VkDeviceMemory atlas_memory; VkImageView atlas_view; VkDescriptorSet atlas_set; bool atlas_initialised; Buffer readback;
  float density; int dw, dh; Chunk *chunk; uint32_t chunk_start, chunk_count; VkDescriptorSet bound;
  Glyph glyphs[GLYPH_SLOTS]; int shelf_x, shelf_y, shelf_h; uint32_t stamp;
  VkBufferImageCopy regions[MAX_REGIONS]; uint32_t region_count; VkDeviceSize staging_used;
  Texture *textures; bool validation; long validation_messages;
} VkBackend;

static bool fail(const char *what, VkResult r) { SDL_SetError("Vulkan: %s failed (%d)", what, (int)r); return false; }
#define CHECK(call, what) do { VkResult r_ = (call); if (r_ != VK_SUCCESS) return fail(what, r_); } while (0)
static VkCommandBuffer cmd(VkBackend *b) { return b->frames[b->frame].cmd; }

static VKAPI_ATTR VkBool32 VKAPI_CALL debug_message(VkDebugUtilsMessageSeverityFlagBitsEXT severity, VkDebugUtilsMessageTypeFlagsEXT type,
                                                    const VkDebugUtilsMessengerCallbackDataEXT *data, void *user) {
  VkBackend *b = user; const char *log = getenv("RENGINE_VULKAN_VALIDATION_LOG"); (void)severity; (void)type;
  b->validation_messages++;
  fprintf(stderr, "[vulkan validation] %s\n", data->pMessage);
  if (log && *log) { FILE *f = fopen(log, "a"); if (f) { fprintf(f, "%s\n", data->pMessage); fclose(f); } }
  return VK_FALSE;
}

/* --- memory, buffers, images, descriptor sets --- */
static uint32_t memory_type(VkBackend *b, uint32_t bits, VkMemoryPropertyFlags props) {
  return re_gpu_memory_type(b->gpu, bits, props);
}
static bool buffer_create(VkBackend *b, Buffer *out, VkDeviceSize size, VkBufferUsageFlags usage) {
  VkBufferCreateInfo ci = {.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, .size = size, .usage = usage, .sharingMode = VK_SHARING_MODE_EXCLUSIVE};
  CHECK(b->vk.vkCreateBuffer(b->device, &ci, NULL, &out->buffer), "vkCreateBuffer");
  VkMemoryRequirements req; b->vk.vkGetBufferMemoryRequirements(b->device, out->buffer, &req);
  uint32_t type = memory_type(b, req.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
  if (type == UINT32_MAX) return fail("host-visible memory type lookup", VK_ERROR_FEATURE_NOT_PRESENT);
  VkMemoryAllocateInfo ai = {.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = req.size, .memoryTypeIndex = type};
  CHECK(b->vk.vkAllocateMemory(b->device, &ai, NULL, &out->memory), "vkAllocateMemory");
  CHECK(b->vk.vkBindBufferMemory(b->device, out->buffer, out->memory, 0), "vkBindBufferMemory");
  CHECK(b->vk.vkMapMemory(b->device, out->memory, 0, VK_WHOLE_SIZE, 0, &out->map), "vkMapMemory");
  out->size = size; return true;
}
static void buffer_destroy(VkBackend *b, Buffer *buf) {
  if (buf->buffer) b->vk.vkDestroyBuffer(b->device, buf->buffer, NULL);
  if (buf->memory) b->vk.vkFreeMemory(b->device, buf->memory, NULL);
  memset(buf, 0, sizeof(*buf));
}
static bool image_create(VkBackend *b, VkFormat format, uint32_t w, uint32_t h, VkImage *image, VkDeviceMemory *memory, VkImageView *view) {
  VkImageCreateInfo ci = {.sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = format, .extent = {w, h, 1},
    .mipLevels = 1, .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
    .usage = VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT, .sharingMode = VK_SHARING_MODE_EXCLUSIVE, .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED};
  CHECK(b->vk.vkCreateImage(b->device, &ci, NULL, image), "vkCreateImage");
  VkMemoryRequirements req; b->vk.vkGetImageMemoryRequirements(b->device, *image, &req);
  uint32_t type = memory_type(b, req.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
  if (type == UINT32_MAX) type = memory_type(b, req.memoryTypeBits, 0);
  if (type == UINT32_MAX) return fail("image memory type lookup", VK_ERROR_FEATURE_NOT_PRESENT);
  VkMemoryAllocateInfo ai = {.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = req.size, .memoryTypeIndex = type};
  CHECK(b->vk.vkAllocateMemory(b->device, &ai, NULL, memory), "vkAllocateMemory (image)");
  CHECK(b->vk.vkBindImageMemory(b->device, *image, *memory, 0), "vkBindImageMemory");
  VkImageViewCreateInfo vi = {.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = *image, .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = format,
    .subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1}};
  CHECK(b->vk.vkCreateImageView(b->device, &vi, NULL, view), "vkCreateImageView");
  return true;
}
static bool set_create(VkBackend *b, VkImageView view, VkDescriptorSet *set) {
  VkDescriptorSetAllocateInfo ai = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, .descriptorPool = b->descriptor_pool, .descriptorSetCount = 1, .pSetLayouts = &b->set_layout};
  CHECK(b->vk.vkAllocateDescriptorSets(b->device, &ai, set), "vkAllocateDescriptorSets");
  VkDescriptorImageInfo info = {.sampler = b->sampler, .imageView = view, .imageLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL};
  VkWriteDescriptorSet w = {.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = *set, .dstBinding = 0, .descriptorCount = 1,
    .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, .pImageInfo = &info};
  b->vk.vkUpdateDescriptorSets(b->device, 1, &w, 0, NULL);
  return true;
}
static void image_barrier(VkBackend *b, VkImage image, VkImageLayout from, VkImageLayout to, VkPipelineStageFlags2 src_stage, VkAccessFlags2 src_access,
                          VkPipelineStageFlags2 dst_stage, VkAccessFlags2 dst_access) {
  VkImageMemoryBarrier2 im = {.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2, .srcStageMask = src_stage, .srcAccessMask = src_access,
    .dstStageMask = dst_stage, .dstAccessMask = dst_access, .oldLayout = from, .newLayout = to, .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
    .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED, .image = image, .subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1}};
  VkDependencyInfo dep = {.sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO, .imageMemoryBarrierCount = 1, .pImageMemoryBarriers = &im};
  b->vk.vkCmdPipelineBarrier2(cmd(b), &dep);
}
static Chunk *chunk_next(VkBackend *b, Chunk **slot) {
  if (!*slot) {
    Chunk *c = calloc(1, sizeof(*c));
    if (!c || !buffer_create(b, &c->buffer, sizeof(Vertex) * CHUNK_VERTICES, VK_BUFFER_USAGE_VERTEX_BUFFER_BIT)) { if (c) buffer_destroy(b, &c->buffer); free(c); return NULL; }
    *slot = c;
  }
  return *slot;
}

/* --- swapchain --- */
static void swapchain_destroy(VkBackend *b) {
  for (uint32_t i = 0; i < b->image_count; i++) {
    if (b->views[i]) b->vk.vkDestroyImageView(b->device, b->views[i], NULL);
    if (b->finished[i]) b->vk.vkDestroySemaphore(b->device, b->finished[i], NULL);
    b->views[i] = VK_NULL_HANDLE; b->finished[i] = VK_NULL_HANDLE;
  }
  b->image_count = 0;
  if (b->swapchain) b->vk.vkDestroySwapchainKHR(b->device, b->swapchain, NULL);
  b->swapchain = VK_NULL_HANDLE;
}
static bool swapchain_create(VkBackend *b) {
  VkSurfaceCapabilitiesKHR caps; CHECK(b->vk.vkGetPhysicalDeviceSurfaceCapabilitiesKHR(b->physical, b->surface, &caps), "vkGetPhysicalDeviceSurfaceCapabilitiesKHR");
  uint32_t nf = 0; b->vk.vkGetPhysicalDeviceSurfaceFormatsKHR(b->physical, b->surface, &nf, NULL);
  VkSurfaceFormatKHR formats[64]; if (nf > 64) nf = 64;
  CHECK(b->vk.vkGetPhysicalDeviceSurfaceFormatsKHR(b->physical, b->surface, &nf, formats), "vkGetPhysicalDeviceSurfaceFormatsKHR");
  if (!nf) return fail("surface format enumeration", VK_ERROR_FORMAT_NOT_SUPPORTED);
  VkSurfaceFormatKHR chosen = formats[0]; /* prefer BGRA8 in the sRGB colour space; MoltenVK also lists HDR spaces that need an extension */
  for (uint32_t i = 0; i < nf; i++) if (formats[i].colorSpace == VK_COLOR_SPACE_SRGB_NONLINEAR_KHR && (chosen.colorSpace != VK_COLOR_SPACE_SRGB_NONLINEAR_KHR || (formats[i].format == VK_FORMAT_B8G8R8A8_UNORM && chosen.format != VK_FORMAT_B8G8R8A8_UNORM))) chosen = formats[i];
  int dw = 0, dh = 0; SDL_Vulkan_GetDrawableSize(b->window, &dw, &dh);
  VkExtent2D extent = caps.currentExtent;
  if (extent.width == UINT32_MAX) { extent.width = (uint32_t)(dw > 0 ? dw : 1); extent.height = (uint32_t)(dh > 0 ? dh : 1); }
  if (extent.width < caps.minImageExtent.width) extent.width = caps.minImageExtent.width;
  if (extent.height < caps.minImageExtent.height) extent.height = caps.minImageExtent.height;
  if (extent.width > caps.maxImageExtent.width) extent.width = caps.maxImageExtent.width;
  if (extent.height > caps.maxImageExtent.height) extent.height = caps.maxImageExtent.height;
  if (!extent.width || !extent.height) return fail("swapchain extent (window has no drawable area)", VK_ERROR_OUT_OF_DATE_KHR);
  if (!(caps.supportedUsageFlags & VK_IMAGE_USAGE_TRANSFER_SRC_BIT)) return fail("swapchain transfer-source usage (needed for snapshots)", VK_ERROR_FEATURE_NOT_PRESENT);
  uint32_t count = caps.minImageCount + 1;
  if (caps.maxImageCount && count > caps.maxImageCount) count = caps.maxImageCount;
  if (count > MAX_IMAGES) count = MAX_IMAGES;
  VkCompositeAlphaFlagBitsKHR alpha = VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR;
  if (!(caps.supportedCompositeAlpha & alpha)) alpha = caps.supportedCompositeAlpha & VK_COMPOSITE_ALPHA_INHERIT_BIT_KHR ? VK_COMPOSITE_ALPHA_INHERIT_BIT_KHR : (VkCompositeAlphaFlagBitsKHR)(caps.supportedCompositeAlpha & -caps.supportedCompositeAlpha);
  VkSwapchainCreateInfoKHR ci = {.sType = VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR, .surface = b->surface, .minImageCount = count, .imageFormat = chosen.format,
    .imageColorSpace = chosen.colorSpace, .imageExtent = extent, .imageArrayLayers = 1, .imageUsage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT,
    .imageSharingMode = VK_SHARING_MODE_EXCLUSIVE, .preTransform = caps.currentTransform, .compositeAlpha = alpha, .presentMode = VK_PRESENT_MODE_FIFO_KHR, .clipped = VK_TRUE};
  CHECK(b->vk.vkCreateSwapchainKHR(b->device, &ci, NULL, &b->swapchain), "vkCreateSwapchainKHR");
  uint32_t n = 0; CHECK(b->vk.vkGetSwapchainImagesKHR(b->device, b->swapchain, &n, NULL), "vkGetSwapchainImagesKHR");
  if (n > MAX_IMAGES) return fail("swapchain image count", VK_ERROR_TOO_MANY_OBJECTS);
  CHECK(b->vk.vkGetSwapchainImagesKHR(b->device, b->swapchain, &n, b->images), "vkGetSwapchainImagesKHR");
  b->image_count = n; b->format = chosen.format; b->extent = extent; b->outdated = false;
  for (uint32_t i = 0; i < n; i++) {
    VkImageViewCreateInfo vi = {.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = b->images[i], .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = chosen.format,
      .subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1}};
    CHECK(b->vk.vkCreateImageView(b->device, &vi, NULL, &b->views[i]), "vkCreateImageView (swapchain)");
    VkSemaphoreCreateInfo si = {.sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};
    CHECK(b->vk.vkCreateSemaphore(b->device, &si, NULL, &b->finished[i]), "vkCreateSemaphore");
  }
  return true;
}
static bool swapchain_recreate(VkBackend *b) {
  b->vk.vkDeviceWaitIdle(b->device);
  for (int i = 0; i < FRAMES; i++) b->frames[i].in_flight = false;
  swapchain_destroy(b);
  return swapchain_create(b);
}

/* --- glyph atlas: prepared before rendering, because transfers are illegal inside a rendering scope --- */
static void atlas_reset(VkBackend *b) { memset(b->glyphs, 0, sizeof(b->glyphs)); b->shelf_x = b->shelf_y = b->shelf_h = 0; }
static bool atlas_place(VkBackend *b, int w, int h, int *x, int *y) {
  if (b->shelf_x + w + 1 > ATLAS_SIZE) { b->shelf_y += b->shelf_h + 1; b->shelf_x = 0; b->shelf_h = 0; }
  if (b->shelf_y + h + 1 > ATLAS_SIZE || w + 1 > ATLAS_SIZE) return false;
  *x = b->shelf_x; *y = b->shelf_y; b->shelf_x += w + 1; if (h > b->shelf_h) b->shelf_h = h; return true;
}
static uint32_t glyph_hash(uint8_t face, int16_t size, uint32_t cp) { return (cp * 31u + face * 7919u + (uint32_t)size * 131u) % GLYPH_SLOTS; }
static Glyph *glyph_find(VkBackend *b, uint8_t face, int16_t size, uint32_t cp) {
  uint32_t h = glyph_hash(face, size, cp);
  for (int i = 0; i < GLYPH_PROBES; i++) { Glyph *g = &b->glyphs[(h + (uint32_t)i) % GLYPH_SLOTS]; if (g->used && g->codepoint == cp && g->face == face && g->size == size) return g; }
  return NULL;
}
static int glyph_prepare(VkBackend *b, Frame *f, uint8_t face, int16_t size, uint32_t cp) {
  Glyph *g = glyph_find(b, face, size, cp);
  if (g) { g->stamp = b->stamp; return PREPARE_OK; }
  uint32_t h = glyph_hash(face, size, cp);
  for (int i = 0; i < GLYPH_PROBES && !g; i++) { Glyph *slot = &b->glyphs[(h + (uint32_t)i) % GLYPH_SLOTS]; if (!slot->used || slot->stamp != b->stamp) g = slot; }
  if (!g) return PREPARE_ATLAS_FULL;
  ReGlyphBitmap bitmap; bool raster = re_font_glyph(b->base.fonts, face, size, b->density, cp, &bitmap);
  memset(g, 0, sizeof(*g)); g->used = true; g->codepoint = cp; g->face = face; g->size = size; g->stamp = b->stamp;
  if (!raster || !bitmap.w || !bitmap.h) { if (raster) re_font_glyph_free(&bitmap); return PREPARE_OK; }
  int result = PREPARE_OK; VkDeviceSize offset = (b->staging_used + 3) & ~(VkDeviceSize)3, bytes = (VkDeviceSize)bitmap.w * bitmap.h;
  if (b->region_count >= MAX_REGIONS || offset + bytes > f->staging.size) result = PREPARE_FRAME_FULL;
  else if (!atlas_place(b, bitmap.w, bitmap.h, &g->ax, &g->ay)) result = PREPARE_ATLAS_FULL;
  else {
    g->w = bitmap.w; g->h = bitmap.h; g->dx = bitmap.dx; g->dy = bitmap.dy; g->present = true;
    memcpy((char *)f->staging.map + offset, bitmap.pixels, (size_t)bytes); b->staging_used = offset + bytes;
    VkBufferImageCopy *r = &b->regions[b->region_count++];
    memset(r, 0, sizeof(*r)); r->bufferOffset = offset; r->imageSubresource = (VkImageSubresourceLayers){VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
    r->imageOffset = (VkOffset3D){g->ax, g->ay, 0}; r->imageExtent = (VkExtent3D){(uint32_t)g->w, (uint32_t)g->h, 1};
  }
  if (result != PREPARE_OK) g->used = false;
  re_font_glyph_free(&bitmap);
  return result;
}
static void prepare_glyphs(VkBackend *b, const ReDrawList *list) {
  Frame *f = &b->frames[b->frame];
  for (int attempt = 0; attempt < 2; attempt++) {
    int state = PREPARE_OK; b->region_count = 0; b->staging_used = 0;
    for (size_t i = 0; i < list->count && state == PREPARE_OK; i++) {
      const ReCommand *c = &list->commands[i]; const char *s, *end; uint8_t face; int size = c->size > 0 ? c->size : 16;
      char glyph[5];
      if (c->type == RE_CMD_TEXT) { s = re_draw_list_string(list, c); end = s + c->text_length; face = c->face; }
      else if (c->type == RE_CMD_ICON) { end = glyph + re_encode(re_icon_codepoints[c->icon < RE_ICON_COUNT ? c->icon : RE_ICON_UNKNOWN], glyph); s = glyph; face = RE_FACE_ICON; }
      else continue;
      while (*s && s < end && state == PREPARE_OK) state = glyph_prepare(b, f, face, (int16_t)size, re_utf8(&s));
    }
    if (state != PREPARE_ATLAS_FULL) break;
    atlas_reset(b); /* repack from scratch, then walk the list once more so earlier glyphs return */
  }
  VkImageLayout from = b->atlas_initialised ? VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL : VK_IMAGE_LAYOUT_UNDEFINED;
  if (b->region_count) {
    image_barrier(b, b->atlas, from, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_PIPELINE_STAGE_2_FRAGMENT_SHADER_BIT, b->atlas_initialised ? VK_ACCESS_2_SHADER_READ_BIT : 0,
                  VK_PIPELINE_STAGE_2_TRANSFER_BIT, VK_ACCESS_2_TRANSFER_WRITE_BIT);
    b->vk.vkCmdCopyBufferToImage(cmd(b), f->staging.buffer, b->atlas, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, b->region_count, b->regions);
    image_barrier(b, b->atlas, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL, VK_PIPELINE_STAGE_2_TRANSFER_BIT, VK_ACCESS_2_TRANSFER_WRITE_BIT,
                  VK_PIPELINE_STAGE_2_FRAGMENT_SHADER_BIT, VK_ACCESS_2_SHADER_READ_BIT);
    b->atlas_initialised = true;
  } else if (!b->atlas_initialised) {
    image_barrier(b, b->atlas, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL, VK_PIPELINE_STAGE_2_TOP_OF_PIPE_BIT, 0, VK_PIPELINE_STAGE_2_FRAGMENT_SHADER_BIT, VK_ACCESS_2_SHADER_READ_BIT);
    b->atlas_initialised = true;
  }
}
static void upload_textures(VkBackend *b) {
  for (Texture *t = b->textures; t; t = t->next) {
    if (!t->dirty) continue;
    image_barrier(b, t->image, t->initialised ? VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL : VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                  VK_PIPELINE_STAGE_2_FRAGMENT_SHADER_BIT, t->initialised ? VK_ACCESS_2_SHADER_READ_BIT : 0, VK_PIPELINE_STAGE_2_TRANSFER_BIT, VK_ACCESS_2_TRANSFER_WRITE_BIT);
    VkBufferImageCopy region = {.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1}, .imageExtent = {(uint32_t)t->base.width, (uint32_t)t->base.height, 1}};
    b->vk.vkCmdCopyBufferToImage(cmd(b), t->staging.buffer, t->image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &region);
    image_barrier(b, t->image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL, VK_PIPELINE_STAGE_2_TRANSFER_BIT, VK_ACCESS_2_TRANSFER_WRITE_BIT,
                  VK_PIPELINE_STAGE_2_FRAGMENT_SHADER_BIT, VK_ACCESS_2_SHADER_READ_BIT);
    t->initialised = true; t->dirty = false; t->pending_frame = b->frame;
  }
}

/* --- batching: one vkCmdDraw per run of vertices sharing a descriptor set and scissor --- */
static void flush(VkBackend *b) {
  if (b->chunk_count > b->chunk_start) b->vk.vkCmdDraw(cmd(b), b->chunk_count - b->chunk_start, 1, b->chunk_start, 0);
  b->chunk_start = b->chunk_count;
}
static void bind(VkBackend *b, VkDescriptorSet set) {
  VkDescriptorSet s = set ? set : b->atlas_set;
  if (s == b->bound) return;
  flush(b); b->vk.vkCmdBindDescriptorSets(cmd(b), VK_PIPELINE_BIND_POINT_GRAPHICS, b->layout, 0, 1, &s, 0, NULL); b->bound = s;
}
static void emit(VkBackend *b, float x0, float y0, float x1, float y1, float u0, float v0, float u1, float v1, ReColor c,
                 float cx, float cy, float hw, float hh, const float radii[4], float w, int mode) {
  if (b->chunk_count + 6 > CHUNK_VERTICES) {
    flush(b); Chunk *next = chunk_next(b, &b->chunk->next); if (!next) return;
    VkDeviceSize zero = 0; b->chunk = next; b->chunk_start = b->chunk_count = 0; b->vk.vkCmdBindVertexBuffers(cmd(b), 0, 1, &next->buffer.buffer, &zero);
  }
  Vertex *v = (Vertex *)b->chunk->buffer.map + b->chunk_count; b->chunk_count += 6;
  float xs[6] = {x0, x1, x1, x0, x1, x0}, ys[6] = {y0, y0, y1, y0, y1, y1};
  float us[6] = {u0, u1, u1, u0, u1, u0}, vs[6] = {v0, v0, v1, v0, v1, v1};
  for (int i = 0; i < 6; i++) {
    v[i].pos[0] = xs[i]; v[i].pos[1] = ys[i]; v[i].uv[0] = us[i]; v[i].uv[1] = vs[i];
    v[i].color[0] = c.r; v[i].color[1] = c.g; v[i].color[2] = c.b; v[i].color[3] = c.a;
    v[i].shape[0] = cx; v[i].shape[1] = cy; v[i].shape[2] = hw; v[i].shape[3] = hh;
    memcpy(v[i].radii, radii, sizeof(float) * 4); v[i].extra[0] = w; v[i].extra[1] = (float)mode;
  }
}
static void shape(VkBackend *b, ReRect r, ReColor c, float radius, uint8_t corners, float w, int mode, int expand) {
  float d = b->density, x0 = (float)(r.x - expand) * d, y0 = (float)(r.y - expand) * d, x1 = (float)(r.x + r.w + expand) * d, y1 = (float)(r.y + r.h + expand) * d;
  float radii[4] = {corners & RE_CORNER_TOP_LEFT ? radius * d : 0, corners & RE_CORNER_TOP_RIGHT ? radius * d : 0,
                    corners & RE_CORNER_BOTTOM_RIGHT ? radius * d : 0, corners & RE_CORNER_BOTTOM_LEFT ? radius * d : 0};
  float cx = (float)r.x * d + (float)r.w * d / 2, cy = (float)r.y * d + (float)r.h * d / 2, hw = (float)r.w * d / 2, hh = (float)r.h * d / 2;
  if (mode == MODE_RING) { hw += (float)expand * d; hh += (float)expand * d; for (int i = 0; i < 4; i++) radii[i] += (float)expand * d; }
  emit(b, x0, y0, x1, y1, 0, 0, 0, 0, c, cx, cy, hw, hh, radii, w * d, mode);
}
/* A ramp is one quad per logical pixel carrying the whole rect's shape, so the SDF still rounds the
 * ends while each strip takes its own stop from the shared sampler — see sidecar: gradient-strips */
static void gradient(VkBackend *b, const ReCommand *c) {
  ReRect r = c->rect;
  if (r.w <= 0 || r.h <= 0) return;
  float d = b->density;
  uint8_t corners = c->corners;
  float radii[4] = {corners & RE_CORNER_TOP_LEFT ? c->radius * d : 0, corners & RE_CORNER_TOP_RIGHT ? c->radius * d : 0,
                    corners & RE_CORNER_BOTTOM_RIGHT ? c->radius * d : 0, corners & RE_CORNER_BOTTOM_LEFT ? c->radius * d : 0};
  float cx = (float)r.x * d + (float)r.w * d / 2, cy = (float)r.y * d + (float)r.h * d / 2;
  float hw = (float)r.w * d / 2, hh = (float)r.h * d / 2;
  int mode = c->radius > 0 && corners ? MODE_FILL : MODE_SOLID;
  bool vertical = (c->flags & RE_GRADIENT_VERTICAL) != 0;
  int steps = vertical ? r.h : r.w;
  for (int i = 0; i < steps; i++) {
    ReColor stop = re_gradient_sample(c->color, c->secondary, i, steps);
    float x0 = (float)(vertical ? r.x : r.x + i) * d, x1 = (float)(vertical ? r.x + r.w : r.x + i + 1) * d;
    float y0 = (float)(vertical ? r.y + i : r.y) * d, y1 = (float)(vertical ? r.y + i + 1 : r.y + r.h) * d;
    emit(b, x0, y0, x1, y1, 0, 0, 0, 0, stop, cx, cy, hw, hh, radii, 0, mode);
  }
}

/* Glyph placement matches the SDL reference and the other adapters exactly — see sidecar: shared-shading */
static void draw_text(VkBackend *b, ReColor color, uint8_t face, int size, int x, int y, const char *s, const char *end) {
  ReFontMetrics m = re_font_metrics(b->base.fonts, face, size, b->density);
  float d = b->density, base = (float)(y + m.ascent + 2) * d;
  ReTextPen pen = re_font_pen(b->base.fonts, face, size, d, x);
  bind(b, VK_NULL_HANDLE);
  while (*s && s < end) {
    uint32_t cp = re_utf8(&s); Glyph *g = glyph_find(b, face, (int16_t)size, cp);
    if (g && g->present) {
      float gx = re_font_pen_x(&pen) + (float)g->dx, gy = base + (float)g->dy, radii[4] = {0, 0, 0, 0};
      emit(b, gx, gy, gx + (float)g->w, gy + (float)g->h, (float)g->ax / ATLAS_SIZE, (float)g->ay / ATLAS_SIZE,
           (float)(g->ax + g->w) / ATLAS_SIZE, (float)(g->ay + g->h) / ATLAS_SIZE, color, 0, 0, 0, 0, radii, 0, MODE_COVERAGE);
    }
    re_font_pen_step(&pen, cp);
  }
}
static void set_clip(VkBackend *b, const ReCommand *c) {
  flush(b);
  VkRect2D rect = {{0, 0}, {(uint32_t)b->dw, (uint32_t)b->dh}};
  if (!(c->flags & RE_CLIP_RESET)) {
    int w = c->rect.w > 0 ? c->rect.w : 0, h = c->rect.h > 0 ? c->rect.h : 0;
    int x0 = (int)((float)c->rect.x * b->density), y0 = (int)((float)c->rect.y * b->density);
    int x1 = (int)((float)(c->rect.x + w) * b->density), y1 = (int)((float)(c->rect.y + h) * b->density);
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0; if (x1 > b->dw) x1 = b->dw; if (y1 > b->dh) y1 = b->dh;
    if (x1 < x0) x1 = x0; if (y1 < y0) y1 = y0;
    rect.offset.x = x0; rect.offset.y = y0; rect.extent.width = (uint32_t)(x1 - x0); rect.extent.height = (uint32_t)(y1 - y0);
  }
  b->vk.vkCmdSetScissor(cmd(b), 0, 1, &rect);
}

/* --- frame lifecycle: one command buffer per frame, submitted once — see sidecar: frame-lifecycle --- */
static float density(ReBackend *backend, int logical_width) {
  VkBackend *b = (VkBackend *)backend; int dw = 0, dh = 0; SDL_Vulkan_GetDrawableSize(b->window, &dw, &dh);
  return (float)dw / (float)(logical_width > 1 ? logical_width : 1);
}
static void end_rendering(VkBackend *b) { if (b->rendering) { flush(b); b->vk.vkCmdEndRendering(cmd(b)); b->rendering = false; } }
static void abandon_frame(VkBackend *b) {
  for (Texture *t = b->textures; t; t = t->next) if (t->pending_frame == b->frame && !b->frames[b->frame].in_flight) { t->dirty = true; t->pending_frame = -1; }
  b->recording = b->rendering = false;
}
static bool begin(ReBackend *backend, const ReDrawList *list) {
  VkBackend *b = (VkBackend *)backend; Frame *f = &b->frames[b->frame];
  SDL_Vulkan_GetDrawableSize(b->window, &b->dw, &b->dh);
  if (b->dw < 1 || b->dh < 1) return false;
  if (b->outdated || (uint32_t)b->dw != b->extent.width || (uint32_t)b->dh != b->extent.height) { if (!swapchain_recreate(b)) return false; }
  if (list->density != b->density) { b->density = list->density; atlas_reset(b); }
  if (!chunk_next(b, &f->chunks)) return false;
  if (f->in_flight) { b->vk.vkWaitForFences(b->device, 1, &f->fence, VK_TRUE, UINT64_MAX); f->in_flight = false; }
  VkResult r = b->vk.vkAcquireNextImageKHR(b->device, b->swapchain, UINT64_MAX, f->acquired, VK_NULL_HANDLE, &b->image_index);
  if (r == VK_ERROR_OUT_OF_DATE_KHR) { if (!swapchain_recreate(b)) return false; r = b->vk.vkAcquireNextImageKHR(b->device, b->swapchain, UINT64_MAX, f->acquired, VK_NULL_HANDLE, &b->image_index); }
  if (r != VK_SUCCESS && r != VK_SUBOPTIMAL_KHR) return fail("vkAcquireNextImageKHR", r);
  b->vk.vkResetFences(b->device, 1, &f->fence);
  VkCommandBufferBeginInfo bi = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT};
  CHECK(b->vk.vkBeginCommandBuffer(f->cmd, &bi), "vkBeginCommandBuffer");
  b->stamp++; b->recording = true; b->submitted = false;
  upload_textures(b);
  prepare_glyphs(b, list);
  image_barrier(b, b->images[b->image_index], VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL, VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT, 0,
                VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT, VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT);
  VkRenderingAttachmentInfo color = {.sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = b->views[b->image_index], .imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
    .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR, .storeOp = VK_ATTACHMENT_STORE_OP_STORE,
    .clearValue = {.color = {{list->clear.r / 255.0f, list->clear.g / 255.0f, list->clear.b / 255.0f, list->clear.a / 255.0f}}}};
  VkRenderingInfo ri = {.sType = VK_STRUCTURE_TYPE_RENDERING_INFO, .renderArea = {{0, 0}, b->extent}, .layerCount = 1, .colorAttachmentCount = 1, .pColorAttachments = &color};
  b->vk.vkCmdBeginRendering(f->cmd, &ri); b->rendering = true;
  b->vk.vkCmdBindPipeline(f->cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, b->pipeline);
  VkViewport viewport = {0, 0, (float)b->dw, (float)b->dh, 0, 1}; b->vk.vkCmdSetViewport(f->cmd, 0, 1, &viewport);
  VkRect2D scissor = {{0, 0}, {(uint32_t)b->dw, (uint32_t)b->dh}}; b->vk.vkCmdSetScissor(f->cmd, 0, 1, &scissor);
  float size[2] = {(float)b->dw, (float)b->dh}; b->vk.vkCmdPushConstants(f->cmd, b->layout, VK_SHADER_STAGE_VERTEX_BIT, 0, sizeof(size), size);
  VkDeviceSize zero = 0; b->chunk = f->chunks; b->chunk_start = b->chunk_count = 0; b->vk.vkCmdBindVertexBuffers(f->cmd, 0, 1, &b->chunk->buffer.buffer, &zero);
  b->bound = VK_NULL_HANDLE; bind(b, VK_NULL_HANDLE);
  return true;
}
static void execute(ReBackend *backend, const ReDrawList *list) {
  VkBackend *b = (VkBackend *)backend; static const float none[4] = {0, 0, 0, 0};
  if (!b->recording || !b->rendering) return;
  for (size_t i = 0; i < list->count; i++) {
    const ReCommand *c = &list->commands[i]; float d = b->density;
    switch (c->type) {
      case RE_CMD_CLIP: set_clip(b, c); break;
      case RE_CMD_RECT: bind(b, VK_NULL_HANDLE); shape(b, c->rect, c->color, 0, 0, 0, MODE_SOLID, 0); break;
      case RE_CMD_RRECT: bind(b, VK_NULL_HANDLE); shape(b, c->rect, c->color, c->radius, c->corners, 0, c->radius > 0 && c->corners ? MODE_FILL : MODE_SOLID, 0); break;
      case RE_CMD_GRADIENT: bind(b, VK_NULL_HANDLE); gradient(b, c); break;
      case RE_CMD_FRAME:
        bind(b, VK_NULL_HANDLE); shape(b, c->rect, c->color, c->radius, c->corners, 1, MODE_RING, 0);
        if (c->secondary.a) {
          int rad = (int)c->radius; if (rad > c->rect.w / 2) rad = c->rect.w / 2; if (rad > c->rect.h / 2) rad = c->rect.h / 2;
          shape(b, re_rect(c->rect.x + 1 + rad, c->rect.y + 1, c->rect.w - 2 - 2 * rad, 1), c->secondary, 0, 0, 0, MODE_SOLID, 0);
        }
        break;
      case RE_CMD_SHADOW: bind(b, VK_NULL_HANDLE); shape(b, c->rect, c->color, c->radius, c->corners, (float)c->width, MODE_SHADOW, c->width); break;
      case RE_CMD_RING: bind(b, VK_NULL_HANDLE); shape(b, c->rect, c->color, c->radius, c->corners, (float)c->width, MODE_RING, c->width); break;
      case RE_CMD_TEXT: { const char *s = re_draw_list_string(list, c); draw_text(b, c->color, c->face, c->size > 0 ? c->size : 16, c->rect.x, c->rect.y, s, s + c->text_length); break; }
      case RE_CMD_ICON: {
        char glyph[5]; int size = c->size > 0 ? c->size : 16;
        int length = re_encode(re_icon_codepoints[c->icon < RE_ICON_COUNT ? c->icon : RE_ICON_UNKNOWN], glyph);
        ReFontMetrics m = re_font_metrics(b->base.fonts, RE_FACE_ICON, size, d);
        int width = re_font_text_width(b->base.fonts, RE_FACE_ICON, size, d, glyph, length);
        draw_text(b, c->color, RE_FACE_ICON, size, c->rect.x + (c->rect.w - width) / 2, c->rect.y + (c->rect.h - m.line_height) / 2, glyph, glyph + length);
        break;
      }
      case RE_CMD_TEXTURE: {
        Texture *t = (Texture *)c->texture; if (!t) break;
        bind(b, t->set); bool flip = (c->flags & RE_DRAW_FLIP_Y) != 0;
        emit(b, (float)c->rect.x * d, (float)c->rect.y * d, (float)(c->rect.x + c->rect.w) * d, (float)(c->rect.y + c->rect.h) * d,
             0, flip ? 1.0f : 0.0f, 1, flip ? 0.0f : 1.0f, re_color(255, 255, 255, 255), 0, 0, 0, 0, none, 0, MODE_RGBA);
        break;
      }
      default: break;
    }
  }
  end_rendering(b);
}
static bool submit(VkBackend *b, VkImageLayout from) {
  Frame *f = &b->frames[b->frame]; bool transfer = from == VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
  end_rendering(b);
  image_barrier(b, b->images[b->image_index], from, VK_IMAGE_LAYOUT_PRESENT_SRC_KHR, transfer ? VK_PIPELINE_STAGE_2_TRANSFER_BIT : VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT,
                transfer ? VK_ACCESS_2_TRANSFER_READ_BIT : VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT, VK_PIPELINE_STAGE_2_BOTTOM_OF_PIPE_BIT, 0);
  CHECK(b->vk.vkEndCommandBuffer(f->cmd), "vkEndCommandBuffer");
  VkSemaphoreSubmitInfo wait = {.sType = VK_STRUCTURE_TYPE_SEMAPHORE_SUBMIT_INFO, .semaphore = f->acquired, .stageMask = VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT};
  VkSemaphoreSubmitInfo signal = {.sType = VK_STRUCTURE_TYPE_SEMAPHORE_SUBMIT_INFO, .semaphore = b->finished[b->image_index], .stageMask = VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT};
  VkCommandBufferSubmitInfo cb = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_SUBMIT_INFO, .commandBuffer = f->cmd};
  VkSubmitInfo2 si = {.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO_2, .waitSemaphoreInfoCount = 1, .pWaitSemaphoreInfos = &wait, .commandBufferInfoCount = 1, .pCommandBufferInfos = &cb,
    .signalSemaphoreInfoCount = 1, .pSignalSemaphoreInfos = &signal};
  CHECK(b->vk.vkQueueSubmit2(b->queue, 1, &si, f->fence), "vkQueueSubmit2");
  f->in_flight = true; b->submitted = true;
  return true;
}
static void present(ReBackend *backend) {
  VkBackend *b = (VkBackend *)backend;
  if (!b->recording) return;
  if (!b->submitted && !submit(b, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL)) { abandon_frame(b); b->outdated = true; return; }
  VkPresentInfoKHR pi = {.sType = VK_STRUCTURE_TYPE_PRESENT_INFO_KHR, .waitSemaphoreCount = 1, .pWaitSemaphores = &b->finished[b->image_index], .swapchainCount = 1,
    .pSwapchains = &b->swapchain, .pImageIndices = &b->image_index};
  VkResult r = b->vk.vkQueuePresentKHR(b->queue, &pi);
  if (r == VK_ERROR_OUT_OF_DATE_KHR || r == VK_SUBOPTIMAL_KHR) b->outdated = true;
  b->recording = false; b->frame = (b->frame + 1) % FRAMES;
}
static bool snapshot(ReBackend *backend, const char *path) {
  VkBackend *b = (VkBackend *)backend; Frame *f = &b->frames[b->frame];
  if (!b->recording || b->submitted) return false;
  VkDeviceSize needed = (VkDeviceSize)b->extent.width * b->extent.height * 4; /* allocated on the first snapshot only */
  if (b->readback.size < needed) { b->vk.vkDeviceWaitIdle(b->device); buffer_destroy(b, &b->readback); if (!buffer_create(b, &b->readback, needed, VK_BUFFER_USAGE_TRANSFER_DST_BIT)) return false; }
  end_rendering(b);
  image_barrier(b, b->images[b->image_index], VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT,
                VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT, VK_PIPELINE_STAGE_2_TRANSFER_BIT, VK_ACCESS_2_TRANSFER_READ_BIT);
  VkBufferImageCopy region = {.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1}, .imageExtent = {b->extent.width, b->extent.height, 1}};
  b->vk.vkCmdCopyImageToBuffer(f->cmd, b->images[b->image_index], VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, b->readback.buffer, 1, &region);
  VkMemoryBarrier2 host = {.sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER_2, .srcStageMask = VK_PIPELINE_STAGE_2_TRANSFER_BIT, .srcAccessMask = VK_ACCESS_2_TRANSFER_WRITE_BIT,
    .dstStageMask = VK_PIPELINE_STAGE_2_HOST_BIT, .dstAccessMask = VK_ACCESS_2_HOST_READ_BIT};
  VkDependencyInfo dep = {.sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO, .memoryBarrierCount = 1, .pMemoryBarriers = &host};
  b->vk.vkCmdPipelineBarrier2(f->cmd, &dep);
  if (!submit(b, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL)) { abandon_frame(b); b->outdated = true; return false; }
  b->vk.vkWaitForFences(b->device, 1, &f->fence, VK_TRUE, UINT64_MAX);
  int w = (int)b->extent.width, h = (int)b->extent.height;
  SDL_Surface *s = SDL_CreateRGBSurfaceWithFormat(0, w, h, 32, b->format == VK_FORMAT_B8G8R8A8_UNORM ? SDL_PIXELFORMAT_BGRA32 : SDL_PIXELFORMAT_RGBA32);
  if (!s) return false;
  for (int y = 0; y < h; y++) memcpy((char *)s->pixels + (size_t)y * s->pitch, (const char *)b->readback.map + (size_t)y * w * 4, (size_t)w * 4);
  bool ok = SDL_SaveBMP(s, path) == 0; SDL_FreeSurface(s); return ok;
}

/* --- textures --- */
static void texture_release(VkBackend *b, Texture *t) {
  if (t->set) b->vk.vkFreeDescriptorSets(b->device, b->descriptor_pool, 1, &t->set);
  if (t->view) b->vk.vkDestroyImageView(b->device, t->view, NULL);
  if (t->image) b->vk.vkDestroyImage(b->device, t->image, NULL);
  if (t->memory) b->vk.vkFreeMemory(b->device, t->memory, NULL);
  buffer_destroy(b, &t->staging); free(t);
}
static ReTexture *texture_create(ReBackend *backend, int width, int height) {
  VkBackend *b = (VkBackend *)backend; Texture *t = calloc(1, sizeof(*t));
  if (!t || width < 1 || height < 1) { free(t); return NULL; }
  t->base.owner = backend; t->base.width = width; t->base.height = height; t->pending_frame = -1;
  if (!image_create(b, VK_FORMAT_R8G8B8A8_UNORM, (uint32_t)width, (uint32_t)height, &t->image, &t->memory, &t->view) || !set_create(b, t->view, &t->set) ||
      !buffer_create(b, &t->staging, (VkDeviceSize)width * height * 4, VK_BUFFER_USAGE_TRANSFER_SRC_BIT)) { texture_release(b, t); return NULL; }
  memset(t->staging.map, 0, (size_t)width * height * 4); t->dirty = true;
  t->next = b->textures; b->textures = t;
  return &t->base;
}
static bool texture_update(ReTexture *texture, const void *rgba, int pitch) {
  Texture *t = (Texture *)texture; if (!t || pitch != texture->width * 4) return false;
  VkBackend *b = (VkBackend *)texture->owner;
  if (t->pending_frame >= 0) {
    Frame *f = &b->frames[t->pending_frame];
    if (f->in_flight) b->vk.vkWaitForFences(b->device, 1, &f->fence, VK_TRUE, UINT64_MAX); /* the copy that reads the staging buffer has finished */
    t->pending_frame = -1;
  }
  memcpy(t->staging.map, rgba, (size_t)pitch * texture->height); t->dirty = true;
  return true;
}
static void texture_destroy(ReTexture *texture) {
  Texture *t = (Texture *)texture; if (!t) return;
  VkBackend *b = (VkBackend *)texture->owner;
  b->vk.vkDeviceWaitIdle(b->device);
  for (Texture **link = &b->textures; *link; link = &(*link)->next) if (*link == t) { *link = t->next; break; }
  texture_release(b, t);
}

/* --- setup and teardown --- */
/* The host's half of device selection (spec 122). The device layer cannot ask whether a queue
 * family can present, because that needs a surface — and a surface is exactly what a headset host
 * does not have. So it asks this, which owns the window and can answer. The surface is created on
 * the first call, once the instance exists, which is the only moment it can be. */
static VkBool32 present_supported(VkBackend *b, VkInstance instance, VkPhysicalDevice physical, uint32_t family) {
  if (!b->surface && !SDL_Vulkan_CreateSurface(b->window, instance, &b->surface)) return VK_FALSE;
  PFN_vkGetPhysicalDeviceSurfaceSupportKHR supported =
    (PFN_vkGetPhysicalDeviceSurfaceSupportKHR)b->gipa(instance, "vkGetPhysicalDeviceSurfaceSupportKHR");
  if (!supported) return VK_FALSE;
  VkBool32 present = VK_FALSE;
  supported(physical, family, b->surface, &present);
  return present;
}
static bool accepts_device(void *user, VkInstance instance, VkPhysicalDevice physical, uint32_t family) {
  return present_supported((VkBackend *)user, instance, physical, family) == VK_TRUE;
}

static bool open_gpu(VkBackend *b) {
  if (SDL_Vulkan_LoadLibrary(NULL) != 0) return false;
  b->gipa = (PFN_vkGetInstanceProcAddr)SDL_Vulkan_GetVkGetInstanceProcAddr();
  if (!b->gipa) { SDL_SetError("Vulkan: the loader has no vkGetInstanceProcAddr"); return false; }

  unsigned count = 0; const char *ext[24];
  if (!SDL_Vulkan_GetInstanceExtensions(b->window, &count, NULL) || count > 20) {
    if (count > 20) SDL_SetError("Vulkan: too many instance extensions");
    return false;
  }
  if (!SDL_Vulkan_GetInstanceExtensions(b->window, &count, ext)) return false;

  const char *validation = getenv("RENGINE_VULKAN_VALIDATION");
  b->validation = validation && *validation && strcmp(validation, "0") != 0;
  static const char *device_ext[1] = {VK_KHR_SWAPCHAIN_EXTENSION_NAME};
  ReGpuOpen options = {
    .get_instance_proc_addr = b->gipa,
    .instance_extensions = ext, .instance_extension_count = count,
    .device_extensions = device_ext, .device_extension_count = 1,
    .accepts = accepts_device, .user = b,
    .validation = b->validation, .on_message = debug_message, .message_user = b,
  };
  char error[256];
  b->gpu = re_gpu_open(&options, error, sizeof(error));
  if (!b->gpu) { SDL_SetError("Vulkan: %s", error); return false; }

  b->instance = re_gpu_instance(b->gpu); b->physical = re_gpu_physical(b->gpu);
  b->device = re_gpu_device(b->gpu); b->queue = re_gpu_queue(b->gpu); b->family = re_gpu_family(b->gpu);
#define RE_VK_LOAD(name) if (!(b->vk.name = (PFN_##name)re_gpu_instance_proc(b->gpu, #name))) { SDL_SetError("Vulkan: the instance lacks " #name); return false; }
  RE_VK_INSTANCE(RE_VK_LOAD)
#undef RE_VK_LOAD
#define RE_VK_LOAD(name) if (!(b->vk.name = (PFN_##name)re_gpu_device_proc(b->gpu, #name))) { SDL_SetError("Vulkan: the device lacks " #name); return false; }
  RE_VK_DEVICE(RE_VK_LOAD)
#undef RE_VK_LOAD

  fprintf(stderr, "Vulkan device: %s%s\n", re_gpu_device_name(b->gpu), b->validation ? ", validation on" : "");
  return true;
}
static bool open_pipeline(VkBackend *b) {
  VkDescriptorSetLayoutBinding binding = {.binding = 0, .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, .descriptorCount = 1, .stageFlags = VK_SHADER_STAGE_FRAGMENT_BIT};
  VkDescriptorSetLayoutCreateInfo sl = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, .bindingCount = 1, .pBindings = &binding};
  CHECK(b->vk.vkCreateDescriptorSetLayout(b->device, &sl, NULL, &b->set_layout), "vkCreateDescriptorSetLayout");
  VkDescriptorPoolSize pool_size = {.type = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, .descriptorCount = TEXTURE_SETS + 1};
  VkDescriptorPoolCreateInfo pi = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .flags = VK_DESCRIPTOR_POOL_CREATE_FREE_DESCRIPTOR_SET_BIT, .maxSets = TEXTURE_SETS + 1,
    .poolSizeCount = 1, .pPoolSizes = &pool_size};
  CHECK(b->vk.vkCreateDescriptorPool(b->device, &pi, NULL, &b->descriptor_pool), "vkCreateDescriptorPool");
  VkPushConstantRange push = {.stageFlags = VK_SHADER_STAGE_VERTEX_BIT, .offset = 0, .size = 2 * sizeof(float)};
  VkPipelineLayoutCreateInfo li = {.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1, .pSetLayouts = &b->set_layout, .pushConstantRangeCount = 1, .pPushConstantRanges = &push};
  CHECK(b->vk.vkCreatePipelineLayout(b->device, &li, NULL, &b->layout), "vkCreatePipelineLayout");
  VkSamplerCreateInfo si = {.sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO, .magFilter = VK_FILTER_NEAREST, .minFilter = VK_FILTER_NEAREST, .mipmapMode = VK_SAMPLER_MIPMAP_MODE_NEAREST,
    .addressModeU = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE, .addressModeV = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE, .addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE, .maxLod = 0};
  CHECK(b->vk.vkCreateSampler(b->device, &si, NULL, &b->sampler), "vkCreateSampler");
  VkShaderModuleCreateInfo vm = {.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO, .codeSize = sizeof(re_ui_vert_spv), .pCode = re_ui_vert_spv};
  VkShaderModuleCreateInfo fm = {.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO, .codeSize = sizeof(re_ui_frag_spv), .pCode = re_ui_frag_spv};
  VkShaderModule vs = VK_NULL_HANDLE, fs = VK_NULL_HANDLE;
  CHECK(b->vk.vkCreateShaderModule(b->device, &vm, NULL, &vs), "vkCreateShaderModule (vertex)");
  VkResult fr = b->vk.vkCreateShaderModule(b->device, &fm, NULL, &fs);
  if (fr != VK_SUCCESS) { b->vk.vkDestroyShaderModule(b->device, vs, NULL); return fail("vkCreateShaderModule (fragment)", fr); }
  VkPipelineShaderStageCreateInfo stages[2] = {
    {.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vs, .pName = "main"},
    {.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = fs, .pName = "main"}};
  VkVertexInputBindingDescription vb = {.binding = 0, .stride = sizeof(Vertex), .inputRate = VK_VERTEX_INPUT_RATE_VERTEX};
  VkVertexInputAttributeDescription attrs[6] = {
    {0, 0, VK_FORMAT_R32G32B32A32_SFLOAT, offsetof(Vertex, shape)}, {1, 0, VK_FORMAT_R32G32B32A32_SFLOAT, offsetof(Vertex, radii)},
    {2, 0, VK_FORMAT_R32G32_SFLOAT, offsetof(Vertex, pos)}, {3, 0, VK_FORMAT_R32G32_SFLOAT, offsetof(Vertex, uv)},
    {4, 0, VK_FORMAT_R32G32_SFLOAT, offsetof(Vertex, extra)}, {5, 0, VK_FORMAT_R8G8B8A8_UNORM, offsetof(Vertex, color)}};
  VkPipelineVertexInputStateCreateInfo vi = {.sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO, .vertexBindingDescriptionCount = 1, .pVertexBindingDescriptions = &vb,
    .vertexAttributeDescriptionCount = 6, .pVertexAttributeDescriptions = attrs};
  VkPipelineInputAssemblyStateCreateInfo ia = {.sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO, .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST};
  VkPipelineViewportStateCreateInfo vp = {.sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1, .scissorCount = 1};
  VkPipelineRasterizationStateCreateInfo rs = {.sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO, .polygonMode = VK_POLYGON_MODE_FILL, .cullMode = VK_CULL_MODE_NONE,
    .frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE, .lineWidth = 1.0f};
  VkPipelineMultisampleStateCreateInfo ms = {.sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO, .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT};
  VkPipelineColorBlendAttachmentState blend = {.blendEnable = VK_TRUE, .srcColorBlendFactor = VK_BLEND_FACTOR_SRC_ALPHA, .dstColorBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA,
    .colorBlendOp = VK_BLEND_OP_ADD, .srcAlphaBlendFactor = VK_BLEND_FACTOR_ONE, .dstAlphaBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA, .alphaBlendOp = VK_BLEND_OP_ADD,
    .colorWriteMask = VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT | VK_COLOR_COMPONENT_B_BIT | VK_COLOR_COMPONENT_A_BIT};
  VkPipelineColorBlendStateCreateInfo cb = {.sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO, .attachmentCount = 1, .pAttachments = &blend};
  VkDynamicState dynamic[2] = {VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR};
  VkPipelineDynamicStateCreateInfo ds = {.sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO, .dynamicStateCount = 2, .pDynamicStates = dynamic};
  VkPipelineRenderingCreateInfo rendering = {.sType = VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO, .colorAttachmentCount = 1, .pColorAttachmentFormats = &b->format};
  VkGraphicsPipelineCreateInfo gp = {.sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .pNext = &rendering, .stageCount = 2, .pStages = stages, .pVertexInputState = &vi,
    .pInputAssemblyState = &ia, .pViewportState = &vp, .pRasterizationState = &rs, .pMultisampleState = &ms, .pColorBlendState = &cb, .pDynamicState = &ds, .layout = b->layout};
  VkResult pr = b->vk.vkCreateGraphicsPipelines(b->device, VK_NULL_HANDLE, 1, &gp, NULL, &b->pipeline);
  b->vk.vkDestroyShaderModule(b->device, vs, NULL); b->vk.vkDestroyShaderModule(b->device, fs, NULL);
  if (pr != VK_SUCCESS) return fail("vkCreateGraphicsPipelines", pr);
  if (!image_create(b, VK_FORMAT_R8_UNORM, ATLAS_SIZE, ATLAS_SIZE, &b->atlas, &b->atlas_memory, &b->atlas_view) || !set_create(b, b->atlas_view, &b->atlas_set)) return false;
  return true;
}
static bool open_frames(VkBackend *b) {
  VkCommandPoolCreateInfo pi = {.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, .flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT, .queueFamilyIndex = b->family};
  CHECK(b->vk.vkCreateCommandPool(b->device, &pi, NULL, &b->pool), "vkCreateCommandPool");
  for (int i = 0; i < FRAMES; i++) {
    Frame *f = &b->frames[i];
    VkCommandBufferAllocateInfo ai = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, .commandPool = b->pool, .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY, .commandBufferCount = 1};
    CHECK(b->vk.vkAllocateCommandBuffers(b->device, &ai, &f->cmd), "vkAllocateCommandBuffers");
    VkFenceCreateInfo fi = {.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
    CHECK(b->vk.vkCreateFence(b->device, &fi, NULL, &f->fence), "vkCreateFence");
    VkSemaphoreCreateInfo si = {.sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};
    CHECK(b->vk.vkCreateSemaphore(b->device, &si, NULL, &f->acquired), "vkCreateSemaphore");
    if (!buffer_create(b, &f->staging, STAGING_SIZE, VK_BUFFER_USAGE_TRANSFER_SRC_BIT)) return false; /* vertex chunks are created on first use */
  }
  return true;
}
static void close_backend(ReBackend *backend) {
  VkBackend *b = (VkBackend *)backend; if (!b) return;
  if (b->device) {
    b->vk.vkDeviceWaitIdle(b->device);
    while (b->textures) { Texture *t = b->textures; b->textures = t->next; texture_release(b, t); }
    for (int i = 0; i < FRAMES; i++) {
      Frame *f = &b->frames[i];
      while (f->chunks) { Chunk *c = f->chunks; f->chunks = c->next; buffer_destroy(b, &c->buffer); free(c); }
      buffer_destroy(b, &f->staging);
      if (f->fence) b->vk.vkDestroyFence(b->device, f->fence, NULL);
      if (f->acquired) b->vk.vkDestroySemaphore(b->device, f->acquired, NULL);
    }
    if (b->pool) b->vk.vkDestroyCommandPool(b->device, b->pool, NULL);
    buffer_destroy(b, &b->readback);
    if (b->atlas_view) b->vk.vkDestroyImageView(b->device, b->atlas_view, NULL);
    if (b->atlas) b->vk.vkDestroyImage(b->device, b->atlas, NULL);
    if (b->atlas_memory) b->vk.vkFreeMemory(b->device, b->atlas_memory, NULL);
    if (b->pipeline) b->vk.vkDestroyPipeline(b->device, b->pipeline, NULL);
    if (b->sampler) b->vk.vkDestroySampler(b->device, b->sampler, NULL);
    if (b->layout) b->vk.vkDestroyPipelineLayout(b->device, b->layout, NULL);
    if (b->descriptor_pool) b->vk.vkDestroyDescriptorPool(b->device, b->descriptor_pool, NULL);
    if (b->set_layout) b->vk.vkDestroyDescriptorSetLayout(b->device, b->set_layout, NULL);
    swapchain_destroy(b);
  }
  /* The surface is this file's, so it goes before the layer takes the instance with it. */
  if (b->surface && b->vk.vkDestroySurfaceKHR) b->vk.vkDestroySurfaceKHR(b->instance, b->surface, NULL);
  re_gpu_close(b->gpu);
  if (b->gipa) SDL_Vulkan_UnloadLibrary();
  free(b);
}
static const ReBackendOps ops = {"vulkan", density, begin, execute, present, snapshot, texture_create, texture_update, texture_destroy, close_backend};

Uint32 re_backend_vk_window_flags(void) { return SDL_WINDOW_VULKAN; }

ReBackend *re_backend_vk_open(SDL_Window *window, ReFontSet *fonts) {
  VkBackend *b = calloc(1, sizeof(*b)); if (!b) return NULL;
  b->window = window; b->base.ops = &ops; b->base.fonts = fonts; b->density = 1.0f;
  if (!open_gpu(b) || !swapchain_create(b) || !open_pipeline(b) || !open_frames(b)) { close_backend(&b->base); return NULL; }
  atlas_reset(b);
  return &b->base;
}
