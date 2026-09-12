/* The seam, forwarded to the host's table (charter D55, spec 126).
 *
 * rEngine links three copies of the seam with their symbols prefixed, so `re_seam_draw` exists in
 * no copy under that name and a plugin cannot call it. The render extension hands the seam over as
 * a table of pointers with the seam's own signatures, which makes the bridge these twenty-nine
 * definitions: the pack's `scene.c` and `obj.c` compile **unmodified** and call straight through.
 *
 * That is what makes F136's third criterion true by construction rather than by discipline — the
 * scene the tab renders and the scene the backend comparison judges are the same source file, not
 * two that have to be kept in step.
 *
 * `seam` is the desktop's, opaque here; it arrives from the table and goes back to it untouched.
 */
#include "plugin_render.h"

/* Set once per frame, before any scene call. A plugin is single-threaded on the desktop's thread
   and its draw callback is the only thing that reaches these, so a file-scope table is honest. */
static const RePluginRender *seam_table;
void re_scene_plugin_bind(const RePluginRender *table);
void re_scene_plugin_bind(const RePluginRender *table) { seam_table = table; }

void re_seam_blend(ReSeam *s, ReSeamBlend b) { seam_table->blend(s, b); }
ReSeamBuffer re_seam_buffer(ReSeam *s) { return seam_table->buffer(s); }
void re_seam_buffer_destroy(ReSeam *s, ReSeamBuffer *b) { seam_table->buffer_destroy(s, b); }
void re_seam_buffer_update(ReSeam *s, ReSeamBuffer b, const void *data, size_t bytes, ReSeamBufferUsage u) {
  seam_table->buffer_update(s, b, data, bytes, u);
}
void re_seam_clear(ReSeam *s, float r, float g, float b, float a, bool depth) { seam_table->clear(s, r, g, b, a, depth); }
void re_seam_cull(ReSeam *s, ReSeamCull c) { seam_table->cull(s, c); }
void re_seam_depth(ReSeam *s, ReSeamDepthTest t, ReSeamDepthWrite w) { seam_table->depth(s, t, w); }
void re_seam_depth_compare(ReSeam *s, ReSeamDepthCompare c) { seam_table->depth_compare(s, c); }
void re_seam_draw(ReSeam *s, ReSeamPrimitive p, int first, int count) { seam_table->draw(s, p, first, count); }
void re_seam_frame_begin(ReSeam *s, ReSeamTarget t) { seam_table->frame_begin(s, t); }
void re_seam_frame_end(ReSeam *s) { seam_table->frame_end(s); }
ReSeamProgram re_seam_program(ReSeam *s, const ReSeamShader *v, const ReSeamShader *f, const char *name) {
  return seam_table->program(s, v, f, name);
}
void re_seam_program_destroy(ReSeam *s, ReSeamProgram *p) { seam_table->program_destroy(s, p); }
void re_seam_program_use(ReSeam *s, ReSeamProgram p) { seam_table->program_use(s, p); }
ReSeamTarget re_seam_target(ReSeam *s, ReSeamTexture c, ReSeamTexture d) { return seam_table->target_make(s, c, d); }
void re_seam_target_bind(ReSeam *s, ReSeamTarget t) { seam_table->target_bind(s, t); }
void re_seam_target_destroy(ReSeam *s, ReSeamTarget *t) { seam_table->target_destroy(s, t); }
ReSeamTexture re_seam_texture_2d(ReSeam *s, const void *rgba, int w, int h, ReSeamFilter f, ReSeamWrap wr) {
  return seam_table->texture_2d(s, rgba, w, h, f, wr);
}
ReSeamTexture re_seam_texture_2d_for(ReSeam *s, const void *rgba, int w, int h, ReSeamFilter f, ReSeamWrap wr, ReSeamTextureUse u) {
  return seam_table->texture_2d_for(s, rgba, w, h, f, wr, u);
}
void re_seam_texture_bind(ReSeam *s, ReSeamTexture t, int unit) { seam_table->texture_bind(s, t, unit); }
void re_seam_texture_destroy(ReSeam *s, ReSeamTexture *t) { seam_table->texture_destroy(s, t); }
void re_seam_uniform_int(ReSeam *s, int location, int value) { seam_table->uniform_int(s, location, value); }
int re_seam_uniform_location(ReSeam *s, ReSeamProgram p, const char *name) { return seam_table->uniform_location(s, p, name); }
void re_seam_uniform_mat4(ReSeam *s, int location, const float *value) { seam_table->uniform_mat4(s, location, value); }
void re_seam_uniform_vec2(ReSeam *s, int location, float x, float y) { seam_table->uniform_vec2(s, location, x, y); }
void re_seam_uniform_vec4(ReSeam *s, int location, float x, float y, float z, float w) {
  seam_table->uniform_vec4(s, location, x, y, z, w);
}
ReSeamVertexArray re_seam_vertex_array(ReSeam *s, ReSeamBuffer b, const ReSeamVertexLayout *l) {
  return seam_table->vertex_array(s, b, l);
}
void re_seam_vertex_array_bind(ReSeam *s, ReSeamVertexArray a) { seam_table->vertex_array_bind(s, a); }
void re_seam_vertex_array_destroy(ReSeam *s, ReSeamVertexArray *a) { seam_table->vertex_array_destroy(s, a); }
void re_seam_viewport(ReSeam *s, int x, int y, int w, int h) { seam_table->viewport(s, x, y, w, h); }
