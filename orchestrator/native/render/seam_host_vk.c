/* The Vulkan host for the seam-backed draw list (spec 124, F133).
 *
 * The swapchain, and only the swapchain. The pack creates no surface and no swapchain by design —
 * the device layer because a headset host has neither (spec 122), the seam because a window's back
 * buffer belongs to whoever owns the window — so everything between "there is a window" and "there
 * is an image to draw into" lives here. It is the largest of the three hosts for that reason, and
 * it is still a fifth of backend_vk.c, which had to carry a renderer as well.
 *
 * Synchronisation is deliberately CPU-side. re_seam_frame_end submits with no semaphores and then
 * waits the queue idle — one frame in flight, which the seam documents as its model — so a host
 * that acquired with a semaphore would have nothing to hand it. Acquiring with a FENCE and waiting
 * on it before the frame gives the same guarantee through the only channel the seam leaves open,
 * and costs nothing that the seam's own wait did not already cost.
 */
#include "render/seam_host.h"

#include <rengine/gpu_device.h>
#include <SDL_vulkan.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_IMAGES 8

/* Surface, swapchain and present are loaded HERE, never by the pack: that is spec 122's rule, and
 * tools/design.py enforces that the device layer's translation unit never mentions them. */
#define RE_HOST_VK_INSTANCE(X) X(vkGetPhysicalDeviceSurfaceCapabilitiesKHR) X(vkGetPhysicalDeviceSurfaceFormatsKHR) \
  X(vkDestroySurfaceKHR) X(vkGetPhysicalDeviceSurfaceSupportKHR)
#define RE_HOST_VK_DEVICE(X) X(vkCreateSwapchainKHR) X(vkDestroySwapchainKHR) X(vkGetSwapchainImagesKHR) \
  X(vkAcquireNextImageKHR) X(vkQueuePresentKHR) X(vkCreateImageView) X(vkDestroyImageView) \
  X(vkCreateCommandPool) X(vkDestroyCommandPool) X(vkAllocateCommandBuffers) X(vkBeginCommandBuffer) \
  X(vkEndCommandBuffer) X(vkCmdPipelineBarrier2) X(vkCmdCopyImageToBuffer) X(vkQueueSubmit) \
  X(vkCreateFence) X(vkDestroyFence) X(vkWaitForFences) X(vkResetFences) X(vkDeviceWaitIdle) \
  X(vkCreateBuffer) X(vkDestroyBuffer) X(vkAllocateMemory) X(vkFreeMemory) X(vkBindBufferMemory) \
  X(vkMapMemory) X(vkGetBufferMemoryRequirements)

struct ReSeamHost {
  SDL_Window *window;
  ReGpu *gpu;
  ReSeam *seam;
  PFN_vkGetInstanceProcAddr gipa;
  VkInstance instance;
  VkPhysicalDevice physical;
  VkDevice device;
  VkQueue queue;
  uint32_t family;
  VkSurfaceKHR surface;
  VkSwapchainKHR swapchain;
  VkFormat format;
  VkExtent2D extent;
  VkImage images[MAX_IMAGES];
  VkImageView views[MAX_IMAGES];
  uint32_t image_count, image_index;
  VkCommandPool pool;
  VkCommandBuffer cmd;      /* the host's own: layout transitions and the snapshot copy */
  VkFence fence;            /* acquire and the host's submits both settle on this */
  VkBuffer readback;
  VkDeviceMemory readback_memory;
  void *readback_map;
  VkDeviceSize readback_size;
  ReSeamTarget target;
  int width, height;
  bool outdated, acquired;
  struct {
#define RE_HOST_VK_MEMBER(name) PFN_##name name;
    RE_HOST_VK_INSTANCE(RE_HOST_VK_MEMBER)
    RE_HOST_VK_DEVICE(RE_HOST_VK_MEMBER)
#undef RE_HOST_VK_MEMBER
  } vk;
};

static bool fail(const char *what, VkResult r) {
  SDL_SetError("Vulkan: %s failed (%d)", what, (int)r);
  return false;
}
static void on_message(void *user, const char *message) { (void)user; SDL_SetError("%s", message); }

/* The validation layers have to reach the same place backend_vk.c sends them, or a run with
   RENGINE_VULKAN_VALIDATION set would report zero messages because nothing was listening — which is
   the failure mode a validation gate exists to prevent. This host writes its own barriers, its own
   layout transitions and its own present, so it is exactly the code that needs them. */
static VKAPI_ATTR VkBool32 VKAPI_CALL validation_message(VkDebugUtilsMessageSeverityFlagBitsEXT severity,
                                                         VkDebugUtilsMessageTypeFlagsEXT type,
                                                         const VkDebugUtilsMessengerCallbackDataEXT *data,
                                                         void *user) {
  (void)severity; (void)type; (void)user;
  const char *log = getenv("RENGINE_VULKAN_VALIDATION_LOG");
  fprintf(stderr, "[vulkan validation] %s\n", data->pMessage);
  if (log && *log) { FILE *f = fopen(log, "a"); if (f) { fprintf(f, "%s\n", data->pMessage); fclose(f); } }
  return VK_FALSE;
}

Uint32 re_seam_host_flags(void) { return SDL_WINDOW_VULKAN; }
const char *re_seam_host_name(void) { return "vulkan"; }

/* The host's half of device selection (spec 122): the device layer cannot ask whether a queue family
   can present, because that needs a surface. The surface is created on the first call, once the
   instance exists, which is the only moment it can be. */
static bool accepts_device(void *user, VkInstance instance, VkPhysicalDevice physical, uint32_t family) {
  ReSeamHost *host = (ReSeamHost *)user;
  if (!host->surface && !SDL_Vulkan_CreateSurface(host->window, instance, &host->surface)) return false;
  PFN_vkGetPhysicalDeviceSurfaceSupportKHR supported =
    (PFN_vkGetPhysicalDeviceSurfaceSupportKHR)host->gipa(instance, "vkGetPhysicalDeviceSurfaceSupportKHR");
  if (!supported) return false;
  VkBool32 present = VK_FALSE;
  supported(physical, family, host->surface, &present);
  return present == VK_TRUE;
}

static void swapchain_destroy(ReSeamHost *host) {
  for (uint32_t i = 0; i < host->image_count; i++)
    if (host->views[i]) host->vk.vkDestroyImageView(host->device, host->views[i], NULL);
  memset(host->views, 0, sizeof(host->views));
  host->image_count = 0;
  if (host->swapchain) host->vk.vkDestroySwapchainKHR(host->device, host->swapchain, NULL);
  host->swapchain = VK_NULL_HANDLE;
}

static bool swapchain_create(ReSeamHost *host) {
  VkSurfaceCapabilitiesKHR caps;
  VkResult r = host->vk.vkGetPhysicalDeviceSurfaceCapabilitiesKHR(host->physical, host->surface, &caps);
  if (r != VK_SUCCESS) return fail("vkGetPhysicalDeviceSurfaceCapabilitiesKHR", r);
  uint32_t count = 0;
  host->vk.vkGetPhysicalDeviceSurfaceFormatsKHR(host->physical, host->surface, &count, NULL);
  VkSurfaceFormatKHR formats[64];
  if (count > 64) count = 64;
  r = host->vk.vkGetPhysicalDeviceSurfaceFormatsKHR(host->physical, host->surface, &count, formats);
  if (r != VK_SUCCESS || count == 0) return fail("vkGetPhysicalDeviceSurfaceFormatsKHR", r);

  /* Whatever the surface offers, preferring BGRA8 in sRGB — the same choice backend_vk.c makes, and
     on MoltenVK the only 8-bit one there is. The seam is TOLD this format when the view is adopted;
     it used to assume R8G8B8A8_UNORM, which no surface here offers at all. */
  VkSurfaceFormatKHR chosen = formats[0];
  for (uint32_t i = 0; i < count; i++)
    if (formats[i].colorSpace == VK_COLOR_SPACE_SRGB_NONLINEAR_KHR &&
        (chosen.colorSpace != VK_COLOR_SPACE_SRGB_NONLINEAR_KHR ||
         (formats[i].format == VK_FORMAT_B8G8R8A8_UNORM && chosen.format != VK_FORMAT_B8G8R8A8_UNORM)))
      chosen = formats[i];

  int dw = 0, dh = 0;
  SDL_Vulkan_GetDrawableSize(host->window, &dw, &dh);
  VkExtent2D extent = caps.currentExtent;
  if (extent.width == UINT32_MAX) {
    extent.width = (uint32_t)(dw > 0 ? dw : 1);
    extent.height = (uint32_t)(dh > 0 ? dh : 1);
  }
  if (extent.width < caps.minImageExtent.width) extent.width = caps.minImageExtent.width;
  if (extent.height < caps.minImageExtent.height) extent.height = caps.minImageExtent.height;
  if (extent.width > caps.maxImageExtent.width) extent.width = caps.maxImageExtent.width;
  if (extent.height > caps.maxImageExtent.height) extent.height = caps.maxImageExtent.height;
  if (!extent.width || !extent.height) return fail("swapchain extent (the window has no drawable area)", VK_ERROR_OUT_OF_DATE_KHR);
  if (!(caps.supportedUsageFlags & VK_IMAGE_USAGE_TRANSFER_SRC_BIT))
    return fail("swapchain transfer-source usage (the snapshot reads the image back)", VK_ERROR_FEATURE_NOT_PRESENT);

  uint32_t images = caps.minImageCount + 1;
  if (caps.maxImageCount && images > caps.maxImageCount) images = caps.maxImageCount;
  if (images > MAX_IMAGES) images = MAX_IMAGES;
  VkCompositeAlphaFlagBitsKHR alpha = VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR;
  if (!(caps.supportedCompositeAlpha & alpha))
    alpha = (VkCompositeAlphaFlagBitsKHR)(caps.supportedCompositeAlpha & -caps.supportedCompositeAlpha);
  VkSwapchainCreateInfoKHR ci = {
    .sType = VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR, .surface = host->surface,
    .minImageCount = images, .imageFormat = chosen.format, .imageColorSpace = chosen.colorSpace,
    .imageExtent = extent, .imageArrayLayers = 1,
    .imageUsage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT,
    .imageSharingMode = VK_SHARING_MODE_EXCLUSIVE, .preTransform = caps.currentTransform,
    .compositeAlpha = alpha, .presentMode = VK_PRESENT_MODE_FIFO_KHR, .clipped = VK_TRUE};
  r = host->vk.vkCreateSwapchainKHR(host->device, &ci, NULL, &host->swapchain);
  if (r != VK_SUCCESS) return fail("vkCreateSwapchainKHR", r);
  uint32_t n = 0;
  host->vk.vkGetSwapchainImagesKHR(host->device, host->swapchain, &n, NULL);
  if (n > MAX_IMAGES) return fail("swapchain image count", VK_ERROR_TOO_MANY_OBJECTS);
  r = host->vk.vkGetSwapchainImagesKHR(host->device, host->swapchain, &n, host->images);
  if (r != VK_SUCCESS) return fail("vkGetSwapchainImagesKHR", r);
  host->image_count = n;
  host->format = chosen.format;
  host->extent = extent;
  host->outdated = false;
  for (uint32_t i = 0; i < n; i++) {
    VkImageViewCreateInfo vi = {.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = host->images[i],
                                .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = chosen.format,
                                .subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1}};
    r = host->vk.vkCreateImageView(host->device, &vi, NULL, &host->views[i]);
    if (r != VK_SUCCESS) return fail("vkCreateImageView (swapchain)", r);
  }
  return true;
}

/* One command buffer, recorded and waited on the spot. Everything the host does to an image is a
   barrier or a copy, and both are cheap next to the frame the seam already waits for. */
static bool host_commands_begin(ReSeamHost *host) {
  VkCommandBufferBeginInfo bi = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
                                 .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT};
  return host->vk.vkBeginCommandBuffer(host->cmd, &bi) == VK_SUCCESS;
}
static bool host_commands_submit(ReSeamHost *host) {
  if (host->vk.vkEndCommandBuffer(host->cmd) != VK_SUCCESS) return false;
  host->vk.vkResetFences(host->device, 1, &host->fence);
  VkSubmitInfo submit = {.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1,
                         .pCommandBuffers = &host->cmd};
  if (host->vk.vkQueueSubmit(host->queue, 1, &submit, host->fence) != VK_SUCCESS) return false;
  return host->vk.vkWaitForFences(host->device, 1, &host->fence, VK_TRUE, UINT64_MAX) == VK_SUCCESS;
}
static void image_barrier(ReSeamHost *host, VkImage image, VkImageLayout from, VkImageLayout to) {
  VkImageMemoryBarrier2 barrier = {
    .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2,
    .srcStageMask = VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT, .srcAccessMask = VK_ACCESS_2_MEMORY_WRITE_BIT,
    .dstStageMask = VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT,
    .dstAccessMask = VK_ACCESS_2_MEMORY_READ_BIT | VK_ACCESS_2_MEMORY_WRITE_BIT,
    .oldLayout = from, .newLayout = to,
    .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED, .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
    .image = image, .subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1}};
  VkDependencyInfo dep = {.sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO, .imageMemoryBarrierCount = 1,
                          .pImageMemoryBarriers = &barrier};
  host->vk.vkCmdPipelineBarrier2(host->cmd, &dep);
}

ReSeamHost *re_seam_host_open(SDL_Window *window, char *error, size_t error_size) {
  ReSeamHost *host = calloc(1, sizeof(*host));
  if (!host) { snprintf(error, error_size, "out of memory"); return NULL; }
  host->window = window;
  if (SDL_Vulkan_LoadLibrary(NULL) != 0) { snprintf(error, error_size, "no Vulkan loader (%s)", SDL_GetError()); free(host); return NULL; }
  host->gipa = (PFN_vkGetInstanceProcAddr)SDL_Vulkan_GetVkGetInstanceProcAddr();
  if (!host->gipa) { snprintf(error, error_size, "the loader has no vkGetInstanceProcAddr"); free(host); return NULL; }

  unsigned count = 0;
  const char *instance_ext[24];
  if (!SDL_Vulkan_GetInstanceExtensions(window, &count, NULL) || count > 20) {
    snprintf(error, error_size, "instance extensions (%s)", SDL_GetError()); free(host); return NULL;
  }
  if (!SDL_Vulkan_GetInstanceExtensions(window, &count, instance_ext)) {
    snprintf(error, error_size, "instance extensions (%s)", SDL_GetError()); free(host); return NULL;
  }
  const char *validation = getenv("RENGINE_VULKAN_VALIDATION");
  static const char *device_ext[1] = {VK_KHR_SWAPCHAIN_EXTENSION_NAME};
  ReGpuOpen options = {
    .get_instance_proc_addr = host->gipa,
    .instance_extensions = instance_ext, .instance_extension_count = count,
    .device_extensions = device_ext, .device_extension_count = 1,
    .accepts = accepts_device, .user = host,
    .validation = validation && *validation && strcmp(validation, "0") != 0,
    .on_message = validation_message, .message_user = host,
  };
  host->gpu = re_gpu_open(&options, error, error_size);
  if (!host->gpu) { free(host); return NULL; }
  host->instance = re_gpu_instance(host->gpu);
  host->physical = re_gpu_physical(host->gpu);
  host->device = re_gpu_device(host->gpu);
  host->queue = re_gpu_queue(host->gpu);
  host->family = re_gpu_family(host->gpu);
#define RE_HOST_VK_LOAD_INSTANCE(name) \
  if (!(host->vk.name = (PFN_##name)re_gpu_instance_proc(host->gpu, #name))) { \
    snprintf(error, error_size, "the instance lacks %s", #name); re_seam_host_close(host); return NULL; }
  RE_HOST_VK_INSTANCE(RE_HOST_VK_LOAD_INSTANCE)
#undef RE_HOST_VK_LOAD_INSTANCE
#define RE_HOST_VK_LOAD_DEVICE(name) \
  if (!(host->vk.name = (PFN_##name)re_gpu_device_proc(host->gpu, #name))) { \
    snprintf(error, error_size, "the device lacks %s", #name); re_seam_host_close(host); return NULL; }
  RE_HOST_VK_DEVICE(RE_HOST_VK_LOAD_DEVICE)
#undef RE_HOST_VK_LOAD_DEVICE

  VkCommandPoolCreateInfo pi = {.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,
                                .flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT,
                                .queueFamilyIndex = host->family};
  if (host->vk.vkCreateCommandPool(host->device, &pi, NULL, &host->pool) != VK_SUCCESS) {
    snprintf(error, error_size, "vkCreateCommandPool failed"); re_seam_host_close(host); return NULL;
  }
  VkCommandBufferAllocateInfo ai = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
                                    .commandPool = host->pool, .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
                                    .commandBufferCount = 1};
  if (host->vk.vkAllocateCommandBuffers(host->device, &ai, &host->cmd) != VK_SUCCESS) {
    snprintf(error, error_size, "vkAllocateCommandBuffers failed"); re_seam_host_close(host); return NULL;
  }
  VkFenceCreateInfo fi = {.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
  if (host->vk.vkCreateFence(host->device, &fi, NULL, &host->fence) != VK_SUCCESS) {
    snprintf(error, error_size, "vkCreateFence failed"); re_seam_host_close(host); return NULL;
  }
  if (!swapchain_create(host)) {
    snprintf(error, error_size, "%s", SDL_GetError()); re_seam_host_close(host); return NULL;
  }

  ReSeamOpen seam_options = {0};
  seam_options.user = host->gpu;      /* the Vulkan seam takes the device layer, not a proc loader */
  seam_options.on_message = on_message;
  host->seam = re_seam_open(&seam_options, error, error_size);
  if (!host->seam) { re_seam_host_close(host); return NULL; }
  return host;
}

void re_seam_host_close(ReSeamHost *host) {
  if (!host) return;
  if (host->device && host->vk.vkDeviceWaitIdle) host->vk.vkDeviceWaitIdle(host->device);
  if (host->target.id) re_seam_target_destroy(host->seam, &host->target);
  re_seam_close(host->seam);
  if (host->readback_map) host->vk.vkFreeMemory(host->device, host->readback_memory, NULL);
  if (host->readback) host->vk.vkDestroyBuffer(host->device, host->readback, NULL);
  if (host->fence) host->vk.vkDestroyFence(host->device, host->fence, NULL);
  if (host->pool) host->vk.vkDestroyCommandPool(host->device, host->pool, NULL);
  if (host->swapchain) swapchain_destroy(host);
  if (host->surface && host->vk.vkDestroySurfaceKHR) host->vk.vkDestroySurfaceKHR(host->instance, host->surface, NULL);
  re_gpu_close(host->gpu);
  free(host);
}

ReSeam *re_seam_host_seam(ReSeamHost *host) { return host->seam; }

void re_seam_host_size(ReSeamHost *host, int *width, int *height) {
  SDL_Vulkan_GetDrawableSize(host->window, &host->width, &host->height);
  *width = host->width;
  *height = host->height;
}

ReSeamTarget re_seam_host_acquire(ReSeamHost *host) {
  ReSeamTarget none = {0, 0, 0};
  if (host->target.id) re_seam_target_destroy(host->seam, &host->target);
  host->target = none;
  host->acquired = false;
  SDL_Vulkan_GetDrawableSize(host->window, &host->width, &host->height);
  if (host->width < 1 || host->height < 1) return none;
  if (host->outdated || (uint32_t)host->width != host->extent.width ||
      (uint32_t)host->height != host->extent.height) {
    host->vk.vkDeviceWaitIdle(host->device);
    swapchain_destroy(host);
    if (!swapchain_create(host)) return none;
  }
  /* A fence, not a semaphore: re_seam_frame_end submits with neither, so a semaphore signalled here
     would have nothing to wait on it. Waiting on the CPU before the frame starts is the same
     guarantee through the channel the seam leaves open. */
  host->vk.vkResetFences(host->device, 1, &host->fence);
  VkResult r = host->vk.vkAcquireNextImageKHR(host->device, host->swapchain, UINT64_MAX,
                                              VK_NULL_HANDLE, host->fence, &host->image_index);
  if (r == VK_ERROR_OUT_OF_DATE_KHR) {
    host->outdated = true;
    return none;
  }
  if (r != VK_SUCCESS && r != VK_SUBOPTIMAL_KHR) { fail("vkAcquireNextImageKHR", r); return none; }
  host->vk.vkWaitForFences(host->device, 1, &host->fence, VK_TRUE, UINT64_MAX);
  host->acquired = true;

  /* The seam keeps every image in GENERAL and never transitions one it did not create, so the two
     ends of the swapchain's layout cycle are the host's: UNDEFINED to GENERAL here, GENERAL to
     PRESENT_SRC before presenting. */
  if (!host_commands_begin(host)) return none;
  image_barrier(host, host->images[host->image_index], VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_GENERAL);
  if (!host_commands_submit(host)) return none;

  host->target = re_seam_target_adopt(host->seam, (uintptr_t)host->views[host->image_index],
                                      (int)host->extent.width, (int)host->extent.height,
                                      (int)host->format);
  return host->target;
}

void re_seam_host_present(ReSeamHost *host) {
  if (!host->acquired) return;
  if (host_commands_begin(host)) {
    image_barrier(host, host->images[host->image_index], VK_IMAGE_LAYOUT_GENERAL,
                  VK_IMAGE_LAYOUT_PRESENT_SRC_KHR);
    host_commands_submit(host);
  }
  /* No wait semaphores: re_seam_frame_end waited the queue idle and the barrier above waited on a
     fence, so everything this image needs is already complete on the GPU. */
  VkPresentInfoKHR pi = {.sType = VK_STRUCTURE_TYPE_PRESENT_INFO_KHR, .swapchainCount = 1,
                         .pSwapchains = &host->swapchain, .pImageIndices = &host->image_index};
  VkResult r = host->vk.vkQueuePresentKHR(host->queue, &pi);
  if (r == VK_ERROR_OUT_OF_DATE_KHR || r == VK_SUBOPTIMAL_KHR) host->outdated = true;
  if (host->target.id) re_seam_target_destroy(host->seam, &host->target);
  host->target = (ReSeamTarget){0, 0, 0};
  host->acquired = false;
}

static bool readback_ensure(ReSeamHost *host, VkDeviceSize needed) {
  if (host->readback_size >= needed) return true;
  if (host->readback_map) { host->vk.vkFreeMemory(host->device, host->readback_memory, NULL); host->readback_map = NULL; }
  if (host->readback) host->vk.vkDestroyBuffer(host->device, host->readback, NULL);
  VkBufferCreateInfo bi = {.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, .size = needed,
                           .usage = VK_BUFFER_USAGE_TRANSFER_DST_BIT, .sharingMode = VK_SHARING_MODE_EXCLUSIVE};
  if (host->vk.vkCreateBuffer(host->device, &bi, NULL, &host->readback) != VK_SUCCESS) return false;
  VkMemoryRequirements need;
  host->vk.vkGetBufferMemoryRequirements(host->device, host->readback, &need);
  uint32_t type = re_gpu_memory_type(host->gpu, need.memoryTypeBits,
                                     VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
  if (type == UINT32_MAX) return false;
  VkMemoryAllocateInfo ai = {.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = need.size,
                             .memoryTypeIndex = type};
  if (host->vk.vkAllocateMemory(host->device, &ai, NULL, &host->readback_memory) != VK_SUCCESS) return false;
  if (host->vk.vkBindBufferMemory(host->device, host->readback, host->readback_memory, 0) != VK_SUCCESS) return false;
  if (host->vk.vkMapMemory(host->device, host->readback_memory, 0, VK_WHOLE_SIZE, 0, &host->readback_map) != VK_SUCCESS) return false;
  host->readback_size = needed;
  return true;
}

bool re_seam_host_snapshot(ReSeamHost *host, const char *path) {
  if (!host->acquired) return false;
  int w = (int)host->extent.width, h = (int)host->extent.height;
  if (!readback_ensure(host, (VkDeviceSize)w * h * 4)) return false;
  if (!host_commands_begin(host)) return false;
  image_barrier(host, host->images[host->image_index], VK_IMAGE_LAYOUT_GENERAL,
                VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL);
  VkBufferImageCopy region = {.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1},
                              .imageExtent = {(uint32_t)w, (uint32_t)h, 1}};
  host->vk.vkCmdCopyImageToBuffer(host->cmd, host->images[host->image_index],
                                  VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, host->readback, 1, &region);
  image_barrier(host, host->images[host->image_index], VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
                VK_IMAGE_LAYOUT_GENERAL);
  if (!host_commands_submit(host)) return false;
  /* No flip: Vulkan's row 0 is the top, as the seam's targets are everywhere. */
  SDL_Surface *surface = SDL_CreateRGBSurfaceWithFormat(
    0, w, h, 32, host->format == VK_FORMAT_B8G8R8A8_UNORM ? SDL_PIXELFORMAT_BGRA32 : SDL_PIXELFORMAT_RGBA32);
  if (!surface) return false;
  for (int y = 0; y < h; y++)
    memcpy((char *)surface->pixels + (size_t)y * (size_t)surface->pitch,
           (const char *)host->readback_map + (size_t)y * (size_t)w * 4, (size_t)w * 4);
  bool ok = SDL_SaveBMP(surface, path) == 0;
  SDL_FreeSurface(surface);
  return ok;
}
