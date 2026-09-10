#ifndef RENGINE_RENDER_GPU_DEVICE_H
#define RENGINE_RENDER_GPU_DEVICE_H
/* The GPU device layer (charter D49, spec 122). Instance, physical-device selection, device, queue
 * and memory — and NO windowing symbol: no surface, no swapchain, no present, no SDL. That is not a
 * style preference. OpenXR dictates instance and device creation and then hands the application its
 * swapchain images, so a device layer that creates a surface cannot be used by a headset at all.
 *
 * The two things a caller must supply are exactly the two that differ between a window and an HMD:
 * the extensions the host requires, and a predicate saying which physical device is acceptable. The
 * desktop asks "can this queue family present to my surface"; an OpenXR host asks "is this the
 * adapter the runtime named". This layer can ask neither, so it asks the caller.
 *
 * `tools/design.py check` refuses a windowing symbol in this file or its implementation. */
#define VK_NO_PROTOTYPES
#include <vulkan/vulkan.h>
#if VK_HEADER_VERSION != 328
#error "Build against the vendored Vulkan headers in third_party/vulkan (tag v1.4.328)"
#endif
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct ReGpu ReGpu;

/* Returns true when this physical device and queue family are acceptable to the host. Called for
 * every (device, graphics-capable family) pair until one is accepted. */
typedef bool (*ReGpuAccepts)(void *user, VkInstance instance, VkPhysicalDevice physical, uint32_t family);

typedef struct {
  /* The host has already loaded the loader — SDL_Vulkan_GetVkGetInstanceProcAddr on the desktop,
   * xrGetInstanceProcAddr's Vulkan counterpart under OpenXR. This layer never loads one itself,
   * because choosing how to find the loader is the host's business. */
  PFN_vkGetInstanceProcAddr get_instance_proc_addr;
  const char *const *instance_extensions; uint32_t instance_extension_count;
  const char *const *device_extensions;   uint32_t device_extension_count;
  ReGpuAccepts accepts; void *user;
  bool validation;                       /* enable VK_LAYER_KHRONOS_validation and debug utils */
  PFN_vkDebugUtilsMessengerCallbackEXT on_message; void *message_user;
} ReGpuOpen;

/* Opens instance, device and queue, or returns NULL and writes why into `error`. The layer requires
 * Vulkan 1.3 with dynamic rendering, synchronization2 and shader demote — the same floor the desktop
 * backend already required, kept here so every host asks for the same one. */
ReGpu *re_gpu_open(const ReGpuOpen *options, char *error, size_t error_size);
void re_gpu_close(ReGpu *gpu);

VkInstance re_gpu_instance(const ReGpu *gpu);
VkPhysicalDevice re_gpu_physical(const ReGpu *gpu);
VkDevice re_gpu_device(const ReGpu *gpu);
VkQueue re_gpu_queue(const ReGpu *gpu);
uint32_t re_gpu_family(const ReGpu *gpu);
/* True when the chosen device required VK_KHR_portability_subset, which the host must also enable
 * on any pipeline-level feature it assumes. */
bool re_gpu_portability_subset(const ReGpu *gpu);
const char *re_gpu_device_name(const ReGpu *gpu);

/* How the host loads the entry points this layer deliberately does not know about — surface,
 * swapchain, present — and any it simply prefers to own. */
PFN_vkVoidFunction re_gpu_instance_proc(const ReGpu *gpu, const char *name);
PFN_vkVoidFunction re_gpu_device_proc(const ReGpu *gpu, const char *name);

/* The memory type index for a requirement, or UINT32_MAX when the device offers none. */
uint32_t re_gpu_memory_type(const ReGpu *gpu, uint32_t bits, VkMemoryPropertyFlags properties);
#endif
