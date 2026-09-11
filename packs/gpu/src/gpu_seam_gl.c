/* The seam's OpenGL backend, serving desktop GL 4.1 and GLES 3.2 from one implementation.
 *
 * Ported from vtmb-vr's `src/renderer/gpu/device_gl.cpp`, which is the proven version of this code;
 * the differences are deliberate and each one is marked GENERALISED below. Backend selection is
 * compile-time (D14b/D51), so exactly one of these files is compiled into a binary and no call in
 * here is reached through a pointer the frame path has to chase.
 *
 * GENERALISED, 1: entry points come from the host's loader rather than from a linked GL. The pack
 * links no graphics library, which is what lets a consumer keep the loader it already has — vtmb-vr
 * links glad, and two glad implementations in one binary is a symbol clash, not a dependency.
 *
 * GENERALISED, 2: no dialect prefix is injected before compiling a stage. VtMB's backend prepends
 * `glslPrefixFor(source)`, which is empty for a shader its F800 step cross-compiled (those carry
 * their own #version) and a version line for one embedded verbatim. A library cannot know a
 * consumer's preamble convention, and the shader descriptor exists precisely so the build hands over
 * a complete stage. A consumer whose shaders do not carry #version prepends it in its generator.
 *
 * GENERALISED, 3: diagnostics are handed back through the caller's callback instead of a logger the
 * library picked.
 */
#include "rengine/gpu_seam.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* GL types, spelled out rather than included: this file must compile on a machine with no GL headers
 * at all, which is the same reason the device layer declares VK_NO_PROTOTYPES. */
typedef unsigned int GLenum;
typedef unsigned char GLboolean;
typedef unsigned int GLbitfield;
typedef int GLint;
typedef unsigned int GLuint;
typedef int GLsizei;
typedef float GLfloat;
typedef char GLchar;
typedef unsigned char GLubyte_t;
typedef ptrdiff_t GLsizeiptr;

#define GL_FALSE 0
#define GL_TRUE 1
#define GL_TRIANGLES 0x0004
#define GL_LINES 0x0001
#define GL_DEPTH_BUFFER_BIT 0x00000100
#define GL_COLOR_BUFFER_BIT 0x00004000
#define GL_CULL_FACE 0x0B44
#define GL_DEPTH_TEST 0x0B71
#define GL_BLEND 0x0BE2
#define GL_BACK 0x0405
#define GL_TEXTURE_2D 0x0DE1
#define GL_UNSIGNED_BYTE 0x1401
#define GL_TRUE_BYTE 1
#define GL_FLOAT 0x1406
#define GL_RGBA 0x1908
#define GL_VERSION 0x1F02
#define GL_NEAREST 0x2600
#define GL_LINEAR 0x2601
#define GL_TEXTURE_MAG_FILTER 0x2800
#define GL_TEXTURE_MIN_FILTER 0x2801
#define GL_TEXTURE_WRAP_S 0x2802
#define GL_TEXTURE_WRAP_T 0x2803
#define GL_REPEAT 0x2901
#define GL_CLAMP_TO_EDGE 0x812F
#define GL_UNPACK_ALIGNMENT 0x0CF5
#define GL_SRC_ALPHA 0x0302
#define GL_ONE_MINUS_SRC_ALPHA 0x0303
#define GL_ONE 1
#define GL_ARRAY_BUFFER 0x8892
#define GL_STATIC_DRAW 0x88E4
#define GL_DYNAMIC_DRAW 0x88E8
#define GL_FRAGMENT_SHADER 0x8B30
#define GL_VERTEX_SHADER 0x8B31
#define GL_COMPILE_STATUS 0x8B81
#define GL_LINK_STATUS 0x8B82
#define GL_TEXTURE0 0x84C0
#define GL_SCISSOR_TEST 0x0C11
#define GL_FRAMEBUFFER 0x8D40
#define GL_COLOR_ATTACHMENT0 0x8CE0
#define GL_DEPTH_ATTACHMENT 0x8D00
#define GL_FRAMEBUFFER_COMPLETE 0x8CD5
#define GL_DEPTH_COMPONENT 0x1902
#define GL_DEPTH_COMPONENT24 0x81A6
#define GL_RED 0x1903
#define GL_R8 0x8229
#define GL_TEXTURE_INTERNAL_FORMAT 0x1003
#define GL_UNSIGNED_INT 0x1405
#define GL_NEVER 0x0200
#define GL_LESS 0x0201
#define GL_EQUAL 0x0202
#define GL_LEQUAL 0x0203
#define GL_ALWAYS 0x0207

/* Every entry point this backend uses, in one list: the table, the loader and the "which one is
 * missing" message are all generated from it, so adding a GL call cannot silently skip its load. */
#define RE_SEAM_GL_FUNCTIONS(X)                                                                     \
  X(GLuint, glCreateShader, (GLenum type))                                                          \
  X(void, glShaderSource, (GLuint shader, GLsizei count, const GLchar *const *string, const GLint *length)) \
  X(void, glCompileShader, (GLuint shader))                                                         \
  X(void, glGetShaderiv, (GLuint shader, GLenum pname, GLint *params))                              \
  X(void, glGetShaderInfoLog, (GLuint shader, GLsizei size, GLsizei *length, GLchar *log))          \
  X(void, glDeleteShader, (GLuint shader))                                                          \
  X(GLuint, glCreateProgram, (void))                                                                \
  X(void, glAttachShader, (GLuint program, GLuint shader))                                          \
  X(void, glLinkProgram, (GLuint program))                                                          \
  X(void, glGetProgramiv, (GLuint program, GLenum pname, GLint *params))                            \
  X(void, glGetProgramInfoLog, (GLuint program, GLsizei size, GLsizei *length, GLchar *log))         \
  X(void, glDeleteProgram, (GLuint program))                                                        \
  X(void, glUseProgram, (GLuint program))                                                           \
  X(GLint, glGetUniformLocation, (GLuint program, const GLchar *name))                              \
  X(void, glUniform1i, (GLint location, GLint v0))                                                  \
  X(void, glUniform1f, (GLint location, GLfloat v0))                                                \
  X(void, glUniform4f, (GLint location, GLfloat x, GLfloat y, GLfloat z, GLfloat w))                \
  X(void, glUniformMatrix4fv, (GLint location, GLsizei count, GLboolean transpose, const GLfloat *value)) \
  X(void, glGenBuffers, (GLsizei n, GLuint *buffers))                                               \
  X(void, glDeleteBuffers, (GLsizei n, const GLuint *buffers))                                      \
  X(void, glBindBuffer, (GLenum target, GLuint buffer))                                             \
  X(void, glBufferData, (GLenum target, GLsizeiptr size, const void *data, GLenum usage))           \
  X(void, glGenVertexArrays, (GLsizei n, GLuint *arrays))                                           \
  X(void, glDeleteVertexArrays, (GLsizei n, const GLuint *arrays))                                  \
  X(void, glBindVertexArray, (GLuint array))                                                        \
  X(void, glVertexAttribPointer, (GLuint index, GLint size, GLenum type, GLboolean normalized, GLsizei stride, const void *pointer)) \
  X(void, glEnableVertexAttribArray, (GLuint index))                                                \
  X(void, glGenTextures, (GLsizei n, GLuint *textures))                                             \
  X(void, glDeleteTextures, (GLsizei n, const GLuint *textures))                                    \
  X(void, glBindTexture, (GLenum target, GLuint texture))                                           \
  X(void, glTexParameteri, (GLenum target, GLenum pname, GLint param))                              \
  X(void, glGetTexLevelParameteriv, (GLenum target, GLint level, GLenum pname, GLint *params))      \
  X(void, glPixelStorei, (GLenum pname, GLint param))                                               \
  X(void, glTexImage2D, (GLenum target, GLint level, GLint internal, GLsizei width, GLsizei height, GLint border, GLenum format, GLenum type, const void *pixels)) \
  X(void, glActiveTexture, (GLenum texture))                                                        \
  X(void, glEnable, (GLenum cap))                                                                   \
  X(void, glDisable, (GLenum cap))                                                                  \
  X(void, glBlendFunc, (GLenum src, GLenum dst))                                                    \
  X(void, glDepthMask, (GLboolean flag))                                                            \
  X(void, glCullFace, (GLenum mode))                                                                \
  X(void, glViewport, (GLint x, GLint y, GLsizei width, GLsizei height))                            \
  X(void, glClearColor, (GLfloat r, GLfloat g, GLfloat b, GLfloat a))                               \
  X(void, glClear, (GLbitfield mask))                                                               \
  X(void, glDrawArrays, (GLenum mode, GLint first, GLsizei count))                                  \
  X(void, glScissor, (GLint x, GLint y, GLsizei width, GLsizei height))                             \
  X(void, glBlendFuncSeparate, (GLenum srcRGB, GLenum dstRGB, GLenum srcA, GLenum dstA))            \
  X(void, glDepthFunc, (GLenum func))                                                               \
  X(void, glUniform2f, (GLint location, GLfloat v0, GLfloat v1))                                    \
  X(void, glTexSubImage2D, (GLenum target, GLint level, GLint x, GLint y, GLsizei width, GLsizei height, GLenum format, GLenum type, const void *pixels)) \
  X(void, glGenFramebuffers, (GLsizei n, GLuint *framebuffers))                                     \
  X(void, glDeleteFramebuffers, (GLsizei n, const GLuint *framebuffers))                            \
  X(void, glBindFramebuffer, (GLenum target, GLuint framebuffer))                                   \
  X(void, glFramebufferTexture2D, (GLenum target, GLenum attachment, GLenum textarget, GLuint texture, GLint level)) \
  X(GLenum, glCheckFramebufferStatus, (GLenum target))                                              \
  X(void, glFlush, (void))                                                                          \
  X(const GLubyte_t *, glGetString, (GLenum name))

struct ReSeam {
  ReSeamCounters counters;
#define RE_SEAM_GL_MEMBER(ret, name, args) ret(*name) args;
  RE_SEAM_GL_FUNCTIONS(RE_SEAM_GL_MEMBER)
#undef RE_SEAM_GL_MEMBER
  ReSeamOnMessage on_message;
  void *message_user;
  bool in_frame;
  bool es;                /* the context reported an OpenGL ES version, so ES dialects are preferred */
  ReSeamTarget frame_target;
  ReSeamTarget bound;   /* whose height turns a top-left rectangle into a bottom-left one */
};

/* The current seam is per thread because a graphics context is: two render threads with two contexts
 * must not see each other's. `_Thread_local` is C11, which this pack already requires. */
static _Thread_local ReSeam *current;

static bool say(char *error, size_t size, const char *format, ...) {
  if (error != NULL && size > 0) {
    va_list args;
    va_start(args, format);
    vsnprintf(error, size, format, args);
    va_end(args);
  }
  return false;
}

static void report(ReSeam *seam, const char *format, ...) {
  if (seam == NULL || seam->on_message == NULL) return;
  char message[1024];
  va_list args;
  va_start(args, format);
  vsnprintf(message, sizeof(message), format, args);
  va_end(args);
  seam->on_message(seam->message_user, message);
}

ReSeam *re_seam_open(const ReSeamOpen *options, char *error, size_t error_size) {
  if (options == NULL || options->get_proc == NULL) {
    say(error, error_size, "re_seam_open needs the host's glGetProcAddress: the pack links no GL");
    return NULL;
  }
  ReSeam *seam = calloc(1, sizeof(*seam));
  if (seam == NULL) {
    say(error, error_size, "out of memory");
    return NULL;
  }
  seam->on_message = options->on_message;
  seam->message_user = options->message_user;
#define RE_SEAM_GL_LOAD(ret, name, args)                                                            \
  seam->name = (ret(*) args)options->get_proc(options->user, #name);                                \
  if (seam->name == NULL) {                                                                         \
    say(error, error_size, "the host's loader has no %s", #name);                                    \
    free(seam);                                                                                      \
    return NULL;                                                                                     \
  }
  RE_SEAM_GL_FUNCTIONS(RE_SEAM_GL_LOAD)
#undef RE_SEAM_GL_LOAD
  /* Which GL this is, asked once. An ES context's GL_VERSION begins "OpenGL ES"; a desktop one does
     not. It decides which shader dialect every later compile takes (charter D59). */
  const GLubyte_t *version = seam->glGetString(GL_VERSION);
  seam->es = version != NULL && strncmp((const char *)version, "OpenGL ES", 9) == 0;
  return seam;
}

void re_seam_close(ReSeam *seam) {
  if (seam == NULL) return;
  if (current == seam) current = NULL;
  free(seam);
}

void re_seam_make_current(ReSeam *seam) { current = seam; }
ReSeam *re_seam_current(void) { return current; }

const char *re_seam_backend(void) { return "opengl"; }

/* ---- programs --------------------------------------------------------------------------------- */

static GLuint compile(ReSeam *seam, GLenum type, const ReSeamShader *stage, const char *debug_name) {
  /* `#version 330 core` and `#version 320 es` are different languages, and only this backend knows
     which context it opened — so the choice is made here rather than by the caller (charter D59). A
     desktop consumer sets glsl alone and meets exactly the behaviour it always had. */
  const char *source = stage == NULL ? NULL
                     : (seam->es && stage->glsl_es != NULL) ? stage->glsl_es : stage->glsl;
  if (source == NULL) {
    /* Naming the build step is the whole point: a consumer that switched its generator to emit only
       SPIR-V would otherwise meet an empty-source compile error from the driver. */
    report(seam, "gpu: %s has no %s for this stage — the OpenGL backend needs ReSeamShader.%s, "
                 "which the shader generator emits alongside SPIR-V", debug_name,
           seam->es ? "GLSL ES" : "GLSL", seam->es ? "glsl_es" : "glsl");
    return 0;
  }
  const GLchar *sources[1] = {source};
  GLuint shader = seam->glCreateShader(type);
  seam->glShaderSource(shader, 1, sources, NULL);
  seam->glCompileShader(shader);
  GLint ok = 0;
  seam->glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
  if (ok == 0) {
    char log[512] = {0};
    seam->glGetShaderInfoLog(shader, (GLsizei)sizeof(log), NULL, log);
    report(seam, "gpu: %s shader compile: %s", debug_name, log);
    seam->glDeleteShader(shader);
    return 0;
  }
  return shader;
}

ReSeamProgram re_seam_program(ReSeam *seam, const ReSeamShader *vertex, const ReSeamShader *fragment,
                              const char *debug_name) {
  ReSeamProgram program = {0};
  if (seam == NULL) return program;
  GLuint vs = compile(seam, GL_VERTEX_SHADER, vertex, debug_name);
  GLuint fs = compile(seam, GL_FRAGMENT_SHADER, fragment, debug_name);
  if (vs == 0 || fs == 0) {
    /* Whichever stage did compile is still a live GL object; dropping it here would leak one shader
       per failed program. (VtMB's note, and the reason its version does the same.) */
    if (vs != 0) seam->glDeleteShader(vs);
    if (fs != 0) seam->glDeleteShader(fs);
    return program;
  }
  GLuint id = seam->glCreateProgram();
  seam->counters.allocations++;
  seam->glAttachShader(id, vs);
  seam->glAttachShader(id, fs);
  seam->glLinkProgram(id);
  seam->glDeleteShader(vs);
  seam->glDeleteShader(fs);
  GLint linked = 0;
  seam->glGetProgramiv(id, GL_LINK_STATUS, &linked);
  if (linked == 0) {
    char log[512] = {0};
    seam->glGetProgramInfoLog(id, (GLsizei)sizeof(log), NULL, log);
    report(seam, "gpu: %s program link: %s", debug_name, log);
    seam->glDeleteProgram(id);
    return program;
  }
  program.id = id;
  return program;
}

void re_seam_program_destroy(ReSeam *seam, ReSeamProgram *program) {
  if (seam == NULL || program == NULL) return;
  if (program->id != 0) seam->glDeleteProgram(program->id);
  program->id = 0;
}

void re_seam_program_use(ReSeam *seam, ReSeamProgram program) { seam->glUseProgram(program.id); }

int re_seam_uniform_location(ReSeam *seam, ReSeamProgram program, const char *name) {
  return seam->glGetUniformLocation(program.id, name);
}

void re_seam_uniform_int(ReSeam *seam, int location, int value) { seam->glUniform1i(location, value); }
void re_seam_uniform_float(ReSeam *seam, int location, float value) { seam->glUniform1f(location, value); }
void re_seam_uniform_vec2(ReSeam *seam, int location, float x, float y) {
  seam->glUniform2f(location, x, y);
}
void re_seam_uniform_vec4(ReSeam *seam, int location, float x, float y, float z, float w) {
  seam->glUniform4f(location, x, y, z, w);
}
void re_seam_uniform_mat4(ReSeam *seam, int location, const float *value) {
  seam->glUniformMatrix4fv(location, 1, GL_FALSE, value);
}

/* ---- buffers ----------------------------------------------------------------------------------- */

ReSeamBuffer re_seam_buffer(ReSeam *seam) {
  ReSeamBuffer buffer = {0};
  seam->glGenBuffers(1, &buffer.id);
  seam->counters.allocations++;
  return buffer;
}

void re_seam_buffer_destroy(ReSeam *seam, ReSeamBuffer *buffer) {
  if (seam == NULL || buffer == NULL) return;
  if (buffer->id != 0) seam->glDeleteBuffers(1, &buffer->id);
  buffer->id = 0;
}

void re_seam_buffer_update(ReSeam *seam, ReSeamBuffer buffer, const void *data, size_t bytes,
                           ReSeamBufferUsage usage) {
  seam->glBindBuffer(GL_ARRAY_BUFFER, buffer.id);
  seam->glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)bytes, data,
                     usage == RE_SEAM_BUFFER_DYNAMIC ? GL_DYNAMIC_DRAW : GL_STATIC_DRAW);
}

/* ---- vertex layout ------------------------------------------------------------------------------ */

ReSeamVertexArray re_seam_vertex_array(ReSeam *seam, ReSeamBuffer buffer, const ReSeamVertexLayout *layout) {
  ReSeamVertexArray array = {0};
  seam->glGenVertexArrays(1, &array.id);
  seam->counters.allocations++;
  seam->glBindVertexArray(array.id);
  seam->glBindBuffer(GL_ARRAY_BUFFER, buffer.id);
  for (int i = 0; layout != NULL && i < layout->count; i++) {
    const ReSeamVertexAttribute *attr = &layout->attributes[i];
    /* GL_TRUE for the normalised flag is what turns a byte into 0..1 in the shader — the same
       bytes with GL_FALSE arrive as 0..255 and every colour saturates to white. */
    bool bytes = attr->type == RE_SEAM_ATTRIBUTE_UNORM8;
    seam->glVertexAttribPointer((GLuint)attr->location, attr->components,
                                bytes ? GL_UNSIGNED_BYTE : GL_FLOAT, (GLboolean)(bytes ? 1 : 0),
                                (GLsizei)layout->stride, (const void *)attr->offset);
    seam->glEnableVertexAttribArray((GLuint)attr->location);
  }
  seam->glBindVertexArray(0);
  return array;
}

void re_seam_vertex_array_destroy(ReSeam *seam, ReSeamVertexArray *array) {
  if (seam == NULL || array == NULL) return;
  if (array->id != 0) seam->glDeleteVertexArrays(1, &array->id);
  array->id = 0;
}

void re_seam_vertex_array_bind(ReSeam *seam, ReSeamVertexArray array) { seam->glBindVertexArray(array.id); }

/* ---- textures ------------------------------------------------------------------------------------ */

ReSeamTexture re_seam_texture_2d(ReSeam *seam, const void *rgba, int width, int height,
                                 ReSeamFilter filter, ReSeamWrap wrap) {
  return re_seam_texture_2d_for(seam, rgba, width, height, filter, wrap, RE_SEAM_TEXTURE_SAMPLED);
}

void re_seam_texture_destroy(ReSeam *seam, ReSeamTexture *texture) {
  if (seam == NULL || texture == NULL) return;
  if (texture->id != 0) seam->glDeleteTextures(1, &texture->id);
  texture->id = 0;
  texture->width = 0;
  texture->height = 0;
}

uintptr_t re_seam_texture_handle(ReSeam *seam, ReSeamTexture texture) {
  (void)seam;
  return texture.id;   /* on OpenGL the seam's id and the API's name are the same number */
}

void re_seam_texture_bind(ReSeam *seam, ReSeamTexture texture, int unit) {
  seam->glActiveTexture((GLenum)(GL_TEXTURE0 + unit));
  seam->glBindTexture(GL_TEXTURE_2D, texture.id);
}

/* ---- textures, continued ------------------------------------------------------------------------ */

ReSeamTexture re_seam_texture_2d_for(ReSeam *seam, const void *rgba, int width, int height,
                                     ReSeamFilter filter, ReSeamWrap wrap, ReSeamTextureUse use) {
  ReSeamTexture texture = {0};
  GLint gl_filter = filter == RE_SEAM_FILTER_NEAREST ? GL_NEAREST : GL_LINEAR;
  GLint gl_wrap = wrap == RE_SEAM_WRAP_REPEAT ? GL_REPEAT : GL_CLAMP_TO_EDGE;
  /* A depth attachment has no colour format; asking GL for RGBA here yields an incomplete
     framebuffer later, which reports as "status 0x8CD6" and says nothing about the cause. */
  GLint internal = use == RE_SEAM_TEXTURE_DEPTH ? GL_DEPTH_COMPONENT24
                 : use == RE_SEAM_TEXTURE_COVERAGE ? GL_R8 : GL_RGBA;
  GLenum format = use == RE_SEAM_TEXTURE_DEPTH ? GL_DEPTH_COMPONENT
                : use == RE_SEAM_TEXTURE_COVERAGE ? GL_RED : GL_RGBA;
  GLenum type = use == RE_SEAM_TEXTURE_DEPTH ? GL_UNSIGNED_INT : GL_UNSIGNED_BYTE;
  texture.width = width;
  texture.height = height;
  seam->glGenTextures(1, &texture.id);
  seam->counters.allocations++;
  seam->glBindTexture(GL_TEXTURE_2D, texture.id);
  seam->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, gl_filter);
  seam->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, gl_filter);
  seam->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, gl_wrap);
  seam->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, gl_wrap);
  seam->glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  seam->glTexImage2D(GL_TEXTURE_2D, 0, internal, width, height, 0, format, type, rgba);
  seam->glBindTexture(GL_TEXTURE_2D, 0);
  return texture;
}

void re_seam_texture_update(ReSeam *seam, ReSeamTexture texture, int x, int y, int width, int height,
                            const void *rgba) {
  if (seam == NULL || texture.id == 0 || rgba == NULL || width <= 0 || height <= 0) return;
  seam->glBindTexture(GL_TEXTURE_2D, texture.id);
  seam->glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  /* Asked rather than remembered: GL already knows what this texture is, so a one-channel page and
     a four-channel one take the right upload without the seam keeping a table or the handle growing
     a field that vtmb-vr's call sites would have to carry. */
  GLint internal = GL_RGBA;
  seam->glGetTexLevelParameteriv(GL_TEXTURE_2D, 0, GL_TEXTURE_INTERNAL_FORMAT, &internal);
  seam->glTexSubImage2D(GL_TEXTURE_2D, 0, x, y, (GLsizei)width, (GLsizei)height,
                        internal == GL_R8 ? GL_RED : GL_RGBA, GL_UNSIGNED_BYTE, rgba);
  seam->glBindTexture(GL_TEXTURE_2D, 0);
}

/* ---- render targets ------------------------------------------------------------------------------ */

ReSeamTarget re_seam_target(ReSeam *seam, ReSeamTexture color, ReSeamTexture depth) {
  ReSeamTarget target = {0};
  if (seam == NULL || color.id == 0) {
    report(seam, "gpu: a render target needs a colour texture");
    return target;
  }
  seam->glGenFramebuffers(1, &target.id);
  seam->counters.allocations++;
  seam->glBindFramebuffer(GL_FRAMEBUFFER, target.id);
  seam->glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, color.id, 0);
  if (depth.id != 0)
    seam->glFramebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, depth.id, 0);
  GLenum status = seam->glCheckFramebufferStatus(GL_FRAMEBUFFER);
  seam->glBindFramebuffer(GL_FRAMEBUFFER, 0);
  if (status != GL_FRAMEBUFFER_COMPLETE) {
    /* Naming the sizes is the whole diagnostic: mismatched attachments are what this is, nearly
       every time, and the status code alone sends the reader to a table instead of to the bug. */
    report(seam, "gpu: render target incomplete (status 0x%X) with colour %dx%d and depth %dx%d",
           (unsigned)status, color.width, color.height, depth.width, depth.height);
    seam->glDeleteFramebuffers(1, &target.id);
    target.id = 0;
    return target;
  }
  target.width = color.width;
  target.height = color.height;
  return target;
}

void re_seam_target_destroy(ReSeam *seam, ReSeamTarget *target) {
  if (seam == NULL || target == NULL) return;
  if (target->id != 0) seam->glDeleteFramebuffers(1, &target->id);
  target->id = 0;
  target->width = 0;
  target->height = 0;
}

ReSeamTarget re_seam_target_adopt(ReSeam *seam, uintptr_t handle, int width, int height, int format) {
  ReSeamTarget target = {0};
  (void)seam;
  (void)format;   /* a framebuffer name carries its own attachments; GL has nothing to be told */
  /* On OpenGL the host's handle IS a framebuffer name, and 0 is the window's back buffer — a legal
     value, which is why a zero target means "the frame's target" rather than "no target". */
  target.id = (uint32_t)handle;
  target.width = width;
  target.height = height;
  return target;
}

void re_seam_target_bind(ReSeam *seam, ReSeamTarget target) {
  if (seam == NULL) return;
  /* A zero handle is "back to the frame's target", not "the window". The distinction is invisible on
     a desktop that renders straight to the back buffer and decisive anywhere else: a headset renders
     into a runtime image, and a test renders into its own framebuffer. */
  if (target.id == 0) target = seam->frame_target;
  seam->bound = target;
  seam->glBindFramebuffer(GL_FRAMEBUFFER, target.id);
}

/* ---- the frame ------------------------------------------------------------------------------------
 * OpenGL has no command buffer to open, so this pair is bookkeeping here and real work in the other
 * two backends. It is still tracked rather than ignored: a call site that forgets the bracket would
 * otherwise work on OpenGL and draw nothing on Vulkan, which is the worst way to find out. */

void re_seam_frame_begin(ReSeam *seam, ReSeamTarget target) {
  if (seam == NULL) return;
  seam->counters.frames++;
  if (seam->in_frame) report(seam, "gpu: re_seam_frame_begin inside a frame that never ended");
  seam->in_frame = true;
  seam->frame_target = target;
  seam->bound = target;
  seam->glBindFramebuffer(GL_FRAMEBUFFER, target.id);
}

void re_seam_frame_end(ReSeam *seam) {
  if (seam == NULL) return;
  if (!seam->in_frame) report(seam, "gpu: re_seam_frame_end outside a frame");
  seam->in_frame = false;
  seam->glFlush();
}

/* ---- state and draw ------------------------------------------------------------------------------ */

static GLenum blend_source(ReSeamBlend blend) {
  return blend == RE_SEAM_BLEND_NONE || blend == RE_SEAM_BLEND_PREMULTIPLIED ? GL_ONE : GL_SRC_ALPHA;
}
static GLenum blend_dest(ReSeamBlend blend) {
  if (blend == RE_SEAM_BLEND_NONE) return 0;                     /* unused; blending is off */
  return blend == RE_SEAM_BLEND_ADDITIVE ? GL_ONE : GL_ONE_MINUS_SRC_ALPHA;
}

void re_seam_blend(ReSeam *seam, ReSeamBlend blend) {
  if (blend == RE_SEAM_BLEND_NONE) {
    seam->glDisable(GL_BLEND);
    return;
  }
  seam->glEnable(GL_BLEND);
  seam->glBlendFunc(blend_source(blend), blend_dest(blend));
}

void re_seam_depth(ReSeam *seam, ReSeamDepthTest test, ReSeamDepthWrite write) {
  if (test == RE_SEAM_DEPTH_TEST_ENABLED) seam->glEnable(GL_DEPTH_TEST);
  else seam->glDisable(GL_DEPTH_TEST);
  seam->glDepthMask(write == RE_SEAM_DEPTH_WRITE_ENABLED ? GL_TRUE : GL_FALSE);
}

void re_seam_cull(ReSeam *seam, ReSeamCull cull) {
  if (cull == RE_SEAM_CULL_BACK) {
    seam->glEnable(GL_CULL_FACE);
    seam->glCullFace(GL_BACK);
    return;
  }
  seam->glDisable(GL_CULL_FACE);
}

/* The header's rectangles put row 0 at the top; OpenGL's put it at the bottom. Vulkan and Metal need
   no such conversion, which is why this lives here and not in the caller. */
static int gl_bottom(const ReSeam *seam, int y, int height) {
  return seam->bound.height - (y + height);
}

void re_seam_viewport(ReSeam *seam, int x, int y, int width, int height) {
  if (seam == NULL) return;
  seam->glViewport(x, gl_bottom(seam, y, height), (GLsizei)width, (GLsizei)height);
}

void re_seam_scissor(ReSeam *seam, int x, int y, int width, int height) {
  if (seam == NULL) return;
  if (width < 0 || height < 0) {
    seam->glDisable(GL_SCISSOR_TEST);
    return;
  }
  seam->glEnable(GL_SCISSOR_TEST);
  seam->glScissor(x, gl_bottom(seam, y, height), (GLsizei)width, (GLsizei)height);
}

void re_seam_blend_separate(ReSeam *seam, ReSeamBlend color, ReSeamBlend alpha) {
  if (color == RE_SEAM_BLEND_NONE && alpha == RE_SEAM_BLEND_NONE) {
    seam->glDisable(GL_BLEND);
    return;
  }
  seam->glEnable(GL_BLEND);
  seam->glBlendFuncSeparate(blend_source(color), blend_dest(color), blend_source(alpha), blend_dest(alpha));
}

void re_seam_depth_compare(ReSeam *seam, ReSeamDepthCompare compare) {
  GLenum func = GL_LESS;
  if (compare == RE_SEAM_DEPTH_LESS_EQUAL) func = GL_LEQUAL;
  else if (compare == RE_SEAM_DEPTH_EQUAL) func = GL_EQUAL;
  else if (compare == RE_SEAM_DEPTH_ALWAYS) func = GL_ALWAYS;
  seam->glDepthFunc(func);
}

void re_seam_clear(ReSeam *seam, float r, float g, float b, float a, bool depth) {
  seam->glClearColor(r, g, b, a);
  GLbitfield mask = GL_COLOR_BUFFER_BIT;
  /* A depth clear is a no-op unless depth writes are on — GL masks the clear too. Forcing the write
     here would be a hidden state change; a call site that clears depth sets the write itself. */
  if (depth) mask |= GL_DEPTH_BUFFER_BIT;
  seam->glClear(mask);
}

ReSeamCounters re_seam_counters(ReSeam *seam) {
  ReSeamCounters none = {0, 0, 0};
  return seam ? seam->counters : none;
}

void re_seam_draw(ReSeam *seam, ReSeamPrimitive primitive, int first, int count) {
  if (seam) seam->counters.draws++;
  seam->glDrawArrays(primitive == RE_SEAM_PRIMITIVE_LINES ? GL_LINES : GL_TRIANGLES, first, (GLsizei)count);
}

const char *re_seam_api_version(ReSeam *seam) {
  const GLubyte_t *version = seam->glGetString(GL_VERSION);
  return version != NULL ? (const char *)version : "unknown";
}
