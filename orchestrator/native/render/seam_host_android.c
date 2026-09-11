/* The Android host for the seam-backed draw list (charter D57, spec 128 decisions 7 and 8).
 *
 * The fourth host, and the first that is not the desktop. It is `seam_host_vk.c` with the three
 * things only the platform decides swapped out: the loader is `libvulkan.so` through dlopen rather
 * than SDL's, the surface comes from `vkCreateAndroidSurfaceKHR` on an `ANativeWindow` rather than
 * from `SDL_Vulkan_CreateSurface`, and the drawable size is the window's own.
 *
 * Everything above it is the desktop's: `backend_seam.c` draws the same draw list through the same
 * seam, and it compiles here unchanged because the window handle is opaque above this boundary. That
 * is the whole claim decision 10 makes — one UI layer, not a fork — and this file is where it stops
 * being a claim.
 *
 * Vulkan-only on Android by decision 8: no GL path on mobile, and a native Metal backend for iOS
 * when that platform ships.
 */
#include "render/seam_host.h"

#include <android/log.h>
#include <android/native_window.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <rengine/gpu_device.h>

#define TAG "rengine.companion"
#define MAX_IMAGES 8

#define RE_HOST_VK_INSTANCE(X) X(vkGetPhysicalDeviceSurfaceCapabilitiesKHR) X(vkGetPhysicalDeviceSurfaceFormatsKHR) \
  X(vkDestroySurfaceKHR) X(vkGetPhysicalDeviceSurfaceSupportKHR) X(vkCreateAndroidSurfaceKHR)
#define RE_HOST_VK_DEVICE(X) X(vkCreateSwapchainKHR) X(vkDestroySwapchainKHR) X(vkGetSwapchainImagesKHR) \
  X(vkAcquireNextImageKHR) X(vkQueuePresentKHR) X(vkCreateImageView) X(vkDestroyImageView) \
  X(vkCreateCommandPool) X(vkDestroyCommandPool) X(vkAllocateCommandBuffers) X(vkBeginCommandBuffer) \
  X(vkEndCommandBuffer) X(vkCmdPipelineBarrier2) X(vkQueueSubmit) \
  X(vkCreateFence) X(vkDestroyFence) X(vkWaitForFences) X(vkResetFences) X(vkDeviceWaitIdle)

struct ReSeamHost {
  ANativeWindow *window;
  ReGpu *gpu;
  ReSeam *seam;
  PFN_vkGetInstanceProcAddr gipa;
  void *loader;
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
  VkCommandBuffer cmd;
  VkFence fence;
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

/* There is no SDL_SetError here and nothing reads a thread-local error string, so a failure goes
   where a person on this platform will actually see it. */
void re_seam_host_fail(const char *message) {
  __android_log_print(ANDROID_LOG_ERROR, TAG, "%s", message);
}
static bool fail(const char *what, VkResult r) {
  __android_log_print(ANDROID_LOG_ERROR, TAG, "Vulkan: %s failed (%d)", what, (int)r);
  return false;
}

/* Android hands the app a window already made, so there are no attributes to set beforehand. */
uint32_t re_seam_host_flags(void) { return 0; }
const char *re_seam_host_name(void) { return "vulkan"; }

static bool accepts_device(void *user, VkInstance instance, VkPhysicalDevice physical, uint32_t family) {
  ReSeamHost *host = (ReSeamHost *)user;
  if (host->surface == VK_NULL_HANDLE) {
    PFN_vkCreateAndroidSurfaceKHR create =
      (PFN_vkCreateAndroidSurfaceKHR)host->gipa(instance, "vkCreateAndroidSurfaceKHR");
    if (!create) return false;
    VkAndroidSurfaceCreateInfoKHR info = {.sType = VK_STRUCTURE_TYPE_ANDROID_SURFACE_CREATE_INFO_KHR,
                                          .window = host->window};
    if (create(instance, &info, NULL, &host->surface) != VK_SUCCESS) return false;
  }
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
  /* Whatever the surface offers, preferring the 8-bit UNORM pair. The seam is TOLD this format when
     the view is adopted, which is the gap spec 124 closed for exactly this kind of host. */
  VkSurfaceFormatKHR chosen = formats[0];
  for (uint32_t i = 0; i < count; i++)
    if ((formats[i].format == VK_FORMAT_R8G8B8A8_UNORM || formats[i].format == VK_FORMAT_B8G8R8A8_UNORM) &&
        formats[i].colorSpace == VK_COLOR_SPACE_SRGB_NONLINEAR_KHR) { chosen = formats[i]; break; }

  VkExtent2D extent = caps.currentExtent;
  if (extent.width == UINT32_MAX) {
    extent.width = (uint32_t)ANativeWindow_getWidth(host->window);
    extent.height = (uint32_t)ANativeWindow_getHeight(host->window);
  }
  if (!extent.width || !extent.height) return fail("swapchain extent (the window has no area)", VK_ERROR_OUT_OF_DATE_KHR);

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
    .imageUsage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT,
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
  __android_log_print(ANDROID_LOG_INFO, TAG, "companion: swapchain %ux%u, %u image(s), format %d",
                      extent.width, extent.height, n, (int)chosen.format);
  return true;
}

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

ReSeamHost *re_seam_host_open(void *opaque, char *error, size_t error_size) {
  ReSeamHost *host = calloc(1, sizeof(*host));
  if (!host) { snprintf(error, error_size, "out of memory"); return NULL; }
  host->window = (ANativeWindow *)opaque;

  /* Android's loader is libvulkan.so, present since API 24 on any device with a driver. Loaded by
     name here for the same reason the pack takes its entry points from the host: the seam links no
     graphics library of its own. */
  host->loader = dlopen("libvulkan.so", RTLD_NOW | RTLD_LOCAL);
  if (!host->loader) { snprintf(error, error_size, "no libvulkan.so on this device"); free(host); return NULL; }
  host->gipa = (PFN_vkGetInstanceProcAddr)dlsym(host->loader, "vkGetInstanceProcAddr");
  if (!host->gipa) { snprintf(error, error_size, "libvulkan.so has no vkGetInstanceProcAddr"); free(host); return NULL; }

  static const char *instance_ext[2] = {VK_KHR_SURFACE_EXTENSION_NAME, VK_KHR_ANDROID_SURFACE_EXTENSION_NAME};
  static const char *device_ext[1] = {VK_KHR_SWAPCHAIN_EXTENSION_NAME};
  ReGpuOpen options = {
    .get_instance_proc_addr = host->gipa,
    .instance_extensions = instance_ext, .instance_extension_count = 2,
    .device_extensions = device_ext, .device_extension_count = 1,
    .accepts = accepts_device, .user = host,
  };
  /* Before asking the device layer for a device, say what this driver actually offers. Its refusal
     names a floor but not what fell short of it, and "the phone cannot" and "the predicate is
     broken" are different problems that read identically in a log. */
  {
    PFN_vkCreateInstance create = (PFN_vkCreateInstance)host->gipa(NULL, "vkCreateInstance");
    PFN_vkEnumerateInstanceVersion instance_version =
      (PFN_vkEnumerateInstanceVersion)host->gipa(NULL, "vkEnumerateInstanceVersion");
    uint32_t loader = 0;
    if (instance_version && instance_version(&loader) == VK_SUCCESS)
      __android_log_print(ANDROID_LOG_INFO, TAG, "companion: Vulkan loader reports %u.%u.%u",
                          VK_VERSION_MAJOR(loader), VK_VERSION_MINOR(loader), VK_VERSION_PATCH(loader));
    VkApplicationInfo app = {.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO, .apiVersion = VK_API_VERSION_1_1};
    VkInstanceCreateInfo ii = {.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, .pApplicationInfo = &app};
    VkInstance probe = VK_NULL_HANDLE;
    if (create && create(&ii, NULL, &probe) == VK_SUCCESS) {
      PFN_vkEnumeratePhysicalDevices list = (PFN_vkEnumeratePhysicalDevices)host->gipa(probe, "vkEnumeratePhysicalDevices");
      PFN_vkGetPhysicalDeviceProperties props = (PFN_vkGetPhysicalDeviceProperties)host->gipa(probe, "vkGetPhysicalDeviceProperties");
      PFN_vkDestroyInstance destroy = (PFN_vkDestroyInstance)host->gipa(probe, "vkDestroyInstance");
      uint32_t n = 0;
      if (list && props && list(probe, &n, NULL) == VK_SUCCESS && n) {
        VkPhysicalDevice devices[8];
        if (n > 8) n = 8;
        list(probe, &n, devices);
        for (uint32_t i = 0; i < n; i++) {
          VkPhysicalDeviceProperties p;
          props(devices[i], &p);
          __android_log_print(ANDROID_LOG_INFO, TAG, "companion: device %u is %s, Vulkan %u.%u.%u",
                              i, p.deviceName, VK_VERSION_MAJOR(p.apiVersion),
                              VK_VERSION_MINOR(p.apiVersion), VK_VERSION_PATCH(p.apiVersion));
          /* A device below 1.3 can still offer the seam's requirements as extensions, and that is
             the difference between "this phone never" and "this phone with a lower floor". */
          PFN_vkEnumerateDeviceExtensionProperties exts =
            (PFN_vkEnumerateDeviceExtensionProperties)host->gipa(probe, "vkEnumerateDeviceExtensionProperties");
          uint32_t count = 0;
          if (exts && exts(devices[i], NULL, &count, NULL) == VK_SUCCESS && count) {
            VkExtensionProperties *have = calloc(count, sizeof(*have));
            if (have && exts(devices[i], NULL, &count, have) == VK_SUCCESS) {
              const char *wanted[] = {"VK_KHR_dynamic_rendering", "VK_KHR_synchronization2",
                                      "VK_EXT_shader_demote_to_helper_invocation", "VK_KHR_swapchain"};
              for (size_t w = 0; w < sizeof(wanted) / sizeof(wanted[0]); w++) {
                bool found = false;
                for (uint32_t e = 0; e < count; e++)
                  if (!strcmp(have[e].extensionName, wanted[w])) { found = true; break; }
                __android_log_print(ANDROID_LOG_INFO, TAG, "companion:   %s %s",
                                    found ? "has" : "LACKS", wanted[w]);
              }
            }
            free(have);
          }
        }
      }
      if (destroy) destroy(probe, NULL);
    }
  }

  host->gpu = re_gpu_open(&options, error, error_size);
  if (!host->gpu) { re_seam_host_close(host); return NULL; }
  host->instance = re_gpu_instance(host->gpu);
  host->physical = re_gpu_physical(host->gpu);
  host->device = re_gpu_device(host->gpu);
  host->queue = re_gpu_queue(host->gpu);
  host->family = re_gpu_family(host->gpu);
  __android_log_print(ANDROID_LOG_INFO, TAG, "companion: Vulkan device %s", re_gpu_device_name(host->gpu));
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
  if (!swapchain_create(host)) { snprintf(error, error_size, "the swapchain could not be created"); re_seam_host_close(host); return NULL; }

  ReSeamOpen seam_options = {0};
  seam_options.user = host->gpu;
  host->seam = re_seam_open(&seam_options, error, error_size);
  if (!host->seam) { re_seam_host_close(host); return NULL; }
  return host;
}

void re_seam_host_close(ReSeamHost *host) {
  if (!host) return;
  if (host->device && host->vk.vkDeviceWaitIdle) host->vk.vkDeviceWaitIdle(host->device);
  if (host->target.id) re_seam_target_destroy(host->seam, &host->target);
  re_seam_close(host->seam);
  if (host->fence) host->vk.vkDestroyFence(host->device, host->fence, NULL);
  if (host->pool) host->vk.vkDestroyCommandPool(host->device, host->pool, NULL);
  if (host->swapchain) swapchain_destroy(host);
  if (host->surface && host->vk.vkDestroySurfaceKHR) host->vk.vkDestroySurfaceKHR(host->instance, host->surface, NULL);
  re_gpu_close(host->gpu);
  if (host->loader) dlclose(host->loader);
  free(host);
}

ReSeam *re_seam_host_seam(ReSeamHost *host) { return host->seam; }

void re_seam_host_size(ReSeamHost *host, int *width, int *height) {
  host->width = (int)host->extent.width;
  host->height = (int)host->extent.height;
  *width = host->width;
  *height = host->height;
}

ReSeamTarget re_seam_host_acquire(ReSeamHost *host) {
  ReSeamTarget none = {0, 0, 0};
  if (host->target.id) re_seam_target_destroy(host->seam, &host->target);
  host->target = none;
  host->acquired = false;
  if (host->outdated) {
    host->vk.vkDeviceWaitIdle(host->device);
    swapchain_destroy(host);
    if (!swapchain_create(host)) return none;
  }
  host->vk.vkResetFences(host->device, 1, &host->fence);
  VkResult r = host->vk.vkAcquireNextImageKHR(host->device, host->swapchain, UINT64_MAX,
                                              VK_NULL_HANDLE, host->fence, &host->image_index);
  if (r == VK_ERROR_OUT_OF_DATE_KHR) { host->outdated = true; return none; }
  if (r != VK_SUCCESS && r != VK_SUBOPTIMAL_KHR) { fail("vkAcquireNextImageKHR", r); return none; }
  host->vk.vkWaitForFences(host->device, 1, &host->fence, VK_TRUE, UINT64_MAX);
  host->acquired = true;

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
  VkPresentInfoKHR pi = {.sType = VK_STRUCTURE_TYPE_PRESENT_INFO_KHR, .swapchainCount = 1,
                         .pSwapchains = &host->swapchain, .pImageIndices = &host->image_index};
  VkResult r = host->vk.vkQueuePresentKHR(host->queue, &pi);
  if (r == VK_ERROR_OUT_OF_DATE_KHR || r == VK_SUBOPTIMAL_KHR) host->outdated = true;
  if (host->target.id) re_seam_target_destroy(host->seam, &host->target);
  host->target = (ReSeamTarget){0, 0, 0};
  host->acquired = false;
}

/* The read-back the desktop hosts use for reference frames is not here yet: the smoke snapshot this
   platform needs is `adb exec-out screencap`, which judges what the compositor actually showed
   rather than what the app believes it drew. F144's criterion 2 asks for that one. */
bool re_seam_host_snapshot(ReSeamHost *host, const char *path) {
  (void)host; (void)path;
  return false;
}
