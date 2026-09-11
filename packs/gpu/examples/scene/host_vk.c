/* The Vulkan host: a device from the pack's own device layer, an off-screen image, and a read-back.
 *
 * This is the other half of the point. rEngine's device layer (F120) already does instance creation,
 * physical-device selection, device and queue — with NO window and no surface — so a host that only
 * ever renders off-screen needs no windowing at all. That is not a shortcut taken for the example:
 * it is the property that makes the same two layers usable from an OpenXR runtime, which supplies
 * images and has no surface either.
 *
 * WHAT THIS HOST DOES NOT DO, and why it is the host's absence rather than the seam's. A windowed
 * Vulkan path needs a surface and a swapchain. Both belong to whoever owns the window — the seam
 * creates neither, by design and by a build gate — so presenting would be a few hundred lines of
 * host code that rEngine's own backend_vk.c already contains and that F133 brings along when the
 * desktop moves onto the seam. Until then this host renders off-screen and says so plainly rather
 * than pretending a window would work.
 */
#include "host.h"
#include "rengine/gpu_device.h"

#include <SDL.h>
#include <SDL_vulkan.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdlib.h>
#include <string.h>

struct Host {
  SDL_Window *window;
  ReGpu *gpu;
  ReSeam *seam;
  ReSeamTarget target;
  ReSeamTexture color, depth;
  int width, height;
  bool offscreen;
};

static void on_message(void *user, const char *message) { (void)user; fprintf(stderr, "%s\n", message); }

/* Every validation message is a failure, so it goes to stderr with a prefix a test can grep for. */
static VKAPI_ATTR VkBool32 VKAPI_CALL validation_message(
    VkDebugUtilsMessageSeverityFlagBitsEXT severity, VkDebugUtilsMessageTypeFlagsEXT types,
    const VkDebugUtilsMessengerCallbackDataEXT *data, void *user) {
  (void)severity; (void)types; (void)user;
  fprintf(stderr, "validation: %s\n", data && data->pMessage ? data->pMessage : "(no message)");
  return VK_FALSE;
}

/* Every adapter is acceptable: there is no surface to present to and no runtime naming one, which is
 * exactly the case the device layer's predicate exists to let a host express. */
static bool accept_any(void *user, VkInstance instance, VkPhysicalDevice physical, uint32_t family) {
  (void)user; (void)instance; (void)physical; (void)family;
  return true;
}

Host *host_open(int width, int height, bool offscreen, char *error, size_t error_size) {
  if (!offscreen) {
    snprintf(error, error_size,
             "the Vulkan host renders off-screen only: presenting needs a surface and a swapchain, "
             "which belong to the window's owner rather than to the seam. Use --snapshot, or the "
             "OpenGL build for a window.");
    return NULL;
  }
  if (SDL_Init(SDL_INIT_VIDEO) != 0) {
    snprintf(error, error_size, "SDL video unavailable (%s)", SDL_GetError());
    return NULL;
  }
  if (SDL_Vulkan_LoadLibrary(NULL) != 0) {
    snprintf(error, error_size, "no Vulkan loader (%s)", SDL_GetError());
    return NULL;
  }
  Host *host = calloc(1, sizeof(*host));
  if (host == NULL) { snprintf(error, error_size, "out of memory"); return NULL; }
  host->width = width;
  host->height = height;
  host->offscreen = true;

  ReGpuOpen options = {0};
  options.get_instance_proc_addr = (PFN_vkGetInstanceProcAddr)SDL_Vulkan_GetVkGetInstanceProcAddr();
  options.accepts = accept_any;
  /* The validation layers are what turn "it rendered" into "it rendered legally", so the comparison
     runs with them on. Off by default because they are not installed everywhere and their absence is
     not this example's failure. */
  if (getenv("RENGINE_SCENE_VALIDATION") != NULL) {
    options.validation = true;
    options.on_message = validation_message;
  }
  /* No instance extensions and no device extensions: no surface, so no VK_KHR_swapchain either. A
     desktop backend asks SDL what it needs; a headset asks its runtime. */
  host->gpu = re_gpu_open(&options, error, error_size);
  if (host->gpu == NULL) return NULL;

  (void)0;
  ReSeamOpen seam_options = {0};
  seam_options.user = host->gpu;          /* the Vulkan backend takes the host's device */
  seam_options.on_message = on_message;
  host->seam = re_seam_open(&seam_options, error, error_size);
  if (host->seam == NULL) return NULL;

  host->color = re_seam_texture_2d_for(host->seam, NULL, width, height, RE_SEAM_FILTER_NEAREST,
                                       RE_SEAM_WRAP_CLAMP_TO_EDGE, RE_SEAM_TEXTURE_COLOR);
  host->depth = re_seam_texture_2d_for(host->seam, NULL, width, height, RE_SEAM_FILTER_NEAREST,
                                       RE_SEAM_WRAP_CLAMP_TO_EDGE, RE_SEAM_TEXTURE_DEPTH);
  host->target = re_seam_target(host->seam, host->color, host->depth);
  if (host->target.id == 0) {
    snprintf(error, error_size, "the off-screen target was not made; the seam reported why");
    return NULL;
  }
  return host;
}

void host_close(Host *host) {
  if (host == NULL) return;
  if (host->seam != NULL) {
    re_seam_target_destroy(host->seam, &host->target);
    re_seam_texture_destroy(host->seam, &host->color);
    re_seam_texture_destroy(host->seam, &host->depth);
    re_seam_close(host->seam);
  }
  if (host->gpu != NULL) re_gpu_close(host->gpu);
  if (host->window) SDL_DestroyWindow(host->window);
  SDL_Vulkan_UnloadLibrary();
  SDL_Quit();
  free(host);
}

ReSeam *host_seam(Host *host) { return host->seam; }
ReSeamTarget host_target(Host *host) { return host->target; }
bool host_poll(Host *host) { (void)host; return false; }
void host_present(Host *host) { (void)host; }

/* Read-back is the host's, the same way the window is: it copies the image the seam rendered into a
 * buffer it can map. The seam offers no such call on purpose — a synchronisation point inside a
 * frame path whose whole value is being thin would be the wrong place for it. */
bool host_read(Host *host, unsigned char *rgba, char *error, size_t error_size) {
  VkDevice device = re_gpu_device(host->gpu);
#define VK(name) PFN_##name name = (PFN_##name)re_gpu_device_proc(host->gpu, #name);
  VK(vkCreateBuffer) VK(vkDestroyBuffer) VK(vkGetBufferMemoryRequirements) VK(vkBindBufferMemory)
  VK(vkAllocateMemory) VK(vkFreeMemory) VK(vkMapMemory) VK(vkUnmapMemory)
  VK(vkCreateCommandPool) VK(vkDestroyCommandPool) VK(vkAllocateCommandBuffers)
  VK(vkBeginCommandBuffer) VK(vkEndCommandBuffer) VK(vkQueueSubmit) VK(vkQueueWaitIdle)
  VK(vkCmdCopyImageToBuffer)
#undef VK
  size_t bytes = (size_t)host->width * (size_t)host->height * 4u;
  VkBufferCreateInfo info = {.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, .size = bytes,
                             .usage = VK_BUFFER_USAGE_TRANSFER_DST_BIT};
  VkBuffer buffer = VK_NULL_HANDLE;
  VkDeviceMemory memory = VK_NULL_HANDLE;
  if (vkCreateBuffer(device, &info, NULL, &buffer) != VK_SUCCESS) {
    snprintf(error, error_size, "read-back buffer refused");
    return false;
  }
  VkMemoryRequirements need;
  vkGetBufferMemoryRequirements(device, buffer, &need);
  uint32_t type = re_gpu_memory_type(host->gpu, need.memoryTypeBits,
                                     VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
  VkMemoryAllocateInfo allocate = {.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
                                   .allocationSize = need.size, .memoryTypeIndex = type};
  if (type == UINT32_MAX || vkAllocateMemory(device, &allocate, NULL, &memory) != VK_SUCCESS) {
    snprintf(error, error_size, "no host-visible memory for the read-back");
    vkDestroyBuffer(device, buffer, NULL);
    return false;
  }
  vkBindBufferMemory(device, buffer, memory, 0);

  VkCommandPool pool = VK_NULL_HANDLE;
  VkCommandPoolCreateInfo pool_info = {.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,
                                       .queueFamilyIndex = re_gpu_family(host->gpu)};
  vkCreateCommandPool(device, &pool_info, NULL, &pool);
  VkCommandBuffer cmd = VK_NULL_HANDLE;
  VkCommandBufferAllocateInfo cmd_info = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
                                          .commandPool = pool, .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
                                          .commandBufferCount = 1};
  vkAllocateCommandBuffers(device, &cmd_info, &cmd);
  VkCommandBufferBeginInfo begin = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
                                    .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT};
  vkBeginCommandBuffer(cmd, &begin);
  VkBufferImageCopy region = {
    .imageSubresource = {.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT, .layerCount = 1},
    .imageExtent = {(uint32_t)host->width, (uint32_t)host->height, 1}};
  vkCmdCopyImageToBuffer(cmd, (VkImage)re_seam_texture_handle(host->seam, host->color), VK_IMAGE_LAYOUT_GENERAL,
                         buffer, 1, &region);
  vkEndCommandBuffer(cmd);
  VkSubmitInfo submit = {.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1,
                         .pCommandBuffers = &cmd};
  vkQueueSubmit(re_gpu_queue(host->gpu), 1, &submit, VK_NULL_HANDLE);
  vkQueueWaitIdle(re_gpu_queue(host->gpu));

  void *mapped = NULL;
  vkMapMemory(device, memory, 0, VK_WHOLE_SIZE, 0, &mapped);
  /* No flip. The backend renders with an unflipped viewport precisely so that row 0 means the same
     thing it means on OpenGL — see the long note in gpu_seam_vk.c — which is what lets a snapshot
     from either backend be compared directly and a render target be sampled by either. */
  memcpy(rgba, mapped, bytes);
  vkUnmapMemory(device, memory);
  vkDestroyCommandPool(device, pool, NULL);
  vkFreeMemory(device, memory, NULL);
  vkDestroyBuffer(device, buffer, NULL);
  return true;
}
