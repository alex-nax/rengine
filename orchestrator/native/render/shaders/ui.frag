#version 450
// Draw-list fragment shader for the Vulkan adapter (spec 073): the OpenGL adapter's program line
// for line (backend_gl.c sidecar entry sdf-shapes). Modes: 0 solid, 1 rounded fill, 2 ring,
// 3 shadow, 4 coverage atlas, 5 RGBA texture.
layout(location = 0) in vec2 v_pos;
layout(location = 1) in vec2 v_uv;
layout(location = 2) in vec4 v_color;
layout(location = 3) flat in vec4 v_shape;
layout(location = 4) flat in vec4 v_radii;
layout(location = 5) flat in vec2 v_extra;
layout(set = 0, binding = 0) uniform sampler2D u_texture;
layout(location = 0) out vec4 o_color;
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
