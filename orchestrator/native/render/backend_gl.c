#include "render/backend_gl.h"
#include "render/utf8.h"
#define GLAD_GL_IMPLEMENTATION
#include "glad/gl.h"
#include <stdlib.h>
#include <string.h>

#define ATLAS_SIZE 2048
#define GLYPH_SLOTS 4096
#define BATCH_VERTICES 65536
enum { MODE_SOLID = 0, MODE_FILL = 1, MODE_RING = 2, MODE_SHADOW = 3, MODE_COVERAGE = 4, MODE_RGBA = 5 };

typedef struct { float x, y, u, v; uint8_t r, g, b, a; float cx, cy, hw, hh; float r0, r1, r2, r3; float w, mode; } Vertex;
typedef struct { uint32_t codepoint; uint8_t face; int16_t size; bool used, present; int ax, ay, w, h, dx, dy; } Glyph;
typedef struct { ReTexture base; GLuint id; } GlTexture;
typedef struct {
  ReBackend base; SDL_Window *window; SDL_GLContext context; bool current; float density; int dw, dh;
  GLuint program, vao, vbo, atlas; GLint u_size, u_texture;
  Vertex *vertices; size_t count; GLuint bound;
  Glyph glyphs[GLYPH_SLOTS]; int shelf_x, shelf_y, shelf_h;
} GlBackend;

static const char *vertex_source =
  "#version 330 core\n"
  "layout(location=0) in vec2 a_pos; layout(location=1) in vec2 a_uv; layout(location=2) in vec4 a_color;\n"
  "layout(location=3) in vec4 a_shape; layout(location=4) in vec4 a_radii; layout(location=5) in vec2 a_extra;\n"
  "uniform vec2 u_size;\n"
  "out vec2 v_pos; out vec2 v_uv; out vec4 v_color; flat out vec4 v_shape; flat out vec4 v_radii; flat out vec2 v_extra;\n"
  "void main() {\n"
  "  v_pos = a_pos; v_uv = a_uv; v_color = a_color; v_shape = a_shape; v_radii = a_radii; v_extra = a_extra;\n"
  "  gl_Position = vec4(a_pos.x / u_size.x * 2.0 - 1.0, 1.0 - a_pos.y / u_size.y * 2.0, 0.0, 1.0);\n"
  "}\n";
/* Signed-distance shapes with a one-pixel feather — see sidecar: sdf-shapes */
static const char *fragment_source =
  "#version 330 core\n"
  "in vec2 v_pos; in vec2 v_uv; in vec4 v_color; flat in vec4 v_shape; flat in vec4 v_radii; flat in vec2 v_extra;\n"
  "uniform sampler2D u_texture; out vec4 o_color;\n"
  "float box(vec2 p, vec2 h, float r) { vec2 q = abs(p) - (h - vec2(r)); return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }\n"
  "float corner(vec2 p) { return p.x < 0.0 ? (p.y < 0.0 ? v_radii.x : v_radii.w) : (p.y < 0.0 ? v_radii.y : v_radii.z); }\n"
  "void main() {\n"
  "  int mode = int(v_extra.y + 0.5); vec4 c = v_color; vec2 p = v_pos - v_shape.xy; vec2 h = v_shape.zw; float w = v_extra.x;\n"
  "  if (mode == 1) { c.a *= clamp(0.5 - box(p, h, corner(p)), 0.0, 1.0); }\n"
  "  else if (mode == 2) { float r = corner(p); float o = clamp(0.5 - box(p, h, r), 0.0, 1.0);\n"
  "    float i = clamp(0.5 - box(p, h - vec2(w), max(r - w, 0.0)), 0.0, 1.0); c.a *= o * (1.0 - i); }\n"
  "  else if (mode == 3) { c.a *= 1.0 - smoothstep(0.0, w, box(p, h, corner(p))); }\n"
  "  else if (mode == 4) { c.a *= texture(u_texture, v_uv).r; }\n"
  "  else if (mode == 5) { c *= texture(u_texture, v_uv); }\n"
  "  if (c.a <= 0.0) discard;\n"
  "  o_color = c;\n"
  "}\n";

static GLuint compile(GLenum type, const char *source) {
  GLuint shader = glCreateShader(type); glShaderSource(shader, 1, &source, NULL); glCompileShader(shader);
  GLint ok = 0; glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
  if (!ok) { char log[1024] = {0}; glGetShaderInfoLog(shader, sizeof(log), NULL, log); SDL_SetError("OpenGL shader failed: %s", log); glDeleteShader(shader); return 0; }
  return shader;
}
static void flush(GlBackend *b) {
  if (!b->count) return;
  glActiveTexture(GL_TEXTURE0); glBindTexture(GL_TEXTURE_2D, b->bound ? b->bound : b->atlas);
  glBindBuffer(GL_ARRAY_BUFFER, b->vbo);
  glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(b->count * sizeof(Vertex)), b->vertices, GL_STREAM_DRAW);
  glDrawArrays(GL_TRIANGLES, 0, (GLsizei)b->count); b->count = 0;
}
static void bind(GlBackend *b, GLuint texture) { if (texture != b->bound) { flush(b); b->bound = texture; } }
static void emit(GlBackend *b, float x0, float y0, float x1, float y1, float u0, float v0, float u1, float v1, ReColor c,
                 float cx, float cy, float hw, float hh, const float radii[4], float w, int mode) {
  if (b->count + 6 > BATCH_VERTICES) flush(b);
  Vertex *v = b->vertices + b->count; b->count += 6;
  float xs[6] = {x0, x1, x1, x0, x1, x0}, ys[6] = {y0, y0, y1, y0, y1, y1};
  float us[6] = {u0, u1, u1, u0, u1, u0}, vs[6] = {v0, v0, v1, v0, v1, v1};
  for (int i = 0; i < 6; i++) {
    v[i].x = xs[i]; v[i].y = ys[i]; v[i].u = us[i]; v[i].v = vs[i]; v[i].r = c.r; v[i].g = c.g; v[i].b = c.b; v[i].a = c.a;
    v[i].cx = cx; v[i].cy = cy; v[i].hw = hw; v[i].hh = hh; v[i].r0 = radii[0]; v[i].r1 = radii[1]; v[i].r2 = radii[2]; v[i].r3 = radii[3];
    v[i].w = w; v[i].mode = (float)mode;
  }
}
static void shape(GlBackend *b, ReRect r, ReColor c, float radius, uint8_t corners, float w, int mode, int expand) {
  float d = b->density, x0 = (float)(r.x - expand) * d, y0 = (float)(r.y - expand) * d, x1 = (float)(r.x + r.w + expand) * d, y1 = (float)(r.y + r.h + expand) * d;
  float radii[4] = {corners & RE_CORNER_TOP_LEFT ? radius * d : 0, corners & RE_CORNER_TOP_RIGHT ? radius * d : 0,
                    corners & RE_CORNER_BOTTOM_RIGHT ? radius * d : 0, corners & RE_CORNER_BOTTOM_LEFT ? radius * d : 0};
  float cx = (float)r.x * d + (float)r.w * d / 2, cy = (float)r.y * d + (float)r.h * d / 2, hw = (float)r.w * d / 2, hh = (float)r.h * d / 2;
  if (mode == MODE_RING) { hw += (float)expand * d; hh += (float)expand * d; for (int i = 0; i < 4; i++) radii[i] += (float)expand * d; }
  emit(b, x0, y0, x1, y1, 0, 0, 0, 0, c, cx, cy, hw, hh, radii, w * d, mode);
}

static void atlas_reset(GlBackend *b) { memset(b->glyphs, 0, sizeof(b->glyphs)); b->shelf_x = b->shelf_y = b->shelf_h = 0; }
static bool atlas_place(GlBackend *b, int w, int h, int *x, int *y) {
  if (b->shelf_x + w + 1 > ATLAS_SIZE) { b->shelf_y += b->shelf_h + 1; b->shelf_x = 0; b->shelf_h = 0; }
  if (b->shelf_y + h + 1 > ATLAS_SIZE || w + 1 > ATLAS_SIZE) return false;
  *x = b->shelf_x; *y = b->shelf_y; b->shelf_x += w + 1; if (h > b->shelf_h) b->shelf_h = h; return true;
}
/* Glyph placement reproduces the SDL reference expressions at drawable resolution — see sidecar: reference-parity */
static Glyph *glyph(GlBackend *b, uint8_t face, int16_t size, uint32_t cp) {
  Glyph *g = &b->glyphs[(cp * 31u + face * 7919u + (uint32_t)size * 131u) % GLYPH_SLOTS];
  if (g->used && g->codepoint == cp && g->face == face && g->size == size) return g;
  ReGlyphBitmap bitmap;
  bool raster = re_font_glyph(b->base.fonts, face, size, b->density, cp, &bitmap);
  for (int attempt = 0; attempt < 2; attempt++) {
    memset(g, 0, sizeof(*g)); g->used = true; g->codepoint = cp; g->face = face; g->size = size;
    if (!raster || !bitmap.w || !bitmap.h) break;
    if (atlas_place(b, bitmap.w, bitmap.h, &g->ax, &g->ay)) {
      g->w = bitmap.w; g->h = bitmap.h; g->dx = bitmap.dx; g->dy = bitmap.dy; g->present = true;
      glBindTexture(GL_TEXTURE_2D, b->atlas); glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
      glTexSubImage2D(GL_TEXTURE_2D, 0, g->ax, g->ay, g->w, g->h, GL_RED, GL_UNSIGNED_BYTE, bitmap.pixels);
      break;
    }
    flush(b); atlas_reset(b); /* the atlas is full: repack from scratch and retry once */
  }
  if (raster) re_font_glyph_free(&bitmap);
  return g;
}
static void draw_text(GlBackend *b, ReColor color, uint8_t face, int size, int x, int y, const char *s, const char *end) {
  ReFontMetrics m = re_font_metrics(b->base.fonts, face, size, b->density);
  float d = b->density, base = (float)(y + m.ascent + 2) * d;
  bind(b, 0);
  while (*s && s < end) {
    uint32_t cp = re_utf8(&s); Glyph *g = glyph(b, face, (int16_t)size, cp);
    if (g->present) {
      float gx = (float)x * d + (float)g->dx, gy = base + (float)g->dy, radii[4] = {0, 0, 0, 0};
      emit(b, gx, gy, gx + (float)g->w, gy + (float)g->h, (float)g->ax / ATLAS_SIZE, (float)g->ay / ATLAS_SIZE,
           (float)(g->ax + g->w) / ATLAS_SIZE, (float)(g->ay + g->h) / ATLAS_SIZE, color, 0, 0, 0, 0, radii, 0, MODE_COVERAGE);
    }
    x += m.advance;
  }
}
static void set_clip(GlBackend *b, const ReCommand *c) {
  flush(b);
  if (c->flags & RE_CLIP_RESET) { glDisable(GL_SCISSOR_TEST); return; }
  int w = c->rect.w > 0 ? c->rect.w : 0, h = c->rect.h > 0 ? c->rect.h : 0;
  glEnable(GL_SCISSOR_TEST);
  glScissor((GLint)((float)c->rect.x * b->density), (GLint)((float)b->dh - (float)(c->rect.y + h) * b->density),
            (GLsizei)((float)w * b->density), (GLsizei)((float)h * b->density));
}

static float density(ReBackend *backend, int logical_width) {
  GlBackend *b = (GlBackend *)backend; int dw, dh; SDL_GL_GetDrawableSize(b->window, &dw, &dh);
  return (float)dw / (logical_width > 1 ? logical_width : 1);
}
static bool begin(ReBackend *backend, const ReDrawList *list) {
  GlBackend *b = (GlBackend *)backend;
  if (!b->current) { if (SDL_GL_MakeCurrent(b->window, b->context) != 0) return false; b->current = true; }
  SDL_GL_GetDrawableSize(b->window, &b->dw, &b->dh);
  if (list->density != b->density) { b->density = list->density; atlas_reset(b); }
  glViewport(0, 0, b->dw, b->dh); glDisable(GL_SCISSOR_TEST);
  glClearColor((float)list->clear.r / 255, (float)list->clear.g / 255, (float)list->clear.b / 255, (float)list->clear.a / 255);
  glClear(GL_COLOR_BUFFER_BIT);
  glUseProgram(b->program); glBindVertexArray(b->vao); glUniform2f(b->u_size, (float)b->dw, (float)b->dh); glUniform1i(b->u_texture, 0);
  b->count = 0; b->bound = 0; return true;
}
static void execute(ReBackend *backend, const ReDrawList *list) {
  GlBackend *b = (GlBackend *)backend; static const float none[4] = {0, 0, 0, 0};
  for (size_t i = 0; i < list->count; i++) {
    const ReCommand *c = &list->commands[i]; float d = b->density;
    switch (c->type) {
      case RE_CMD_CLIP: set_clip(b, c); break;
      case RE_CMD_RECT: bind(b, 0); shape(b, c->rect, c->color, 0, 0, 0, MODE_SOLID, 0); break;
      case RE_CMD_RRECT: bind(b, 0); shape(b, c->rect, c->color, c->radius, c->corners, 0, c->radius > 0 && c->corners ? MODE_FILL : MODE_SOLID, 0); break;
      case RE_CMD_FRAME:
        bind(b, 0); shape(b, c->rect, c->color, c->radius, c->corners, 1, MODE_RING, 0);
        if (c->secondary.a) {
          int rad = (int)c->radius; if (rad > c->rect.w / 2) rad = c->rect.w / 2; if (rad > c->rect.h / 2) rad = c->rect.h / 2;
          shape(b, re_rect(c->rect.x + 1 + rad, c->rect.y + 1, c->rect.w - 2 - 2 * rad, 1), c->secondary, 0, 0, 0, MODE_SOLID, 0);
        }
        break;
      case RE_CMD_SHADOW: bind(b, 0); shape(b, c->rect, c->color, c->radius, c->corners, (float)c->width, MODE_SHADOW, c->width); break;
      case RE_CMD_RING: bind(b, 0); shape(b, c->rect, c->color, c->radius, c->corners, (float)c->width, MODE_RING, c->width); break;
      case RE_CMD_TEXT: { const char *s = re_draw_list_string(list, c); draw_text(b, c->color, c->face, c->size > 0 ? c->size : 16, c->rect.x, c->rect.y, s, s + c->text_length); break; }
      case RE_CMD_ICON: {
        static const char *glyphs[RE_ICON_COUNT] = {"?", "x", "+", ">", "v"};
        const char *s = glyphs[c->icon < RE_ICON_COUNT ? c->icon : RE_ICON_UNKNOWN]; int size = c->size > 0 ? c->size : 16;
        ReFontMetrics m = re_font_metrics(b->base.fonts, RE_FACE_MONO, size, d);
        draw_text(b, c->color, RE_FACE_MONO, size, c->rect.x + (c->rect.w - m.advance) / 2, c->rect.y + (c->rect.h - m.line_height) / 2, s, s + strlen(s));
        break;
      }
      case RE_CMD_TEXTURE: {
        GlTexture *t = (GlTexture *)c->texture; if (!t) break;
        bind(b, t->id); bool flip = (c->flags & RE_DRAW_FLIP_Y) != 0;
        emit(b, (float)c->rect.x * d, (float)c->rect.y * d, (float)(c->rect.x + c->rect.w) * d, (float)(c->rect.y + c->rect.h) * d,
             0, flip ? 1.0f : 0.0f, 1, flip ? 0.0f : 1.0f, re_color(255, 255, 255, 255), 0, 0, 0, 0, none, 0, MODE_RGBA);
        break;
      }
      default: break;
    }
  }
  flush(b); glDisable(GL_SCISSOR_TEST); glFlush();
}
static void present(ReBackend *backend) { SDL_GL_SwapWindow(((GlBackend *)backend)->window); }
static bool snapshot(ReBackend *backend, const char *path) {
  GlBackend *b = (GlBackend *)backend; int w = b->dw, h = b->dh;
  unsigned char *pixels = malloc((size_t)w * (size_t)h * 4); if (!pixels) return false;
  glPixelStorei(GL_PACK_ALIGNMENT, 1); glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
  SDL_Surface *s = SDL_CreateRGBSurfaceWithFormat(0, w, h, 32, SDL_PIXELFORMAT_RGBA32);
  bool ok = false;
  if (s) {
    for (int y = 0; y < h; y++) memcpy((unsigned char *)s->pixels + (size_t)y * (size_t)s->pitch, pixels + (size_t)(h - 1 - y) * (size_t)w * 4, (size_t)w * 4);
    ok = SDL_SaveBMP(s, path) == 0; SDL_FreeSurface(s);
  }
  free(pixels); return ok;
}
static ReTexture *texture_create(ReBackend *backend, int width, int height) {
  GlTexture *t = calloc(1, sizeof(*t)); if (!t) return NULL;
  glGenTextures(1, &t->id); glBindTexture(GL_TEXTURE_2D, t->id);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  t->base.owner = backend; t->base.width = width; t->base.height = height; return &t->base;
}
static bool texture_update(ReTexture *texture, const void *rgba, int pitch) {
  GlTexture *t = (GlTexture *)texture; if (!t || pitch != texture->width * 4) return false;
  glBindTexture(GL_TEXTURE_2D, t->id); glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
  glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, texture->width, texture->height, GL_RGBA, GL_UNSIGNED_BYTE, rgba); return true;
}
static void texture_destroy(ReTexture *texture) { GlTexture *t = (GlTexture *)texture; if (!t) return; glDeleteTextures(1, &t->id); free(t); }
static void close_backend(ReBackend *backend) {
  GlBackend *b = (GlBackend *)backend; if (!b) return;
  if (b->context) {
    SDL_GL_MakeCurrent(b->window, b->context);
    if (b->atlas) glDeleteTextures(1, &b->atlas);
    if (b->vbo) glDeleteBuffers(1, &b->vbo);
    if (b->vao) glDeleteVertexArrays(1, &b->vao);
    if (b->program) glDeleteProgram(b->program);
    SDL_GL_DeleteContext(b->context);
  }
  free(b->vertices); free(b);
}
static const ReBackendOps ops = {"opengl", density, begin, execute, present, snapshot, texture_create, texture_update, texture_destroy, close_backend};

Uint32 re_backend_gl_window_flags(void) {
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3); SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS, SDL_GL_CONTEXT_FORWARD_COMPATIBLE_FLAG);
  SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1); SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 0); SDL_GL_SetAttribute(SDL_GL_STENCIL_SIZE, 0);
  return SDL_WINDOW_OPENGL;
}
ReBackend *re_backend_gl_open(SDL_Window *window, ReFontSet *fonts) {
  GlBackend *b = calloc(1, sizeof(*b)); if (!b) return NULL;
  b->window = window; b->base.ops = &ops; b->base.fonts = fonts; b->density = 1.0f;
  b->context = SDL_GL_CreateContext(window);
  if (!b->context) { close_backend(&b->base); return NULL; }
  int version = gladLoadGL((GLADloadfunc)SDL_GL_GetProcAddress);
  if (!version || GLAD_VERSION_MAJOR(version) < 3 || (GLAD_VERSION_MAJOR(version) == 3 && GLAD_VERSION_MINOR(version) < 3)) {
    SDL_SetError("OpenGL 3.3 core is required; the driver offered %d.%d", GLAD_VERSION_MAJOR(version), GLAD_VERSION_MINOR(version));
    close_backend(&b->base); return NULL;
  }
  SDL_GL_SetSwapInterval(1);
  GLuint vs = compile(GL_VERTEX_SHADER, vertex_source), fs = vs ? compile(GL_FRAGMENT_SHADER, fragment_source) : 0;
  if (!vs || !fs) { if (vs) glDeleteShader(vs); close_backend(&b->base); return NULL; }
  b->program = glCreateProgram(); glAttachShader(b->program, vs); glAttachShader(b->program, fs); glLinkProgram(b->program);
  glDeleteShader(vs); glDeleteShader(fs);
  GLint ok = 0; glGetProgramiv(b->program, GL_LINK_STATUS, &ok);
  if (!ok) { char log[1024] = {0}; glGetProgramInfoLog(b->program, sizeof(log), NULL, log); SDL_SetError("OpenGL program failed: %s", log); close_backend(&b->base); return NULL; }
  b->u_size = glGetUniformLocation(b->program, "u_size"); b->u_texture = glGetUniformLocation(b->program, "u_texture");
  b->vertices = malloc(sizeof(Vertex) * BATCH_VERTICES);
  if (!b->vertices) { SDL_SetError("Cannot allocate the OpenGL vertex batch"); close_backend(&b->base); return NULL; }
  glGenVertexArrays(1, &b->vao); glBindVertexArray(b->vao); glGenBuffers(1, &b->vbo); glBindBuffer(GL_ARRAY_BUFFER, b->vbo);
  GLsizei stride = sizeof(Vertex);
  glEnableVertexAttribArray(0); glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, stride, (void *)offsetof(Vertex, x));
  glEnableVertexAttribArray(1); glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, stride, (void *)offsetof(Vertex, u));
  glEnableVertexAttribArray(2); glVertexAttribPointer(2, 4, GL_UNSIGNED_BYTE, GL_TRUE, stride, (void *)offsetof(Vertex, r));
  glEnableVertexAttribArray(3); glVertexAttribPointer(3, 4, GL_FLOAT, GL_FALSE, stride, (void *)offsetof(Vertex, cx));
  glEnableVertexAttribArray(4); glVertexAttribPointer(4, 4, GL_FLOAT, GL_FALSE, stride, (void *)offsetof(Vertex, r0));
  glEnableVertexAttribArray(5); glVertexAttribPointer(5, 2, GL_FLOAT, GL_FALSE, stride, (void *)offsetof(Vertex, w));
  glGenTextures(1, &b->atlas); glBindTexture(GL_TEXTURE_2D, b->atlas);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_R8, ATLAS_SIZE, ATLAS_SIZE, 0, GL_RED, GL_UNSIGNED_BYTE, NULL);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glEnable(GL_BLEND); glBlendFuncSeparate(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA, GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
  glDisable(GL_DEPTH_TEST); glDisable(GL_CULL_FACE);
  atlas_reset(b);
  return &b->base;
}
