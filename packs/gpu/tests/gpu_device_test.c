/* The GPU device layer, exercised without a GPU (F120, spec 122).
 *
 * There is no Vulkan loader on the development machine, so the render comparison cannot judge the
 * Vulkan backend here (KI-079). But the thing this layer actually does — enumerate, filter, ask the
 * host, create, and report by name when it cannot — is decided entirely through the
 * vkGetInstanceProcAddr the CALLER supplies. That is a seam a test can stand in front of.
 *
 * So this hands the layer a loader of its own making and checks the decisions, which is precisely
 * the logic the extraction moved. It cannot tell you the backend still renders identically; it can
 * tell you the selection rules survived the move, and that is what a compile check could not. */
#include "rengine/gpu_device.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

/* ---- a loader that answers whatever the case under test wants -------------------------------- */

static struct {
  uint32_t api;                 /* what the one physical device reports */
  bool dynamic_rendering, sync2, demote;
  const char *device_extension; /* the single extension the device claims to have */
  uint32_t families;            /* how many queue families, all graphics-capable */
  bool created_device;          /* set when vkCreateDevice was reached */
  int accepts_calls;
  /* what the caller's extension lists actually became at creation time */
  bool instance_enabled, device_enabled;
} world;

/* Did `ci` enable `name`? A layer that checks availability and then forgets to pass the list on is
   the failure this answers, and it is invisible to any test that only asks whether open() succeeded. */
static bool enabled(const char *const *names, uint32_t count, const char *name) {
  for (uint32_t i = 0; i < count; i++) if (!strcmp(names[i], name)) return true;
  return false;
}

static VKAPI_ATTR VkResult VKAPI_CALL create_instance(const VkInstanceCreateInfo *ci, const VkAllocationCallbacks *a, VkInstance *out) {
  (void)a;
  world.instance_enabled = enabled(ci->ppEnabledExtensionNames, ci->enabledExtensionCount, "VK_TEST_instance_ext");
  *out = (VkInstance)(uintptr_t)0x1; return VK_SUCCESS;
}
static VKAPI_ATTR void VKAPI_CALL destroy_instance(VkInstance i, const VkAllocationCallbacks *a) { (void)i; (void)a; }
static VKAPI_ATTR VkResult VKAPI_CALL enumerate_instance_extensions(const char *layer, uint32_t *n, VkExtensionProperties *out) {
  (void)layer;
  if (!out) { *n = 1; return VK_SUCCESS; }
  snprintf(out[0].extensionName, sizeof(out[0].extensionName), "%s", "VK_TEST_instance_ext");
  *n = 1; return VK_SUCCESS;
}
static VKAPI_ATTR VkResult VKAPI_CALL enumerate_instance_layers(uint32_t *n, VkLayerProperties *out) {
  (void)out; *n = 0; return VK_SUCCESS;
}
static VKAPI_ATTR VkResult VKAPI_CALL enumerate_physical_devices(VkInstance i, uint32_t *n, VkPhysicalDevice *out) {
  (void)i; if (!out) { *n = 1; return VK_SUCCESS; } *n = 1; out[0] = (VkPhysicalDevice)(uintptr_t)0x2; return VK_SUCCESS;
}
static VKAPI_ATTR void VKAPI_CALL get_physical_device_properties(VkPhysicalDevice p, VkPhysicalDeviceProperties *out) {
  (void)p; memset(out, 0, sizeof(*out)); out->apiVersion = world.api; snprintf(out->deviceName, sizeof(out->deviceName), "%s", "Test Device");
}
static VKAPI_ATTR void VKAPI_CALL get_physical_device_features2(VkPhysicalDevice p, VkPhysicalDeviceFeatures2 *f2) {
  (void)p;
  VkPhysicalDeviceVulkan13Features *f13 = (VkPhysicalDeviceVulkan13Features *)f2->pNext;
  f13->dynamicRendering = world.dynamic_rendering; f13->synchronization2 = world.sync2;
  f13->shaderDemoteToHelperInvocation = world.demote;
}
static VKAPI_ATTR void VKAPI_CALL get_queue_families(VkPhysicalDevice p, uint32_t *n, VkQueueFamilyProperties *out) {
  (void)p;
  if (!out) { *n = world.families; return; }
  for (uint32_t i = 0; i < world.families; i++) { memset(&out[i], 0, sizeof(out[i])); out[i].queueFlags = VK_QUEUE_GRAPHICS_BIT; }
  *n = world.families;
}
static VKAPI_ATTR VkResult VKAPI_CALL enumerate_device_extensions(VkPhysicalDevice p, const char *layer, uint32_t *n, VkExtensionProperties *out) {
  (void)p; (void)layer;
  uint32_t have = world.device_extension ? 1u : 0u;
  if (!out) { *n = have; return VK_SUCCESS; }
  if (have) snprintf(out[0].extensionName, sizeof(out[0].extensionName), "%s", world.device_extension);
  *n = have; return VK_SUCCESS;
}
static VKAPI_ATTR void VKAPI_CALL get_memory_properties(VkPhysicalDevice p, VkPhysicalDeviceMemoryProperties *out) {
  (void)p; memset(out, 0, sizeof(*out));
  out->memoryTypeCount = 2;
  out->memoryTypes[0].propertyFlags = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT;
  out->memoryTypes[1].propertyFlags = VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT;
}
static VKAPI_ATTR VkResult VKAPI_CALL create_device(VkPhysicalDevice p, const VkDeviceCreateInfo *ci, const VkAllocationCallbacks *a, VkDevice *out) {
  (void)p; (void)a;
  world.device_enabled = enabled(ci->ppEnabledExtensionNames, ci->enabledExtensionCount, VK_KHR_SWAPCHAIN_EXTENSION_NAME);
  world.created_device = true; *out = (VkDevice)(uintptr_t)0x3; return VK_SUCCESS;
}
static VKAPI_ATTR void VKAPI_CALL destroy_device(VkDevice d, const VkAllocationCallbacks *a) { (void)d; (void)a; }
static VKAPI_ATTR void VKAPI_CALL get_device_queue(VkDevice d, uint32_t f, uint32_t i, VkQueue *out) {
  (void)d; (void)f; (void)i; *out = (VkQueue)(uintptr_t)0x4;
}
static VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL device_proc(VkDevice d, const char *name);

static VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL instance_proc(VkInstance instance, const char *name) {
  (void)instance;
#define WHEN(n, fn) if (!strcmp(name, n)) return (PFN_vkVoidFunction)fn;
  WHEN("vkCreateInstance", create_instance)
  WHEN("vkDestroyInstance", destroy_instance)
  WHEN("vkEnumerateInstanceExtensionProperties", enumerate_instance_extensions)
  WHEN("vkEnumerateInstanceLayerProperties", enumerate_instance_layers)
  WHEN("vkEnumeratePhysicalDevices", enumerate_physical_devices)
  WHEN("vkGetPhysicalDeviceProperties", get_physical_device_properties)
  WHEN("vkGetPhysicalDeviceFeatures2", get_physical_device_features2)
  WHEN("vkGetPhysicalDeviceQueueFamilyProperties", get_queue_families)
  WHEN("vkGetPhysicalDeviceMemoryProperties", get_memory_properties)
  WHEN("vkEnumerateDeviceExtensionProperties", enumerate_device_extensions)
  WHEN("vkCreateDevice", create_device)
  WHEN("vkGetDeviceProcAddr", device_proc)
#undef WHEN
  return NULL;
}
static VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL device_proc(VkDevice d, const char *name) {
  (void)d;
  if (!strcmp(name, "vkDestroyDevice")) return (PFN_vkVoidFunction)destroy_device;
  if (!strcmp(name, "vkGetDeviceQueue")) return (PFN_vkVoidFunction)get_device_queue;
  return NULL;
}

/* ---- the cases ------------------------------------------------------------------------------- */

static bool accept_all(void *user, VkInstance i, VkPhysicalDevice p, uint32_t family) {
  (void)user; (void)i; (void)p; (void)family; world.accepts_calls++; return true;
}
static bool accept_none(void *user, VkInstance i, VkPhysicalDevice p, uint32_t family) {
  (void)user; (void)i; (void)p; (void)family; world.accepts_calls++; return false;
}
static bool accept_second(void *user, VkInstance i, VkPhysicalDevice p, uint32_t family) {
  (void)user; (void)i; (void)p; world.accepts_calls++; return family == 1;
}

static void reset(void) {
  memset(&world, 0, sizeof(world));
  world.api = VK_API_VERSION_1_3;
  world.dynamic_rendering = world.sync2 = world.demote = true;
  world.device_extension = VK_KHR_SWAPCHAIN_EXTENSION_NAME;
  world.families = 1;
}
static ReGpuOpen options(ReGpuAccepts accepts) {
  static const char *device_ext[1] = {VK_KHR_SWAPCHAIN_EXTENSION_NAME};
  static const char *instance_ext[1] = {"VK_TEST_instance_ext"};
  ReGpuOpen o;
  memset(&o, 0, sizeof(o));
  o.get_instance_proc_addr = instance_proc;
  o.instance_extensions = instance_ext; o.instance_extension_count = 1;
  o.device_extensions = device_ext; o.device_extension_count = 1;
  o.accepts = accepts;
  return o;
}

int main(void) {
  char error[256];

  /* A device that meets the floor and a host that accepts it: opened, and every handle reaches the
     caller. Without this the failure cases below could all pass for the wrong reason. */
  reset();
  ReGpuOpen ok = options(accept_all);
  ReGpu *gpu = re_gpu_open(&ok, error, sizeof(error));
  assert(gpu && "a conforming device opens");
  assert(world.created_device && "vkCreateDevice was reached");
  assert(re_gpu_instance(gpu) && re_gpu_physical(gpu) && re_gpu_device(gpu) && re_gpu_queue(gpu));
  assert(!strcmp(re_gpu_device_name(gpu), "Test Device"));
  /* The caller's lists are the point of the layer: a headset host names extensions its runtime
     requires, and a layer that validates them but hands Vulkan its own list would leave that host
     with a device missing exactly what it asked for — while still reporting success. */
  assert(world.instance_enabled && "the caller's instance extension reached vkCreateInstance");
  assert(world.device_enabled && "the caller's device extension reached vkCreateDevice");
  /* Memory types come from the device the layer chose, not from a guess. */
  assert(re_gpu_memory_type(gpu, 0x3u, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT) == 1);
  assert(re_gpu_memory_type(gpu, 0x3u, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT) == 0);
  assert(re_gpu_memory_type(gpu, 0x1u, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT) == UINT32_MAX
         && "a requirement no type satisfies is refused, not rounded to zero");
  /* The host's own entry points reach it through the getters, which is how a backend keeps its
     surface and swapchain out of this layer. */
  assert(re_gpu_device_proc(gpu, "vkGetDeviceQueue") == (PFN_vkVoidFunction)get_device_queue);
  assert(re_gpu_instance_proc(gpu, "vkCreateDevice") == (PFN_vkVoidFunction)create_device);
  re_gpu_close(gpu);

  /* The host's predicate decides. A layer that ignored it would open here, and an OpenXR host would
     silently get whichever adapter came first rather than the one its runtime named. */
  reset();
  ReGpuOpen refused = options(accept_none);
  assert(!re_gpu_open(&refused, error, sizeof(error)) && "a host that accepts nothing gets nothing");
  assert(world.accepts_calls == 1 && "every graphics family was offered");
  assert(!world.created_device && "no device is created when the host refused");
  assert(strstr(error, "the host accepts") && error[0]);

  /* And it selects the family the host chose, not merely the first graphics one. */
  reset(); world.families = 2;
  ReGpuOpen second = options(accept_second);
  gpu = re_gpu_open(&second, error, sizeof(error));
  assert(gpu && re_gpu_family(gpu) == 1 && "the accepted family is the one taken");
  re_gpu_close(gpu);

  /* The floor the desktop backend already required, kept in one place so every host asks for it. */
  reset(); world.dynamic_rendering = false;
  ReGpuOpen no_dynamic = options(accept_all);
  assert(!re_gpu_open(&no_dynamic, error, sizeof(error)) && "dynamic rendering is required");

  reset(); world.api = VK_API_VERSION_1_2;
  ReGpuOpen old_api = options(accept_all);
  assert(!re_gpu_open(&old_api, error, sizeof(error)) && "API 1.3 is required");

  /* A caller's required extension the device lacks is a refusal, not a silent downgrade. */
  reset(); world.device_extension = NULL;
  ReGpuOpen missing = options(accept_all);
  assert(!re_gpu_open(&missing, error, sizeof(error)) && "a missing required device extension refuses");
  assert(!world.created_device);

  /* A loader missing an entry point is named rather than crashed on. */
  reset();
  ReGpuOpen none = options(accept_all);
  none.get_instance_proc_addr = NULL;
  assert(!re_gpu_open(&none, error, sizeof(error)));
  assert(strstr(error, "vkGetInstanceProcAddr"));

  puts("GPU device layer: selection, the host's predicate, the feature floor, extensions and errors passed.");
  return 0;
}
