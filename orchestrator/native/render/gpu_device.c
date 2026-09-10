/* See gpu_device.h. Creation only: the drawing path stays in whichever backend owns it, and this
 * file mentions no surface, no swapchain and no present — `tools/design.py check` enforces that. */
#include "render/gpu_device.h"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Loaded here rather than by the host, because these are exactly the calls creation needs. The
 * host's own table is filled through re_gpu_instance_proc / re_gpu_device_proc. */
#define RE_GPU_GLOBAL(X) X(vkCreateInstance) X(vkEnumerateInstanceExtensionProperties) X(vkEnumerateInstanceLayerProperties)
#define RE_GPU_INSTANCE(X) X(vkDestroyInstance) X(vkEnumeratePhysicalDevices) X(vkGetPhysicalDeviceProperties) \
  X(vkGetPhysicalDeviceQueueFamilyProperties) X(vkGetPhysicalDeviceMemoryProperties) X(vkGetPhysicalDeviceFeatures2) \
  X(vkEnumerateDeviceExtensionProperties) X(vkCreateDevice) X(vkGetDeviceProcAddr)
#define RE_GPU_DEVICE(X) X(vkDestroyDevice) X(vkGetDeviceQueue)

struct ReGpu {
#define RE_GPU_FIELD(name) PFN_##name name;
  RE_GPU_GLOBAL(RE_GPU_FIELD) RE_GPU_INSTANCE(RE_GPU_FIELD) RE_GPU_DEVICE(RE_GPU_FIELD)
#undef RE_GPU_FIELD
  PFN_vkGetInstanceProcAddr get_instance_proc_addr;
  PFN_vkCreateDebugUtilsMessengerEXT create_messenger;
  PFN_vkDestroyDebugUtilsMessengerEXT destroy_messenger;
  VkInstance instance; VkDebugUtilsMessengerEXT messenger;
  VkPhysicalDevice physical; VkDevice device; VkQueue queue; uint32_t family;
  bool portability_subset;
  char name[VK_MAX_PHYSICAL_DEVICE_NAME_SIZE];
  VkPhysicalDeviceMemoryProperties memory;
};

static bool say(char *error, size_t size, const char *format, ...) {
  if (error && size) { va_list args; va_start(args, format); vsnprintf(error, size, format, args); va_end(args); }
  return false;
}
static bool listed(const VkExtensionProperties *props, uint32_t n, const char *name) {
  for (uint32_t i = 0; i < n; i++) if (!strcmp(props[i].extensionName, name)) return true;
  return false;
}

static bool open_instance(ReGpu *gpu, const ReGpuOpen *options, char *error, size_t size) {
  PFN_vkGetInstanceProcAddr gipa = options->get_instance_proc_addr;
  gpu->get_instance_proc_addr = gipa;
#define RE_GPU_LOAD(name) if (!(gpu->name = (PFN_##name)gipa(VK_NULL_HANDLE, #name))) return say(error, size, "the loader lacks %s", #name);
  RE_GPU_GLOBAL(RE_GPU_LOAD)
#undef RE_GPU_LOAD

  /* The caller's list, plus whatever this platform needs to enumerate portable implementations. */
  const char *extensions[32]; uint32_t count = 0;
  if (options->instance_extension_count > 28) return say(error, size, "too many instance extensions");
  for (uint32_t i = 0; i < options->instance_extension_count; i++) extensions[count++] = options->instance_extensions[i];

  uint32_t n = 0; gpu->vkEnumerateInstanceExtensionProperties(NULL, &n, NULL);
  VkExtensionProperties *props = calloc(n ? n : 1, sizeof(*props));
  if (!props) return say(error, size, "out of memory enumerating instance extensions");
  gpu->vkEnumerateInstanceExtensionProperties(NULL, &n, props);
  bool portability = listed(props, n, "VK_KHR_portability_enumeration");
  bool debug = listed(props, n, VK_EXT_DEBUG_UTILS_EXTENSION_NAME);
  free(props);
  if (portability) extensions[count++] = "VK_KHR_portability_enumeration";

  static const char *layers[1] = {"VK_LAYER_KHRONOS_validation"};
  uint32_t layer_count = 0;
  if (options->validation) {
    uint32_t ln = 0; gpu->vkEnumerateInstanceLayerProperties(&ln, NULL);
    VkLayerProperties *lp = calloc(ln ? ln : 1, sizeof(*lp));
    if (!lp) return say(error, size, "out of memory enumerating layers");
    gpu->vkEnumerateInstanceLayerProperties(&ln, lp);
    bool found = false;
    for (uint32_t i = 0; i < ln; i++) if (!strcmp(lp[i].layerName, layers[0])) found = true;
    free(lp);
    if (!found || !debug) return say(error, size, "validation was asked for but VK_LAYER_KHRONOS_validation or VK_EXT_debug_utils is not installed");
    layer_count = 1; extensions[count++] = VK_EXT_DEBUG_UTILS_EXTENSION_NAME;
  }

  VkDebugUtilsMessengerCreateInfoEXT dm = {.sType = VK_STRUCTURE_TYPE_DEBUG_UTILS_MESSENGER_CREATE_INFO_EXT,
    .messageSeverity = VK_DEBUG_UTILS_MESSAGE_SEVERITY_WARNING_BIT_EXT | VK_DEBUG_UTILS_MESSAGE_SEVERITY_ERROR_BIT_EXT,
    .messageType = VK_DEBUG_UTILS_MESSAGE_TYPE_VALIDATION_BIT_EXT, .pfnUserCallback = options->on_message, .pUserData = options->message_user};
  VkApplicationInfo app = {.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO, .pApplicationName = "rengine", .apiVersion = VK_API_VERSION_1_3};
  VkInstanceCreateInfo ci = {.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
    .pNext = (options->validation && options->on_message) ? &dm : NULL,
    .flags = portability ? VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR : 0,
    .pApplicationInfo = &app, .enabledLayerCount = layer_count, .ppEnabledLayerNames = layers,
    .enabledExtensionCount = count, .ppEnabledExtensionNames = extensions};
  VkResult r = gpu->vkCreateInstance(&ci, NULL, &gpu->instance);
  if (r != VK_SUCCESS) return say(error, size, "vkCreateInstance failed (%d)", (int)r);

#define RE_GPU_LOAD(name) if (!(gpu->name = (PFN_##name)gipa(gpu->instance, #name))) return say(error, size, "the instance lacks %s", #name);
  RE_GPU_INSTANCE(RE_GPU_LOAD)
#undef RE_GPU_LOAD

  if (options->validation && options->on_message) {
    gpu->create_messenger = (PFN_vkCreateDebugUtilsMessengerEXT)gipa(gpu->instance, "vkCreateDebugUtilsMessengerEXT");
    gpu->destroy_messenger = (PFN_vkDestroyDebugUtilsMessengerEXT)gipa(gpu->instance, "vkDestroyDebugUtilsMessengerEXT");
    if (!gpu->create_messenger || !gpu->destroy_messenger) return say(error, size, "debug messenger functions are missing");
    r = gpu->create_messenger(gpu->instance, &dm, NULL, &gpu->messenger);
    if (r != VK_SUCCESS) return say(error, size, "vkCreateDebugUtilsMessengerEXT failed (%d)", (int)r);
  }
  return true;
}

static bool open_device(ReGpu *gpu, const ReGpuOpen *options, char *error, size_t size) {
  uint32_t n = 0;
  VkResult r = gpu->vkEnumeratePhysicalDevices(gpu->instance, &n, NULL);
  if (r != VK_SUCCESS) return say(error, size, "vkEnumeratePhysicalDevices failed (%d)", (int)r);
  VkPhysicalDevice devices[16]; if (n > 16) n = 16;
  r = gpu->vkEnumeratePhysicalDevices(gpu->instance, &n, devices);
  if (r != VK_SUCCESS) return say(error, size, "vkEnumeratePhysicalDevices failed (%d)", (int)r);

  VkPhysicalDeviceProperties chosen; memset(&chosen, 0, sizeof(chosen));
  for (uint32_t i = 0; i < n && !gpu->physical; i++) {
    VkPhysicalDeviceProperties props; gpu->vkGetPhysicalDeviceProperties(devices[i], &props);
    if (props.apiVersion < VK_API_VERSION_1_3) continue;
    VkPhysicalDeviceVulkan13Features f13 = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES};
    VkPhysicalDeviceFeatures2 f2 = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2, .pNext = &f13};
    gpu->vkGetPhysicalDeviceFeatures2(devices[i], &f2);
    if (!f13.dynamicRendering || !f13.synchronization2 || !f13.shaderDemoteToHelperInvocation) continue;

    uint32_t en = 0; gpu->vkEnumerateDeviceExtensionProperties(devices[i], NULL, &en, NULL);
    VkExtensionProperties *ext = calloc(en ? en : 1, sizeof(*ext));
    if (!ext) return say(error, size, "out of memory enumerating device extensions");
    gpu->vkEnumerateDeviceExtensionProperties(devices[i], NULL, &en, ext);
    bool all = true;
    for (uint32_t k = 0; k < options->device_extension_count; k++)
      if (!listed(ext, en, options->device_extensions[k])) all = false;
    bool portability = listed(ext, en, "VK_KHR_portability_subset");
    free(ext);
    if (!all) continue;

    uint32_t qn = 0; gpu->vkGetPhysicalDeviceQueueFamilyProperties(devices[i], &qn, NULL);
    VkQueueFamilyProperties *queues = calloc(qn ? qn : 1, sizeof(*queues));
    if (!queues) return say(error, size, "out of memory enumerating queue families");
    gpu->vkGetPhysicalDeviceQueueFamilyProperties(devices[i], &qn, queues);
    for (uint32_t q = 0; q < qn && !gpu->physical; q++) {
      if (!(queues[q].queueFlags & VK_QUEUE_GRAPHICS_BIT)) continue;
      /* The host's question, which this layer cannot ask: presentation, or the runtime's adapter. */
      if (options->accepts && !options->accepts(options->user, gpu->instance, devices[i], q)) continue;
      gpu->physical = devices[i]; gpu->family = q; gpu->portability_subset = portability; chosen = props;
    }
    free(queues);
  }
  if (!gpu->physical)
    return say(error, size, "no device offers API 1.3 with dynamic rendering, synchronization2 and shader demote, the required extensions, and a queue family the host accepts");

  float priority = 1.0f;
  VkDeviceQueueCreateInfo queue = {.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, .queueFamilyIndex = gpu->family, .queueCount = 1, .pQueuePriorities = &priority};
  VkPhysicalDeviceVulkan13Features enable13 = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES,
    .shaderDemoteToHelperInvocation = VK_TRUE, .synchronization2 = VK_TRUE, .dynamicRendering = VK_TRUE};
  VkPhysicalDeviceFeatures2 enable2 = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2, .pNext = &enable13};

  const char *extensions[16]; uint32_t count = 0;
  if (options->device_extension_count > 15) return say(error, size, "too many device extensions");
  for (uint32_t i = 0; i < options->device_extension_count; i++) extensions[count++] = options->device_extensions[i];
  if (gpu->portability_subset) extensions[count++] = "VK_KHR_portability_subset";

  VkDeviceCreateInfo ci = {.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, .pNext = &enable2,
    .queueCreateInfoCount = 1, .pQueueCreateInfos = &queue,
    .enabledExtensionCount = count, .ppEnabledExtensionNames = extensions};
  r = gpu->vkCreateDevice(gpu->physical, &ci, NULL, &gpu->device);
  if (r != VK_SUCCESS) return say(error, size, "vkCreateDevice failed (%d)", (int)r);

#define RE_GPU_LOAD(name) if (!(gpu->name = (PFN_##name)gpu->vkGetDeviceProcAddr(gpu->device, #name))) return say(error, size, "the device lacks %s", #name);
  RE_GPU_DEVICE(RE_GPU_LOAD)
#undef RE_GPU_LOAD
  gpu->vkGetDeviceQueue(gpu->device, gpu->family, 0, &gpu->queue);
  gpu->vkGetPhysicalDeviceMemoryProperties(gpu->physical, &gpu->memory);
  snprintf(gpu->name, sizeof(gpu->name), "%s", chosen.deviceName);
  return true;
}

ReGpu *re_gpu_open(const ReGpuOpen *options, char *error, size_t error_size) {
  if (error && error_size) error[0] = 0;
  if (!options || !options->get_instance_proc_addr) { say(error, error_size, "a vkGetInstanceProcAddr is required"); return NULL; }
  ReGpu *gpu = calloc(1, sizeof(*gpu));
  if (!gpu) { say(error, error_size, "out of memory"); return NULL; }
  if (!open_instance(gpu, options, error, error_size) || !open_device(gpu, options, error, error_size)) {
    re_gpu_close(gpu); return NULL;
  }
  return gpu;
}

void re_gpu_close(ReGpu *gpu) {
  if (!gpu) return;
  if (gpu->device && gpu->vkDestroyDevice) gpu->vkDestroyDevice(gpu->device, NULL);
  if (gpu->messenger && gpu->destroy_messenger) gpu->destroy_messenger(gpu->instance, gpu->messenger, NULL);
  if (gpu->instance && gpu->vkDestroyInstance) gpu->vkDestroyInstance(gpu->instance, NULL);
  free(gpu);
}

VkInstance re_gpu_instance(const ReGpu *gpu) { return gpu ? gpu->instance : VK_NULL_HANDLE; }
VkPhysicalDevice re_gpu_physical(const ReGpu *gpu) { return gpu ? gpu->physical : VK_NULL_HANDLE; }
VkDevice re_gpu_device(const ReGpu *gpu) { return gpu ? gpu->device : VK_NULL_HANDLE; }
VkQueue re_gpu_queue(const ReGpu *gpu) { return gpu ? gpu->queue : VK_NULL_HANDLE; }
uint32_t re_gpu_family(const ReGpu *gpu) { return gpu ? gpu->family : 0; }
bool re_gpu_portability_subset(const ReGpu *gpu) { return gpu && gpu->portability_subset; }
const char *re_gpu_device_name(const ReGpu *gpu) { return gpu ? gpu->name : ""; }

PFN_vkVoidFunction re_gpu_instance_proc(const ReGpu *gpu, const char *name) {
  return gpu && gpu->get_instance_proc_addr ? gpu->get_instance_proc_addr(gpu->instance, name) : NULL;
}
PFN_vkVoidFunction re_gpu_device_proc(const ReGpu *gpu, const char *name) {
  return gpu && gpu->vkGetDeviceProcAddr ? gpu->vkGetDeviceProcAddr(gpu->device, name) : NULL;
}

uint32_t re_gpu_memory_type(const ReGpu *gpu, uint32_t bits, VkMemoryPropertyFlags properties) {
  if (!gpu) return UINT32_MAX;
  for (uint32_t i = 0; i < gpu->memory.memoryTypeCount; i++)
    if ((bits & (1u << i)) && (gpu->memory.memoryTypes[i].propertyFlags & properties) == properties) return i;
  return UINT32_MAX;
}
