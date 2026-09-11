/* Where the seam's loose state becomes a Vulkan pipeline, and a draw happens (F130, spec 124).
 *
 * Split from gpu_seam_vk.c to keep both files under the thousand lines this project asks for, and
 * because this is the part D14c was actually a bet about: OpenGL lets a call site change blending or
 * culling between two draws for free, and Vulkan makes that a different pipeline object. If the bet
 * were wrong, it would be wrong HERE — so the whole of the coalescing is in one file where its cost
 * can be read at a glance.
 */
#include "gpu_seam_vk_internal.h"

#include <string.h>

static VkBlendFactor destination(uint8_t blend) {
  return blend == RE_SEAM_BLEND_ADDITIVE ? VK_BLEND_FACTOR_ONE : VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
}
static VkBlendFactor source(uint8_t blend) {
  return blend == RE_SEAM_BLEND_NONE || blend == RE_SEAM_BLEND_PREMULTIPLIED
           ? VK_BLEND_FACTOR_ONE : VK_BLEND_FACTOR_SRC_ALPHA;
}

static VkCompareOp compare_op(uint8_t compare) {
  switch (compare) {
    case RE_SEAM_DEPTH_LESS_EQUAL: return VK_COMPARE_OP_LESS_OR_EQUAL;
    case RE_SEAM_DEPTH_EQUAL: return VK_COMPARE_OP_EQUAL;
    case RE_SEAM_DEPTH_ALWAYS: return VK_COMPARE_OP_ALWAYS;
    default: return VK_COMPARE_OP_LESS;
  }
}

static VkFormat attribute_format(const ReSeamVertexAttribute *attribute) {
  if (attribute->type == RE_SEAM_ATTRIBUTE_UNORM8) {
    switch (attribute->components) {
      case 1: return VK_FORMAT_R8_UNORM;
      case 2: return VK_FORMAT_R8G8_UNORM;
      case 3: return VK_FORMAT_R8G8B8_UNORM;
      default: return VK_FORMAT_R8G8B8A8_UNORM;
    }
  }
  switch (attribute->components) {
    case 1: return VK_FORMAT_R32_SFLOAT;
    case 2: return VK_FORMAT_R32G32_SFLOAT;
    case 3: return VK_FORMAT_R32G32B32_SFLOAT;
    default: return VK_FORMAT_R32G32B32A32_SFLOAT;
  }
}

static VkPipeline build(ReSeam *seam, const PipelineKey *key) {
  const ProgramSlot *program = &seam->programs[key->program - 1];
  const ArraySlot *array = &seam->arrays[key->array - 1];

  VkPipelineShaderStageCreateInfo stages[2] = {
    {.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT,
     .module = program->vertex, .pName = "main"},
    {.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT,
     .module = program->fragment, .pName = "main"},
  };

  VkVertexInputBindingDescription binding = {.binding = 0, .stride = array->stride,
                                             .inputRate = VK_VERTEX_INPUT_RATE_VERTEX};
  VkVertexInputAttributeDescription attributes[8];
  for (int i = 0; i < array->count; i++)
    attributes[i] = (VkVertexInputAttributeDescription){
      .location = (uint32_t)array->attributes[i].location, .binding = 0,
      .format = attribute_format(&array->attributes[i]),
      .offset = (uint32_t)array->attributes[i].offset};
  VkPipelineVertexInputStateCreateInfo input = {
    .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO,
    .vertexBindingDescriptionCount = 1, .pVertexBindingDescriptions = &binding,
    .vertexAttributeDescriptionCount = (uint32_t)array->count, .pVertexAttributeDescriptions = attributes};

  VkPipelineInputAssemblyStateCreateInfo assembly = {
    .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
    .topology = key->primitive == RE_SEAM_PRIMITIVE_LINES ? VK_PRIMITIVE_TOPOLOGY_LINE_LIST
                                                          : VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST};
  VkPipelineViewportStateCreateInfo viewport = {
    .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1, .scissorCount = 1};
  VkPipelineRasterizationStateCreateInfo raster = {
    .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
    .polygonMode = VK_POLYGON_MODE_FILL,
    .cullMode = key->cull == RE_SEAM_CULL_BACK ? VK_CULL_MODE_BACK_BIT : VK_CULL_MODE_NONE,
    /* OpenGL's front face is counter-clockwise, and Vulkan's Y axis runs the other way down the
       framebuffer — which mirrors every triangle and so reverses the winding it presents. Clockwise
       here is what makes a call site's `Cull::Back` cull the same faces on both backends. It pairs
       with the unflipped viewport in gpu_seam_vk.c; change one and this must change with it. */
    .frontFace = VK_FRONT_FACE_CLOCKWISE, .lineWidth = 1.0f};
  VkPipelineMultisampleStateCreateInfo multisample = {
    .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
    .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT};
  VkPipelineDepthStencilStateCreateInfo depth = {
    .sType = VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO,
    .depthTestEnable = key->depth_test == RE_SEAM_DEPTH_TEST_ENABLED,
    .depthWriteEnable = key->depth_write == RE_SEAM_DEPTH_WRITE_ENABLED,
    .depthCompareOp = compare_op(key->depth_compare), .maxDepthBounds = 1.0f};
  VkPipelineColorBlendAttachmentState attachment = {
    .blendEnable = key->blend_color != RE_SEAM_BLEND_NONE || key->blend_alpha != RE_SEAM_BLEND_NONE,
    .srcColorBlendFactor = source(key->blend_color),
    .dstColorBlendFactor = key->blend_color == RE_SEAM_BLEND_NONE ? VK_BLEND_FACTOR_ZERO : destination(key->blend_color),
    .colorBlendOp = VK_BLEND_OP_ADD,
    .srcAlphaBlendFactor = source(key->blend_alpha),
    .dstAlphaBlendFactor = key->blend_alpha == RE_SEAM_BLEND_NONE ? VK_BLEND_FACTOR_ZERO : destination(key->blend_alpha),
    .alphaBlendOp = VK_BLEND_OP_ADD,
    .colorWriteMask = VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT | VK_COLOR_COMPONENT_B_BIT |
                      VK_COLOR_COMPONENT_A_BIT};
  VkPipelineColorBlendStateCreateInfo blend = {
    .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
    .attachmentCount = 1, .pAttachments = &attachment};
  VkDynamicState dynamic_states[2] = {VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR};
  VkPipelineDynamicStateCreateInfo dynamic = {
    .sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO,
    .dynamicStateCount = 2, .pDynamicStates = dynamic_states};
  /* Dynamic rendering: the pipeline is told the attachment formats instead of a VkRenderPass, which
     is why nothing here has to keep a render pass and a framebuffer in step with a target. */
  VkPipelineRenderingCreateInfo rendering = {
    .sType = VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO, .colorAttachmentCount = 1,
    .pColorAttachmentFormats = &key->color_format,
    .depthAttachmentFormat = key->depth_format};

  VkGraphicsPipelineCreateInfo info = {
    .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .pNext = &rendering,
    .stageCount = 2, .pStages = stages, .pVertexInputState = &input, .pInputAssemblyState = &assembly,
    .pViewportState = &viewport, .pRasterizationState = &raster, .pMultisampleState = &multisample,
    .pDepthStencilState = &depth, .pColorBlendState = &blend, .pDynamicState = &dynamic,
    .layout = program->layout};
  VkPipeline pipeline = VK_NULL_HANDLE;
  if (seam->vkCreateGraphicsPipelines(seam->device, VK_NULL_HANDLE, 1, &info, NULL, &pipeline) != VK_SUCCESS)
    return VK_NULL_HANDLE;
  return pipeline;
}

static VkPipeline pipeline_for(ReSeam *seam, const PipelineKey *key) {
  for (uint32_t i = 0; i < seam->pipeline_count; i++)
    if (memcmp(&seam->pipelines[i].key, key, sizeof(*key)) == 0) return seam->pipelines[i].pipeline;
  if (seam->pipeline_count == MAX_PIPELINES) {
    re_seam_vk_report(seam, "gpu: the pipeline cache is full (%d); a state combination was not drawn",
                      MAX_PIPELINES);
    return VK_NULL_HANDLE;
  }
  VkPipeline pipeline = build(seam, key);
  if (pipeline == VK_NULL_HANDLE) {
    re_seam_vk_report(seam, "gpu: vkCreateGraphicsPipelines failed for this state combination");
    return VK_NULL_HANDLE;
  }
  seam->pipelines[seam->pipeline_count].key = *key;
  seam->pipelines[seam->pipeline_count].pipeline = pipeline;
  seam->pipeline_count++;
  return pipeline;
}

void re_seam_draw(ReSeam *seam, ReSeamPrimitive primitive, int first, int count) {
  if (seam == NULL || !seam->pass_open || seam->program == 0 || seam->array == 0 || count <= 0) return;
  const ArraySlot *array = &seam->arrays[seam->array - 1];
  if (array->buffer == 0 || seam->buffers[array->buffer - 1].buffer == VK_NULL_HANDLE) return;
  const TargetSlot *target = &seam->targets[seam->bound.id - 1];
  ProgramSlot *program = &seam->programs[seam->program - 1];

  PipelineKey key = {
    .program = seam->program, .array = seam->array,
    .blend_color = seam->blend_color, .blend_alpha = seam->blend_alpha,
    .depth_test = seam->depth_test, .depth_write = seam->depth_write,
    .depth_compare = seam->depth_compare, .cull = seam->cull, .primitive = (uint8_t)primitive,
    .color_format = target->color_format, .depth_format = target->depth ? target->depth_format : VK_FORMAT_UNDEFINED,
  };
  VkPipeline pipeline = pipeline_for(seam, &key);
  if (pipeline == VK_NULL_HANDLE) return;

  /* The uniforms this draw sees are a copy taken now: a later setUniform must not reach back and
     change a draw already recorded, which is exactly what a single shared buffer would do. */
  if (seam->uniform_offset + seam->uniform_stride > seam->uniform_ring.size) {
    re_seam_vk_report(seam, "gpu: more than %d draws in one frame; the uniform ring wrapped", UNIFORM_SLOTS);
    return;
  }
  VkDeviceSize slot = seam->uniform_offset;
  if (program->uniforms != NULL)
    memcpy((char *)seam->uniform_ring.mapped + slot, program->uniforms, program->reflect.block_size);
  seam->uniform_offset += seam->uniform_stride;

  VkDescriptorSetAllocateInfo allocate = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                          .descriptorPool = seam->descriptors, .descriptorSetCount = 1,
                                          .pSetLayouts = &program->set_layout};
  VkDescriptorSet set = VK_NULL_HANDLE;
  if (seam->vkAllocateDescriptorSets(seam->device, &allocate, &set) != VK_SUCCESS) {
    re_seam_vk_report(seam, "gpu: out of descriptor sets this frame");
    return;
  }
  VkDescriptorBufferInfo buffer = {.buffer = seam->uniform_ring.buffer, .offset = 0,
                                   .range = program->reflect.block_size ? program->reflect.block_size : 4};
  VkWriteDescriptorSet writes[1 + RE_SPIRV_MAX_SAMPLERS];
  VkDescriptorImageInfo images[RE_SPIRV_MAX_SAMPLERS];
  uint32_t write_count = 0;
  writes[write_count++] = (VkWriteDescriptorSet){
    .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set,
    .dstBinding = program->reflect.block_binding, .descriptorCount = 1,
    .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, .pBufferInfo = &buffer};
  for (uint32_t i = 0; i < program->reflect.sampler_count; i++) {
    /* Binding 1 is unit 0, binding 2 is unit 1: the call site's texture unit and the shader's
       binding number are the same ordering, which is what lets `bindTexture(t, 3)` keep meaning what
       it meant on OpenGL without the shader knowing. */
    uint32_t unit = program->reflect.samplers[i].binding - 1u;
    uint32_t texture = unit < MAX_UNITS ? seam->units[unit] : 0;
    if (texture == 0) texture = seam->units[0];
    if (texture == 0) continue;
    const TextureSlot *slot_texture = &seam->textures[texture - 1];
    images[i] = (VkDescriptorImageInfo){.sampler = slot_texture->sampler, .imageView = slot_texture->view,
                                        .imageLayout = VK_IMAGE_LAYOUT_GENERAL};
    writes[write_count++] = (VkWriteDescriptorSet){
      .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set,
      .dstBinding = program->reflect.samplers[i].binding, .descriptorCount = 1,
      .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, .pImageInfo = &images[i]};
  }
  seam->vkUpdateDescriptorSets(seam->device, write_count, writes, 0, NULL);

  uint32_t dynamic_offset = (uint32_t)slot;
  seam->vkCmdBindPipeline(seam->cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline);
  seam->vkCmdBindDescriptorSets(seam->cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, program->layout, 0, 1, &set,
                                1, &dynamic_offset);
  VkDeviceSize zero = 0;
  seam->vkCmdBindVertexBuffers(seam->cmd, 0, 1, &seam->buffers[array->buffer - 1].buffer, &zero);
  seam->vkCmdSetViewport(seam->cmd, 0, 1, &seam->viewport);
  seam->vkCmdSetScissor(seam->cmd, 0, 1, &seam->scissor);
  seam->vkCmdDraw(seam->cmd, (uint32_t)count, 1, (uint32_t)first, 0);
}
