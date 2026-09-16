/* The plugin render extension, ABI 2 (charter D55, spec 126 decisions 2, 6 and 9).
 *
 * D55 grants a plugin a render target "requested by size each frame and returned as a handle good
 * for that frame only". This header is how it renders into one, and the shape needs saying because
 * it is not the obvious one.
 *
 * rEngine links THREE copies of the seam with their symbols prefixed, so `--renderer` stays a
 * runtime switch (charter D56). A plugin module therefore cannot call `re_seam_draw` at all: that
 * symbol exists in no copy, and the ABI promises a module with no undefined references. So the seam
 * arrives the only way it can — by pointer. Every member below has the signature of the seam
 * function it stands for, which means a rendering plugin can define the pack's own `re_seam_*`
 * names as one-line forwarders and then compile the pack's sources **unmodified**. That is why
 * F136's scene tab and the pack's standalone example can be the same code rather than two copies
 * that drift; see plugins/scene/seam_forward.c for the twenty-nine lines it takes.
 *
 * `seam` is the desktop's own, valid for this frame only. A plugin passes it back to the calls here
 * and never dereferences it — it is a different struct in each copy, and which copy this is is not
 * the plugin's business.
 *
 * Nothing here widens D38 beyond D55: no keyboard, no controls, no store, no session, no host
 * state. A target is asked for by size and belongs to the host, so a renderer change between frames
 * leaves the plugin holding nothing.
 */
#ifndef RENGINE_PLUGIN_RENDER_H
#define RENGINE_PLUGIN_RENDER_H
#include "plugin_abi.h"
#include "rengine/gpu_seam.h"

struct RePluginRender {
  uint32_t size;                    /* sizeof(struct RePluginRender): read members within it only */
  ReSeam *seam;                     /* the desktop's seam, this frame only; never dereferenced here */
  /* An off-screen colour+depth target of this size, owned by the host and good for this frame. The
   * same call in a later frame with the same size gives the same one back rather than a new one,
   * because a target per frame would reallocate a depth buffer sixty times a second; what D55's
   * "good for that frame only" forbids is the PLUGIN keeping it, and `draw_target` is the only way
   * to use it, so a stale handle cannot be presented. False when the host could not make it. */
  bool (*target)(RePluginFrame *frame, int width, int height, ReSeamTarget *out);
  /* Composite this frame's target into the tab, through the same TEXTURE command the game view
   * uses. Refused when no target was asked for this frame. */
  bool (*draw_target)(RePluginFrame *frame, ReRect rect, uint8_t flags);

  /* ---- the seam, by pointer. One member per call, with the seam's own signature. ------------- */
  void (*blend)(ReSeam *seam, ReSeamBlend blend);
  ReSeamBuffer (*buffer)(ReSeam *seam);
  void (*buffer_destroy)(ReSeam *seam, ReSeamBuffer *buffer);
  void (*buffer_update)(ReSeam *seam, ReSeamBuffer buffer, const void *data, size_t bytes, ReSeamBufferUsage usage);
  void (*clear)(ReSeam *seam, float r, float g, float b, float a, bool depth);
  void (*cull)(ReSeam *seam, ReSeamCull cull);
  void (*depth)(ReSeam *seam, ReSeamDepthTest test, ReSeamDepthWrite write);
  void (*depth_compare)(ReSeam *seam, ReSeamDepthCompare compare);
  void (*draw)(ReSeam *seam, ReSeamPrimitive primitive, int first, int count);
  void (*frame_begin)(ReSeam *seam, ReSeamTarget target);
  void (*frame_end)(ReSeam *seam);
  ReSeamProgram (*program)(ReSeam *seam, const ReSeamShader *vertex, const ReSeamShader *fragment, const char *debug_name);
  void (*program_destroy)(ReSeam *seam, ReSeamProgram *program);
  void (*program_use)(ReSeam *seam, ReSeamProgram program);
  ReSeamTarget (*target_make)(ReSeam *seam, ReSeamTexture color, ReSeamTexture depth);
  void (*target_bind)(ReSeam *seam, ReSeamTarget target);
  void (*target_destroy)(ReSeam *seam, ReSeamTarget *target);
  ReSeamTexture (*texture_2d)(ReSeam *seam, const void *rgba, int width, int height, ReSeamFilter filter, ReSeamWrap wrap);
  ReSeamTexture (*texture_2d_for)(ReSeam *seam, const void *rgba, int width, int height, ReSeamFilter filter, ReSeamWrap wrap, ReSeamTextureUse use);
  void (*texture_bind)(ReSeam *seam, ReSeamTexture texture, int unit);
  void (*texture_destroy)(ReSeam *seam, ReSeamTexture *texture);
  void (*uniform_int)(ReSeam *seam, int location, int value);
  int (*uniform_location)(ReSeam *seam, ReSeamProgram program, const char *name);
  void (*uniform_mat4)(ReSeam *seam, int location, const float *value);
  void (*uniform_vec2)(ReSeam *seam, int location, float x, float y);
  void (*uniform_vec4)(ReSeam *seam, int location, float x, float y, float z, float w);
  ReSeamVertexArray (*vertex_array)(ReSeam *seam, ReSeamBuffer buffer, const ReSeamVertexLayout *layout);
  void (*vertex_array_bind)(ReSeam *seam, ReSeamVertexArray array);
  void (*vertex_array_destroy)(ReSeam *seam, ReSeamVertexArray *array);
  void (*viewport)(ReSeam *seam, int x, int y, int width, int height);
};
#endif
