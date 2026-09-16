/* The seam as a table of pointers, compiled once per graphics API (charter D55/D56, spec 126).
 *
 * Every name below is the pack's unprefixed one; the force-included rename header turns it into
 * this copy's, so the table a plugin receives calls the same backend the window renders with. That
 * is the whole trick, and it is why this file has no #ifdef in it and does not know which API it is.
 */
#include "plugin_render.h"
#include "render/backend_seam.h"

const struct RePluginRender *re_backend_seam_plugin_table(void) {
  /* Static, and filled once: the members are compile-time constants after the rename. `size`, the
     host-side `seam`, `target` and `draw_target` are the host's to set per frame -- this file owns
     only the half that is the seam itself. */
  static struct RePluginRender table = {
    .size = sizeof(struct RePluginRender),
    .blend = re_seam_blend,
    .buffer = re_seam_buffer,
    .buffer_destroy = re_seam_buffer_destroy,
    .buffer_update = re_seam_buffer_update,
    .clear = re_seam_clear,
    .cull = re_seam_cull,
    .depth = re_seam_depth,
    .depth_compare = re_seam_depth_compare,
    .draw = re_seam_draw,
    .frame_begin = re_seam_frame_begin,
    .frame_end = re_seam_frame_end,
    .program = re_seam_program,
    .program_destroy = re_seam_program_destroy,
    .program_use = re_seam_program_use,
    .target_make = re_seam_target,
    .target_bind = re_seam_target_bind,
    .target_destroy = re_seam_target_destroy,
    .texture_2d = re_seam_texture_2d,
    .texture_2d_for = re_seam_texture_2d_for,
    .texture_bind = re_seam_texture_bind,
    .texture_destroy = re_seam_texture_destroy,
    .uniform_int = re_seam_uniform_int,
    .uniform_location = re_seam_uniform_location,
    .uniform_mat4 = re_seam_uniform_mat4,
    .uniform_vec2 = re_seam_uniform_vec2,
    .uniform_vec4 = re_seam_uniform_vec4,
    .vertex_array = re_seam_vertex_array,
    .vertex_array_bind = re_seam_vertex_array_bind,
    .vertex_array_destroy = re_seam_vertex_array_destroy,
    .viewport = re_seam_viewport,
  };
  return &table;
}
