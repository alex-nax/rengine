// The draw list's one shader, in one source (spec 124, F133).
//
// It used to exist three times: inline GLSL in backend_gl.c, this directory's ui.vert/ui.frag for
// the Vulkan adapter, and inline MSL in backend_metal.m. The signed-distance maths agreed, because
// someone kept it agreeing; the INTERFACES did not — the Vulkan copy numbered its attributes
// shape, radii, pos, uv, extra, color while the OpenGL copy numbered them pos, uv, color, shape,
// radii, extra, and the two emitted opposite Y. Three dialects of one shader is a drift risk; three
// dialects that already disagreed about their own vertex layout is the drift.
//
// One layout now, and one Y. The seam's backends store NDC -1 in row 0 on every API (see the long
// note in gpu_seam_vk.c), so the OpenGL formula is the formula everywhere: logical y counts down
// from the top of the window, and 1.0 - y/h*2 puts it where every backend agrees it goes.
//
// Modes: 0 solid, 1 rounded fill, 2 ring, 3 shadow, 4 coverage atlas, 5 RGBA texture.

// UNIFORMS
//   vec4 u_size
//   sampler2D u_texture
// END

#ifdef VERTEX
IN(0) vec2 a_pos;
IN(1) vec2 a_uv;
IN(2) vec4 a_color;
IN(3) vec4 a_shape;
IN(4) vec4 a_radii;
IN(5) vec2 a_extra;
OUT(0) vec2 v_pos;
OUT(1) vec2 v_uv;
OUT(2) vec4 v_color;
FLAT_OUT(3) vec4 v_shape;
FLAT_OUT(4) vec4 v_radii;
FLAT_OUT(5) vec2 v_extra;
void main() {
  v_pos = a_pos; v_uv = a_uv; v_color = a_color;
  v_shape = a_shape; v_radii = a_radii; v_extra = a_extra;
  gl_Position = vec4(a_pos.x / u_size.x * 2.0 - 1.0, 1.0 - a_pos.y / u_size.y * 2.0, 0.0, 1.0);
}
#else
IN_F(0) vec2 v_pos;
IN_F(1) vec2 v_uv;
IN_F(2) vec4 v_color;
FLAT_IN(3) vec4 v_shape;
FLAT_IN(4) vec4 v_radii;
FLAT_IN(5) vec2 v_extra;
OUT_COLOR
float box(vec2 p, vec2 h, float r) { vec2 q = abs(p) - (h - vec2(r)); return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float corner(vec2 p) { return p.x < 0.0 ? (p.y < 0.0 ? v_radii.x : v_radii.w) : (p.y < 0.0 ? v_radii.y : v_radii.z); }
void main() {
  int mode = int(v_extra.y + 0.5); vec4 c = v_color; vec2 p = v_pos - v_shape.xy; vec2 h = v_shape.zw; float w = v_extra.x;
  if (mode == 1) { c.a *= clamp(0.5 - box(p, h, corner(p)), 0.0, 1.0); }
  else if (mode == 2) { float r = corner(p); float o = clamp(0.5 - box(p, h, r), 0.0, 1.0);
    float i = clamp(0.5 - box(p, h - vec2(w), max(r - w, 0.0)), 0.0, 1.0); c.a *= o * (1.0 - i); }
  else if (mode == 3) { c.a *= 1.0 - smoothstep(0.0, w, box(p, h, corner(p))); }
  else if (mode == 4) { c.a *= texture(u_texture, v_uv).r; }
  else if (mode == 5) { c *= texture(u_texture, v_uv); }
  if (c.a <= 0.0) discard;
  o_color = c;
}
#endif
