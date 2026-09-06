#version 450
// Draw-list vertex shader for the Vulkan adapter (spec 073). Same attributes as backend_metal.m;
// the drawable size arrives as a push constant and NDC is emitted y-down as Vulkan expects.
layout(location = 0) in vec4 in_shape;
layout(location = 1) in vec4 in_radii;
layout(location = 2) in vec2 in_pos;
layout(location = 3) in vec2 in_uv;
layout(location = 4) in vec2 in_extra;
layout(location = 5) in vec4 in_color;
layout(push_constant) uniform Push { vec2 size; } push;
layout(location = 0) out vec2 v_pos;
layout(location = 1) out vec2 v_uv;
layout(location = 2) out vec4 v_color;
layout(location = 3) flat out vec4 v_shape;
layout(location = 4) flat out vec4 v_radii;
layout(location = 5) flat out vec2 v_extra;
void main() {
  v_pos = in_pos; v_uv = in_uv; v_color = in_color; v_shape = in_shape; v_radii = in_radii; v_extra = in_extra;
  gl_Position = vec4(in_pos.x / push.size.x * 2.0 - 1.0, in_pos.y / push.size.y * 2.0 - 1.0, 0.0, 1.0);
}
