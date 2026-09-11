/* What a backend needs to read out of a SPIR-V module (F130/F131, spec 124).
 *
 * Not Vulkan-only, which is why it does not live in a file named for Vulkan: the Metal backend needs
 * the same answers. SPIRV-Cross preserves a std140 block's memory layout when it emits MSL —
 * float4x4 at 64 bytes, float4 at 16 — so one reflection of the SPIR-V gives the offsets both
 * backends bind their uniform buffer with, and neither needs a reflector of its own. */
#ifndef RENGINE_GPU_SEAM_SPIRV_H
#define RENGINE_GPU_SEAM_SPIRV_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define RE_SPIRV_MAX_MEMBERS 32
#define RE_SPIRV_MAX_SAMPLERS 8
#define RE_SPIRV_MAX_NAME 64

typedef struct {
  char name[RE_SPIRV_MAX_NAME];
  uint32_t offset, size;
} ReSpirvMember;

typedef struct {
  char name[RE_SPIRV_MAX_NAME];
  uint32_t binding;
} ReSpirvSampler;

typedef struct {
  ReSpirvMember members[RE_SPIRV_MAX_MEMBERS];
  uint32_t member_count;
  uint32_t block_size;        /* bytes of the uniform block, or 0 when there is none */
  uint32_t block_binding;
  ReSpirvSampler samplers[RE_SPIRV_MAX_SAMPLERS];
  uint32_t sampler_count;
} ReSpirvLayout;

/* Reads the uniform block's member names and byte offsets, and the sampler bindings, out of one
 * SPIR-V module. Merges into `layout`, so a program's two stages can be read in turn.
 *
 * WHY THIS EXISTS. The seam looks uniforms up BY NAME, which vtmb-vr chose because "explicit binding
 * numbers would leak GL/Vulkan differences into call sites". Vulkan has no such lookup: a uniform is
 * a byte range in a block. Reflection is what closes that gap, and it is the reason a consumer's
 * shader generator needs to change nothing except to KEEP the SPIR-V it already produces and throws
 * away — no offset tables to emit, no new build step to maintain. */
bool re_spirv_reflect(const uint32_t *words, size_t bytes, ReSpirvLayout *layout,
                      char *error, size_t error_size);

#endif
