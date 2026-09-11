/* The small amount of linear algebra a scene needs, in C (spec 124).
 *
 * vtmb-vr uses glm and rEngine's desktop needs none of this. An example that pulled in a C++ matrix
 * library to draw a box would make "builds from the pack alone" mean "builds from the pack and glm",
 * which is the opposite of what it is here to demonstrate. Column-major, like the GLSL it feeds.
 */
#ifndef RE_SCENE_MATH_H
#define RE_SCENE_MATH_H

#include <math.h>

typedef struct { float x, y, z; } Vec3;
typedef struct { float m[16]; } Mat4;

static inline Vec3 vec3(float x, float y, float z) { Vec3 v = {x, y, z}; return v; }
static inline Vec3 vec3_sub(Vec3 a, Vec3 b) { return vec3(a.x - b.x, a.y - b.y, a.z - b.z); }
static inline Vec3 vec3_cross(Vec3 a, Vec3 b) {
  return vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
static inline float vec3_dot(Vec3 a, Vec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
static inline Vec3 vec3_scale(Vec3 a, float s) { return vec3(a.x * s, a.y * s, a.z * s); }
static inline Vec3 vec3_normalize(Vec3 a) {
  float length = sqrtf(vec3_dot(a, a));
  return length > 0.0f ? vec3_scale(a, 1.0f / length) : a;
}

static inline Mat4 mat4_identity(void) {
  Mat4 r = {{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}};
  return r;
}

static inline Mat4 mat4_multiply(Mat4 a, Mat4 b) {
  Mat4 r;
  for (int c = 0; c < 4; c++)
    for (int row = 0; row < 4; row++) {
      float sum = 0.0f;
      for (int k = 0; k < 4; k++) sum += a.m[k * 4 + row] * b.m[c * 4 + k];
      r.m[c * 4 + row] = sum;
    }
  return r;
}

static inline Mat4 mat4_translate(float x, float y, float z) {
  Mat4 r = mat4_identity();
  r.m[12] = x; r.m[13] = y; r.m[14] = z;
  return r;
}

static inline Mat4 mat4_scale(float x, float y, float z) {
  Mat4 r = mat4_identity();
  r.m[0] = x; r.m[5] = y; r.m[10] = z;
  return r;
}

static inline Mat4 mat4_rotate_y(float radians) {
  Mat4 r = mat4_identity();
  float c = cosf(radians), s = sinf(radians);
  r.m[0] = c; r.m[2] = -s; r.m[8] = s; r.m[10] = c;
  return r;
}

static inline Mat4 mat4_rotate_x(float radians) {
  Mat4 r = mat4_identity();
  float c = cosf(radians), s = sinf(radians);
  r.m[5] = c; r.m[6] = s; r.m[9] = -s; r.m[10] = c;
  return r;
}

/* Right-handed, depth in [-1, 1] — what OpenGL expects and what SPIRV-Cross's Vulkan output is
 * corrected for by the backend rather than by every call site. */
static inline Mat4 mat4_perspective(float fov_y_radians, float aspect, float near_z, float far_z) {
  Mat4 r = {{0}};
  float f = 1.0f / tanf(fov_y_radians * 0.5f);
  r.m[0] = f / aspect;
  r.m[5] = f;
  r.m[10] = (far_z + near_z) / (near_z - far_z);
  r.m[11] = -1.0f;
  r.m[14] = (2.0f * far_z * near_z) / (near_z - far_z);
  return r;
}

static inline Mat4 mat4_look_at(Vec3 eye, Vec3 centre, Vec3 up) {
  Vec3 f = vec3_normalize(vec3_sub(centre, eye));
  Vec3 s = vec3_normalize(vec3_cross(f, up));
  Vec3 u = vec3_cross(s, f);
  Mat4 r = mat4_identity();
  r.m[0] = s.x; r.m[4] = s.y; r.m[8] = s.z;
  r.m[1] = u.x; r.m[5] = u.y; r.m[9] = u.z;
  r.m[2] = -f.x; r.m[6] = -f.y; r.m[10] = -f.z;
  r.m[12] = -vec3_dot(s, eye);
  r.m[13] = -vec3_dot(u, eye);
  r.m[14] = vec3_dot(f, eye);
  return r;
}

#endif
