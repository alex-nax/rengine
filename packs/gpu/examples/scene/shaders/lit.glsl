// The lit pass: a textured surface with one directional light. Used by the floor, the pillars, the
// spinning boxes and the backdrop, which is where the per-draw uniform traffic comes from.
// UNIFORMS
//   mat4 u_view_proj
//   mat4 u_model
//   vec4 u_tint
//   vec4 u_light
//   sampler2D u_texture
// END

#ifdef VERTEX
IN(0) vec3 a_position;
IN(1) vec3 a_normal;
IN(2) vec2 a_uv;
IN(3) vec4 a_color;
OUT(0) vec3 v_normal;
OUT(1) vec2 v_uv;
OUT(2) vec4 v_color;
void main() {
  v_normal = mat3(u_model) * a_normal;
  v_uv = a_uv;
  v_color = a_color;
  gl_Position = u_view_proj * u_model * vec4(a_position, 1.0);
}
#else
IN_F(0) vec3 v_normal;
IN_F(1) vec2 v_uv;
IN_F(2) vec4 v_color;
OUT_COLOR
void main() {
  float lambert = max(dot(normalize(v_normal), normalize(u_light.xyz)), 0.0);
  vec4 albedo = texture(u_texture, v_uv) * u_tint * v_color;
  o_color = vec4(albedo.rgb * (0.35 + 0.65 * lambert), u_tint.a);
}
#endif
