/* Enough of a SPIR-V reader to answer "where does this uniform live" (F130, spec 124).
 *
 * Not a general parser and not trying to be: it walks the module once, keeps the handful of
 * decorations a uniform block and a sampler binding are made of, and answers by name. Everything
 * else in the module is skipped by word count, which is why an instruction this does not understand
 * costs nothing and breaks nothing.
 */
#include "gpu_seam_spirv.h"

#include <stdio.h>
#include <string.h>

#define SPIRV_MAGIC 0x07230203u

/* The opcodes and decorations this needs, named rather than spelled as numbers at the use site. */
enum {
  OpName = 5, OpMemberName = 6, OpTypeInt = 21, OpTypeFloat = 22, OpTypeVector = 23,
  OpTypeMatrix = 24, OpTypeImage = 25, OpTypeSampledImage = 27, OpTypeArray = 28,
  OpTypeStruct = 30, OpTypePointer = 32, OpVariable = 59, OpDecorate = 71, OpMemberDecorate = 72,
};
enum { DecorationBlock = 2, DecorationBinding = 33, DecorationDescriptorSet = 34, DecorationOffset = 35 };
enum { StorageClassUniformConstant = 0, StorageClassUniform = 2 };

#define MAX_IDS 4096

typedef struct {
  uint8_t op;                 /* the type-ish opcode that defined this id, or 0 */
  uint32_t a, b;              /* operands whose meaning depends on op: component type, count, ... */
  uint32_t binding, set;
  bool is_block, has_binding;
  char name[RE_SPIRV_MAX_NAME];
} Id;

/* A literal string in SPIR-V is packed four characters to a word, NUL-terminated and padded. */
static void copy_string(const uint32_t *words, uint32_t count, char *out, size_t size) {
  size_t written = 0;
  for (uint32_t w = 0; w < count && written + 1 < size; w++) {
    const char *chars = (const char *)&words[w];
    for (int i = 0; i < 4 && written + 1 < size; i++) {
      if (chars[i] == '\0') { out[written] = '\0'; return; }
      out[written++] = chars[i];
    }
  }
  out[written] = '\0';
}

/* The byte size of a type, for std140 as glslang lays it out. Only the forms this seam's shaders can
 * declare are handled; anything else answers 0, which the caller reports rather than guesses at. */
static uint32_t type_size(const Id *ids, uint32_t id) {
  if (id >= MAX_IDS) return 0;
  const Id *type = &ids[id];
  switch (type->op) {
    case OpTypeFloat:
    case OpTypeInt: return 4;
    case OpTypeVector: return type_size(ids, type->a) * type->b;
    case OpTypeMatrix: {
      /* std140 rounds each column up to a vec4, which is why a mat4 is 64 bytes and a mat3 is 48. */
      uint32_t column = type_size(ids, type->a);
      uint32_t padded = ((column + 15u) / 16u) * 16u;
      return padded * type->b;
    }
    default: return 0;
  }
}

bool re_spirv_reflect(const uint32_t *words, size_t bytes, ReSpirvLayout *layout,
                      char *error, size_t error_size) {
  size_t count = bytes / 4;
  if (words == NULL || count < 5 || words[0] != SPIRV_MAGIC) {
    snprintf(error, error_size, "not a SPIR-V module");
    return false;
  }
  static Id ids[MAX_IDS];       /* static: 4096 ids is 600 KiB, and reflection is not re-entrant here */
  memset(ids, 0, sizeof(ids));
  /* Member names and offsets are decorations on the struct type, so they arrive before the struct is
     known to be the uniform block. Collected by (type, member) and resolved at the end. */
  static struct { uint32_t type, index, offset, type_id; bool has_offset; char name[RE_SPIRV_MAX_NAME]; }
    members[RE_SPIRV_MAX_MEMBERS * 4];
  size_t member_count = 0;

  for (size_t i = 5; i < count;) {
    uint32_t word = words[i];
    uint16_t op = (uint16_t)(word & 0xffffu);
    uint16_t length = (uint16_t)(word >> 16);
    if (length == 0 || i + length > count) break;
    const uint32_t *operands = &words[i + 1];
    uint32_t operand_count = length - 1u;

    switch (op) {
      case OpName:
        if (operand_count >= 2 && operands[0] < MAX_IDS)
          copy_string(&operands[1], operand_count - 1, ids[operands[0]].name, RE_SPIRV_MAX_NAME);
        break;
      case OpMemberName:
        if (operand_count >= 3 && member_count < sizeof(members) / sizeof(members[0])) {
          size_t slot = member_count;
          for (size_t m = 0; m < member_count; m++)
            if (members[m].type == operands[0] && members[m].index == operands[1]) { slot = m; break; }
          if (slot == member_count) {
            memset(&members[slot], 0, sizeof(members[slot]));
            members[slot].type = operands[0];
            members[slot].index = operands[1];
            member_count++;
          }
          copy_string(&operands[2], operand_count - 2, members[slot].name, RE_SPIRV_MAX_NAME);
        }
        break;
      case OpMemberDecorate:
        if (operand_count >= 4 && operands[2] == DecorationOffset) {
          size_t slot = member_count;
          for (size_t m = 0; m < member_count; m++)
            if (members[m].type == operands[0] && members[m].index == operands[1]) { slot = m; break; }
          if (slot == member_count && member_count < sizeof(members) / sizeof(members[0])) {
            memset(&members[slot], 0, sizeof(members[slot]));
            members[slot].type = operands[0];
            members[slot].index = operands[1];
            member_count++;
          }
          if (slot < member_count) {
            members[slot].offset = operands[3];
            members[slot].has_offset = true;
          }
        }
        break;
      case OpDecorate:
        if (operand_count >= 2 && operands[0] < MAX_IDS) {
          Id *id = &ids[operands[0]];
          if (operands[1] == DecorationBlock) id->is_block = true;
          else if (operands[1] == DecorationBinding && operand_count >= 3) {
            id->binding = operands[2];
            id->has_binding = true;
          } else if (operands[1] == DecorationDescriptorSet && operand_count >= 3) id->set = operands[2];
        }
        break;
      case OpTypeFloat:
      case OpTypeInt:
        if (operand_count >= 1 && operands[0] < MAX_IDS) ids[operands[0]].op = (uint8_t)op;
        break;
      case OpTypeVector:
      case OpTypeMatrix:
        if (operand_count >= 3 && operands[0] < MAX_IDS) {
          ids[operands[0]].op = (uint8_t)op;
          ids[operands[0]].a = operands[1];
          ids[operands[0]].b = operands[2];
        }
        break;
      case OpTypeStruct:
      case OpTypeImage:
      case OpTypeSampledImage:
        if (operand_count >= 1 && operands[0] < MAX_IDS) {
          ids[operands[0]].op = (uint8_t)op;
          if (op == OpTypeSampledImage && operand_count >= 2) ids[operands[0]].a = operands[1];
          /* A struct's member types are its remaining operands. They are kept because the LAST
             member's size cannot be derived from the gap to the next one — there is no next one —
             and guessing 16 there would size the block short for a trailing mat4. */
          if (op == OpTypeStruct)
            for (uint32_t m = 1; m < operand_count; m++)
              for (size_t s = 0; s < member_count; s++)
                if (members[s].type == operands[0] && members[s].index == m - 1)
                  members[s].type_id = operands[m];
        }
        break;
      case OpTypePointer:
        if (operand_count >= 3 && operands[0] < MAX_IDS) {
          ids[operands[0]].op = (uint8_t)op;
          ids[operands[0]].a = operands[1];   /* storage class */
          ids[operands[0]].b = operands[2];   /* pointee */
        }
        break;
      case OpVariable:
        if (operand_count >= 3 && operands[1] < MAX_IDS && operands[0] < MAX_IDS) {
          Id *variable = &ids[operands[1]];
          variable->op = (uint8_t)OpVariable;
          variable->a = operands[0];          /* pointer type */
          variable->b = operands[2];          /* storage class */
        }
        break;
      default: break;
    }
    i += length;
  }

  /* Second pass over the variables: one uniform block, and every sampler. */
  for (uint32_t v = 0; v < MAX_IDS; v++) {
    const Id *variable = &ids[v];
    if (variable->op != OpVariable || variable->a >= MAX_IDS) continue;
    const Id *pointer = &ids[variable->a];
    if (pointer->op != OpTypePointer || pointer->b >= MAX_IDS) continue;
    const Id *pointee = &ids[pointer->b];

    if (variable->b == StorageClassUniform && pointee->op == OpTypeStruct && pointee->is_block) {
      layout->block_binding = variable->has_binding ? variable->binding : 0;
      for (size_t m = 0; m < member_count; m++) {
        if (members[m].type != pointer->b || !members[m].has_offset) continue;
        if (layout->member_count >= RE_SPIRV_MAX_MEMBERS) break;
        /* A member already seen from the other stage is the same member: both stages declare the
           same block, and merging rather than duplicating is what lets a program be reflected from
           its two modules in turn. */
        bool seen = false;
        for (uint32_t k = 0; k < layout->member_count; k++)
          if (!strcmp(layout->members[k].name, members[m].name)) seen = true;
        if (seen) continue;
        ReSpirvMember *out = &layout->members[layout->member_count++];
        snprintf(out->name, sizeof(out->name), "%s", members[m].name);
        out->offset = members[m].offset;
        out->size = type_size(ids, members[m].type_id);
      }
    } else if (variable->b == StorageClassUniformConstant && pointee->op == OpTypeSampledImage) {
      bool seen = false;
      for (uint32_t k = 0; k < layout->sampler_count; k++)
        if (!strcmp(layout->samplers[k].name, variable->name)) seen = true;
      if (!seen && layout->sampler_count < RE_SPIRV_MAX_SAMPLERS && variable->has_binding) {
        ReSpirvSampler *out = &layout->samplers[layout->sampler_count++];
        snprintf(out->name, sizeof(out->name), "%s", variable->name);
        out->binding = variable->binding;
      }
    }
  }

  /* The block's size is the end of its last member. Sizes come from the gaps between offsets, which
     needs no type table at all and cannot disagree with what glslang actually laid out; the final
     member is the exception and takes its size from its type. */
  for (uint32_t m = 0; m < layout->member_count; m++) {
    if (layout->members[m].size == 0) {
      snprintf(error, error_size, "uniform '%s' has a type this reader does not size",
               layout->members[m].name);
      return false;
    }
    uint32_t end = layout->members[m].offset + layout->members[m].size;
    if (end > layout->block_size) layout->block_size = end;
  }
  return true;
}
