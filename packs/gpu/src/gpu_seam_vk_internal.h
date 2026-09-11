/* What the Vulkan backend's two translation units share (F130, spec 124).
 *
 * Private to the pack: `src/` is not on a consumer's include path, and F123's outside-consumer check
 * asserts that. The split exists so neither file passes a thousand lines, and so the pipeline
 * coalescing — the part D14c was a bet about — sits in a file of its own.
 */
#ifndef RENGINE_GPU_SEAM_VK_INTERNAL_H
#define RENGINE_GPU_SEAM_VK_INTERNAL_H

#include "rengine/gpu_device.h"
#include "rengine/gpu_seam.h"
#include "gpu_seam_spirv.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define MAX_BUFFERS 256
#define MAX_TEXTURES 256
#define MAX_PROGRAMS 32
#define MAX_ARRAYS 64
#define MAX_TARGETS 32
#define MAX_PIPELINES 128
#define MAX_UNITS 8
#define UNIFORM_SLOTS 2048
#define SAMPLER_LOCATION_BIT 0x40000000

/* Every Vulkan entry point this backend uses. One list, so the table, the loading and the "which one
 * is missing" message cannot drift apart — the same shape the OpenGL backend uses. */
#define RE_SEAM_VK_DEVICE_FUNCTIONS(X)                                                              \
  X(vkCreateCommandPool) X(vkDestroyCommandPool) X(vkAllocateCommandBuffers)                        \
  X(vkBeginCommandBuffer) X(vkEndCommandBuffer) X(vkResetCommandPool)                               \
  X(vkQueueSubmit) X(vkQueueWaitIdle) X(vkDeviceWaitIdle)                                           \
  X(vkCreateBuffer) X(vkDestroyBuffer) X(vkGetBufferMemoryRequirements) X(vkBindBufferMemory)       \
  X(vkAllocateMemory) X(vkFreeMemory) X(vkMapMemory) X(vkUnmapMemory)                               \
  X(vkCreateImage) X(vkDestroyImage) X(vkGetImageMemoryRequirements) X(vkBindImageMemory)           \
  X(vkCreateImageView) X(vkDestroyImageView) X(vkCreateSampler) X(vkDestroySampler)                 \
  X(vkCreateShaderModule) X(vkDestroyShaderModule)                                                  \
  X(vkCreateDescriptorSetLayout) X(vkDestroyDescriptorSetLayout)                                    \
  X(vkCreatePipelineLayout) X(vkDestroyPipelineLayout)                                              \
  X(vkCreateGraphicsPipelines) X(vkDestroyPipeline)                                                 \
  X(vkCreateDescriptorPool) X(vkDestroyDescriptorPool) X(vkResetDescriptorPool)                     \
  X(vkAllocateDescriptorSets) X(vkUpdateDescriptorSets)                                             \
  X(vkCmdBindPipeline) X(vkCmdBindVertexBuffers) X(vkCmdBindDescriptorSets)                         \
  X(vkCmdSetViewport) X(vkCmdSetScissor) X(vkCmdDraw) X(vkCmdClearAttachments)                      \
  X(vkCmdPipelineBarrier) X(vkCmdCopyBufferToImage)                                                 \
  X(vkCmdBeginRendering) X(vkCmdEndRendering)

typedef struct { VkBuffer buffer; VkDeviceMemory memory; void *mapped; VkDeviceSize size; } BufferSlot;
typedef struct {
  VkImage image; VkDeviceMemory memory; VkImageView view; VkSampler sampler;
  int width, height; VkFormat format; bool depth;
} TextureSlot;
typedef struct {
  VkShaderModule vertex, fragment;
  VkDescriptorSetLayout set_layout;
  VkPipelineLayout layout;
  ReSpirvLayout reflect;
  uint8_t *uniforms;          /* the CPU-side block setUniform writes into */
} ProgramSlot;
typedef struct {
  uint32_t buffer;
  ReSeamVertexAttribute attributes[8];
  int count;
  uint32_t stride;
} ArraySlot;
typedef struct {
  VkImageView color, depth;
  uint32_t color_texture, depth_texture;
  int width, height;
  VkFormat color_format, depth_format;
} TargetSlot;
typedef struct {
  uint32_t program, array;
  uint8_t blend_color, blend_alpha, depth_test, depth_write, depth_compare, cull, primitive;
  VkFormat color_format, depth_format;
} PipelineKey;

struct ReSeam {
  ReGpu *gpu;
  VkDevice device;
  VkQueue queue;
#define RE_SEAM_VK_MEMBER(name) PFN_##name name;
  RE_SEAM_VK_DEVICE_FUNCTIONS(RE_SEAM_VK_MEMBER)
#undef RE_SEAM_VK_MEMBER
  ReSeamOnMessage on_message;
  void *message_user;

  VkCommandPool pool;
  VkCommandBuffer cmd;
  VkDescriptorPool descriptors;
  BufferSlot uniform_ring;
  VkDeviceSize uniform_stride, uniform_offset;

  BufferSlot buffers[MAX_BUFFERS];
  TextureSlot textures[MAX_TEXTURES];
  ProgramSlot programs[MAX_PROGRAMS];
  ArraySlot arrays[MAX_ARRAYS];
  TargetSlot targets[MAX_TARGETS];
  struct { PipelineKey key; VkPipeline pipeline; } pipelines[MAX_PIPELINES];
  uint32_t pipeline_count;

  /* the loose state a draw resolves into a pipeline */
  uint32_t program, array;
  uint8_t blend_color, blend_alpha, depth_test, depth_write, depth_compare, cull;
  uint32_t units[MAX_UNITS];
  VkViewport viewport;
  VkRect2D scissor;
  bool scissor_on;
  ReSeamTarget frame_target, bound;
  bool in_frame, pass_open;
};


/* Diagnostics go back to the host's callback; both files raise them. */
void re_seam_vk_report(ReSeam *seam, const char *format, ...);

#endif
