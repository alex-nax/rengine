// The off-screen pass, shown in a corner. Already in clip space, so it needs no matrices — and it is
// the only user of a vec2 uniform, which makes it the only place a backend that dropped that form
// would be caught.
// UNIFORMS
//   mat4 u_view_proj
//   mat4 u_model
//   vec4 u_tint
//   vec4 u_light
//   vec2 u_extent
//   sampler2D u_texture
// END

#ifdef VERTEX
IN(0) vec3 a_position;
IN(2) vec2 a_uv;
OUT(1) vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_position.xy * u_extent + vec2(1.0 - u_extent.x, 1.0 - u_extent.y), 0.0, 1.0);
}
#else
IN_F(1) vec2 v_uv;
OUT_COLOR
void main() { o_color = texture(u_texture, v_uv); }
#endif
