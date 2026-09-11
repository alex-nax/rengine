// One colour, no texture. The overlay band, and the only consumer of the third program.
// UNIFORMS
//   mat4 u_view_proj
//   mat4 u_model
//   vec4 u_tint
//   vec4 u_light
// END

#ifdef VERTEX
IN(0) vec3 a_position;
void main() { gl_Position = u_view_proj * u_model * vec4(a_position, 1.0); }
#else
OUT_COLOR
void main() { o_color = u_tint; }
#endif
