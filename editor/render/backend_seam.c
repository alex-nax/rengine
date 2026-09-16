/* The draw list, rendered through the pack's seam (spec 124, F133).
 *
 * One source for every graphics API rEngine supports. backend_gl.c, backend_metal.m and
 * backend_vk.c were the same renderer written three times — the same signed-distance shapes, the
 * same glyph atlas, the same batching — in three graphics APIs and three shader dialects, and they
 * had already drifted in their attribute numbering and their Y convention while nobody noticed.
 * This file is that renderer once. Which API it runs on is a build choice; which SEAM it calls is
 * chosen by the dispatch in backend.c, and neither is visible here.
 *
 * It calls the seam and `seam_host.h` and nothing else: no GL, no Vulkan, no Metal, no SDL beyond
 * what the host hands it. That is checkable, and it is checked.
 *
 * Ported from backend_gl.c, whose sidecar notes on the SDF shapes, the glyph placement and the
 * gradient strips still describe this code — the arithmetic is unchanged on purpose, because the
 * committed reference frames are the gate and a rewrite that also moved pixels could not be judged.
 */
#include "render/backend.h"
#include "render/seam_host.h"
#include "render/shaders/ui_shaders.h"
#include "render/utf8.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ATLAS_SIZE 2048
#define GLYPH_SLOTS 4096
#define BATCH_VERTICES 65536
enum { MODE_SOLID = 0, MODE_FILL = 1, MODE_RING = 2, MODE_SHADOW = 3, MODE_COVERAGE = 4, MODE_RGBA = 5 };

/* The one vertex layout, matching shaders/ui.glsl's one set of attribute locations. The colour is
 * four BYTES: twelve saved on every vertex of a 65,536-vertex batch, and the reason the seam grew a
 * second attribute type. */
typedef struct {
  float x, y, u, v;
  uint8_t r, g, b, a;
  float cx, cy, hw, hh;
  float r0, r1, r2, r3;
  float w, mode;
} Vertex;
typedef struct { uint32_t codepoint; uint8_t face; int16_t size; bool used, present; int ax, ay, w, h, dx, dy; } Glyph;
typedef struct { ReTexture base; ReSeamTexture texture; bool adopted; } SeamTexture;

typedef struct {
  ReBackend base;
  void *window;
  ReSeamHost *host;
  ReSeam *seam;
  ReSeamProgram program;
  ReSeamBuffer buffer;
  ReSeamVertexArray array;
  ReSeamTexture atlas;
  ReSeamTarget target;
  int u_size, u_texture;
  float density;
  int dw, dh;
  Vertex *vertices;
  size_t count;
  uint32_t bound;                 /* the texture id currently batched, 0 for the atlas */
  bool in_frame;
  Glyph glyphs[GLYPH_SLOTS];
  int shelf_x, shelf_y, shelf_h;
} SeamBackend;

/* ---- batching ------------------------------------------------------------------------------- */

static void flush(SeamBackend *b) {
  if (!b->count) return;
  re_seam_texture_bind(b->seam, b->bound ? (ReSeamTexture){b->bound, 0, 0} : b->atlas, 0);
  re_seam_buffer_update(b->seam, b->buffer, b->vertices, b->count * sizeof(Vertex), RE_SEAM_BUFFER_DYNAMIC);
  re_seam_vertex_array_bind(b->seam, b->array);
  re_seam_draw(b->seam, RE_SEAM_PRIMITIVE_TRIANGLES, 0, (int)b->count);
  b->count = 0;
}
static void bind(SeamBackend *b, uint32_t texture) { if (texture != b->bound) { flush(b); b->bound = texture; } }

static void emit(SeamBackend *b, float x0, float y0, float x1, float y1, float u0, float v0, float u1, float v1,
                 ReColor c, float cx, float cy, float hw, float hh, const float radii[4], float w, int mode) {
  if (b->count + 6 > BATCH_VERTICES) flush(b);
  Vertex *v = b->vertices + b->count; b->count += 6;
  float xs[6] = {x0, x1, x1, x0, x1, x0}, ys[6] = {y0, y0, y1, y0, y1, y1};
  float us[6] = {u0, u1, u1, u0, u1, u0}, vs[6] = {v0, v0, v1, v0, v1, v1};
  for (int i = 0; i < 6; i++) {
    v[i].x = xs[i]; v[i].y = ys[i]; v[i].u = us[i]; v[i].v = vs[i];
    v[i].r = c.r; v[i].g = c.g; v[i].b = c.b; v[i].a = c.a;
    v[i].cx = cx; v[i].cy = cy; v[i].hw = hw; v[i].hh = hh;
    v[i].r0 = radii[0]; v[i].r1 = radii[1]; v[i].r2 = radii[2]; v[i].r3 = radii[3];
    v[i].w = w; v[i].mode = (float)mode;
  }
}

static void shape(SeamBackend *b, ReRect r, ReColor c, float radius, uint8_t corners, float w, int mode, int expand) {
  float d = b->density, x0 = (float)(r.x - expand) * d, y0 = (float)(r.y - expand) * d;
  float x1 = (float)(r.x + r.w + expand) * d, y1 = (float)(r.y + r.h + expand) * d;
  float radii[4] = {corners & RE_CORNER_TOP_LEFT ? radius * d : 0, corners & RE_CORNER_TOP_RIGHT ? radius * d : 0,
                    corners & RE_CORNER_BOTTOM_RIGHT ? radius * d : 0, corners & RE_CORNER_BOTTOM_LEFT ? radius * d : 0};
  float cx = (float)r.x * d + (float)r.w * d / 2, cy = (float)r.y * d + (float)r.h * d / 2;
  float hw = (float)r.w * d / 2, hh = (float)r.h * d / 2;
  if (mode == MODE_RING) { hw += (float)expand * d; hh += (float)expand * d; for (int i = 0; i < 4; i++) radii[i] += (float)expand * d; }
  emit(b, x0, y0, x1, y1, 0, 0, 0, 0, c, cx, cy, hw, hh, radii, w * d, mode);
}

/* A ramp is one quad per logical pixel carrying the whole rect's shape, so the SDF still rounds the
 * ends while each strip takes its own stop from the shared sampler (backend_gl.c: gradient-strips). */
static void gradient(SeamBackend *b, const ReCommand *c) {
  ReRect r = c->rect;
  if (r.w <= 0 || r.h <= 0) return;
  float d = b->density;
  uint8_t corners = c->corners;
  float radii[4] = {corners & RE_CORNER_TOP_LEFT ? c->radius * d : 0, corners & RE_CORNER_TOP_RIGHT ? c->radius * d : 0,
                    corners & RE_CORNER_BOTTOM_RIGHT ? c->radius * d : 0, corners & RE_CORNER_BOTTOM_LEFT ? c->radius * d : 0};
  float cx = (float)r.x * d + (float)r.w * d / 2, cy = (float)r.y * d + (float)r.h * d / 2;
  float hw = (float)r.w * d / 2, hh = (float)r.h * d / 2;
  int mode = c->radius > 0 && corners ? MODE_FILL : MODE_SOLID;
  bool vertical = (c->flags & RE_GRADIENT_VERTICAL) != 0;
  int steps = vertical ? r.h : r.w;
  for (int i = 0; i < steps; i++) {
    ReColor stop = re_gradient_sample(c->color, c->secondary, i, steps);
    float x0 = (float)(vertical ? r.x : r.x + i) * d, x1 = (float)(vertical ? r.x + r.w : r.x + i + 1) * d;
    float y0 = (float)(vertical ? r.y + i : r.y) * d, y1 = (float)(vertical ? r.y + i + 1 : r.y + r.h) * d;
    emit(b, x0, y0, x1, y1, 0, 0, 0, 0, stop, cx, cy, hw, hh, radii, 0, mode);
  }
}

/* ---- the glyph atlas ------------------------------------------------------------------------- */

static void atlas_reset(SeamBackend *b) { memset(b->glyphs, 0, sizeof(b->glyphs)); b->shelf_x = b->shelf_y = b->shelf_h = 0; }
static bool atlas_place(SeamBackend *b, int w, int h, int *x, int *y) {
  if (b->shelf_x + w + 1 > ATLAS_SIZE) { b->shelf_y += b->shelf_h + 1; b->shelf_x = 0; b->shelf_h = 0; }
  if (b->shelf_y + h + 1 > ATLAS_SIZE || w + 1 > ATLAS_SIZE) return false;
  *x = b->shelf_x; *y = b->shelf_y; b->shelf_x += w + 1; if (h > b->shelf_h) b->shelf_h = h; return true;
}
/* Glyph placement reproduces the SDL reference expressions at drawable resolution
 * (backend_gl.c: reference-parity). */
static Glyph *glyph(SeamBackend *b, uint8_t face, int16_t size, uint32_t cp) {
  Glyph *g = &b->glyphs[(cp * 31u + face * 7919u + (uint32_t)size * 131u) % GLYPH_SLOTS];
  if (g->used && g->codepoint == cp && g->face == face && g->size == size) return g;
  ReGlyphBitmap bitmap;
  bool raster = re_font_glyph(b->base.fonts, face, size, b->density, cp, &bitmap);
  for (int attempt = 0; attempt < 2; attempt++) {
    memset(g, 0, sizeof(*g)); g->used = true; g->codepoint = cp; g->face = face; g->size = size;
    if (!raster || !bitmap.w || !bitmap.h) break;
    if (atlas_place(b, bitmap.w, bitmap.h, &g->ax, &g->ay)) {
      g->w = bitmap.w; g->h = bitmap.h; g->dx = bitmap.dx; g->dy = bitmap.dy; g->present = true;
      /* One byte a pixel, which is the whole reason the seam grew a coverage format. */
      re_seam_texture_update(b->seam, b->atlas, g->ax, g->ay, g->w, g->h, bitmap.pixels);
      break;
    }
    flush(b); atlas_reset(b); /* the atlas is full: repack from scratch and retry once */
  }
  if (raster) re_font_glyph_free(&bitmap);
  return g;
}

static void draw_text(SeamBackend *b, ReColor color, uint8_t face, int size, int x, int y, const char *s, const char *end) {
  ReFontMetrics m = re_font_metrics(b->base.fonts, face, size, b->density);
  float d = b->density, base = (float)(y + m.ascent + 2) * d;
  ReTextPen pen = re_font_pen(b->base.fonts, face, size, d, x);
  bind(b, 0);
  while (*s && s < end) {
    uint32_t cp = re_utf8(&s); Glyph *g = glyph(b, face, (int16_t)size, cp);
    if (g->present) {
      float gx = re_font_pen_x(&pen) + (float)g->dx, gy = base + (float)g->dy, radii[4] = {0, 0, 0, 0};
      emit(b, gx, gy, gx + (float)g->w, gy + (float)g->h, (float)g->ax / ATLAS_SIZE, (float)g->ay / ATLAS_SIZE,
           (float)(g->ax + g->w) / ATLAS_SIZE, (float)(g->ay + g->h) / ATLAS_SIZE, color, 0, 0, 0, 0, radii, 0, MODE_COVERAGE);
    }
    re_font_pen_step(&pen, cp);
  }
}

static void set_clip(SeamBackend *b, const ReCommand *c) {
  flush(b);
  if (c->flags & RE_CLIP_RESET) { re_seam_scissor(b->seam, 0, 0, -1, -1); return; }
  int w = c->rect.w > 0 ? c->rect.w : 0, h = c->rect.h > 0 ? c->rect.h : 0;
  /* The draw list's rectangles already put row 0 at the top, and so does the seam — so this is a
     scale and nothing else. It was backend_gl.c's bottom-left expression until the Metal copy drew
     every pane upside down and showed that the three backends had never agreed (spec 124). */
  re_seam_scissor(b->seam, (int)((float)c->rect.x * b->density),
                  (int)((float)c->rect.y * b->density),
                  (int)((float)w * b->density), (int)((float)h * b->density));
}

/* ---- the adapter interface -------------------------------------------------------------------- */

static float density(ReBackend *backend, int logical_width) {
  SeamBackend *b = (SeamBackend *)backend; int dw, dh;
  re_seam_host_size(b->host, &dw, &dh);
  return (float)dw / (logical_width > 1 ? logical_width : 1);
}

static bool begin(ReBackend *backend, const ReDrawList *list) {
  SeamBackend *b = (SeamBackend *)backend;
  b->target = re_seam_host_acquire(b->host);
  if (!b->target.width) return false;      /* no image this frame: a resize in flight, usually */
  re_seam_host_size(b->host, &b->dw, &b->dh);
  if (list->density != b->density) { b->density = list->density; atlas_reset(b); }
  re_seam_frame_begin(b->seam, b->target);
  b->in_frame = true;
  re_seam_viewport(b->seam, 0, 0, b->dw, b->dh);
  re_seam_scissor(b->seam, 0, 0, -1, -1);
  /* The alpha channel composites rather than multiplying by its own coverage, which is what the
     draw list has always asked GL for and what the seam could not say until F133. */
  re_seam_blend_separate(b->seam, RE_SEAM_BLEND_ALPHA, RE_SEAM_BLEND_PREMULTIPLIED);
  re_seam_depth(b->seam, RE_SEAM_DEPTH_TEST_DISABLED, RE_SEAM_DEPTH_WRITE_DISABLED);
  re_seam_cull(b->seam, RE_SEAM_CULL_NONE);
  re_seam_clear(b->seam, (float)list->clear.r / 255, (float)list->clear.g / 255,
                (float)list->clear.b / 255, (float)list->clear.a / 255, false);
  re_seam_program_use(b->seam, b->program);
  re_seam_uniform_vec4(b->seam, b->u_size, (float)b->dw, (float)b->dh, 0.0f, 0.0f);
  re_seam_uniform_int(b->seam, b->u_texture, 0);
  b->count = 0; b->bound = 0;
  return true;
}

static void execute(ReBackend *backend, const ReDrawList *list) {
  SeamBackend *b = (SeamBackend *)backend; static const float none[4] = {0, 0, 0, 0};
  for (size_t i = 0; i < list->count; i++) {
    const ReCommand *c = &list->commands[i]; float d = b->density;
    switch (c->type) {
      case RE_CMD_CLIP: set_clip(b, c); break;
      case RE_CMD_RECT: bind(b, 0); shape(b, c->rect, c->color, 0, 0, 0, MODE_SOLID, 0); break;
      case RE_CMD_RRECT: bind(b, 0); shape(b, c->rect, c->color, c->radius, c->corners, 0, c->radius > 0 && c->corners ? MODE_FILL : MODE_SOLID, 0); break;
      case RE_CMD_GRADIENT: bind(b, 0); gradient(b, c); break;
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
        char glyph_bytes[5]; int size = c->size > 0 ? c->size : 16;
        int length = re_encode(re_icon_codepoints[c->icon < RE_ICON_COUNT ? c->icon : RE_ICON_UNKNOWN], glyph_bytes);
        ReFontMetrics m = re_font_metrics(b->base.fonts, RE_FACE_ICON, size, d);
        int width = re_font_text_width(b->base.fonts, RE_FACE_ICON, size, d, glyph_bytes, length);
        draw_text(b, c->color, RE_FACE_ICON, size, c->rect.x + (c->rect.w - width) / 2,
                  c->rect.y + (c->rect.h - m.line_height) / 2, glyph_bytes, glyph_bytes + length);
        break;
      }
      case RE_CMD_TEXTURE: {
        SeamTexture *t = (SeamTexture *)c->texture; if (!t) break;
        bind(b, t->texture.id); bool flip = (c->flags & RE_DRAW_FLIP_Y) != 0;
        emit(b, (float)c->rect.x * d, (float)c->rect.y * d, (float)(c->rect.x + c->rect.w) * d, (float)(c->rect.y + c->rect.h) * d,
             0, flip ? 1.0f : 0.0f, 1, flip ? 0.0f : 1.0f, re_color(255, 255, 255, 255), 0, 0, 0, 0, none, 0, MODE_RGBA);
        break;
      }
      default: break;
    }
  }
  flush(b);
  re_seam_scissor(b->seam, 0, 0, -1, -1);
  re_seam_frame_end(b->seam);
  b->in_frame = false;
}

static void present(ReBackend *backend) { re_seam_host_present(((SeamBackend *)backend)->host); }
/* For the plugin render extension (charter D55): the seam a plugin's table is called with has to be
   this backend's, or the calls would land on a seam from another copy. */
ReSeam *re_backend_seam_seam(ReBackend *backend) { return backend ? ((SeamBackend *)backend)->seam : NULL; }
static bool snapshot(ReBackend *backend, const char *path) { return re_seam_host_snapshot(((SeamBackend *)backend)->host, path); }

static ReTexture *texture_create(ReBackend *backend, int width, int height) {
  SeamBackend *b = (SeamBackend *)backend;
  SeamTexture *t = calloc(1, sizeof(*t)); if (!t) return NULL;
  t->texture = re_seam_texture_2d(b->seam, NULL, width, height, RE_SEAM_FILTER_NEAREST, RE_SEAM_WRAP_CLAMP_TO_EDGE);
  if (!t->texture.id) { free(t); return NULL; }
  t->base.owner = backend; t->base.width = width; t->base.height = height;
  return &t->base;
}
/* A texture the caller owns, wrapped so the draw list can sample it (charter D55). */
static ReTexture *texture_adopt(ReBackend *backend, uint32_t seam_texture, int width, int height) {
  SeamTexture *t = calloc(1, sizeof(*t)); if (!t || !seam_texture) { free(t); return NULL; }
  t->texture = (ReSeamTexture){seam_texture, width, height}; t->adopted = true;
  t->base.owner = backend; t->base.width = width; t->base.height = height;
  return &t->base;
}
static bool texture_update(ReTexture *texture, const void *rgba, int pitch) {
  SeamTexture *t = (SeamTexture *)texture;
  if (!t || pitch != texture->width * 4) return false;
  SeamBackend *b = (SeamBackend *)texture->owner;
  re_seam_texture_update(b->seam, t->texture, 0, 0, texture->width, texture->height, rgba);
  return true;
}
static void texture_destroy(ReTexture *texture) {
  SeamTexture *t = (SeamTexture *)texture; if (!t) return;
  SeamBackend *b = (SeamBackend *)texture->owner;
  if (b && !t->adopted) re_seam_texture_destroy(b->seam, &t->texture);
  free(t);
}

static void close_backend(ReBackend *backend) {
  SeamBackend *b = (SeamBackend *)backend; if (!b) return;
  if (b->seam) {
    re_seam_texture_destroy(b->seam, &b->atlas);
    re_seam_vertex_array_destroy(b->seam, &b->array);
    re_seam_buffer_destroy(b->seam, &b->buffer);
    re_seam_program_destroy(b->seam, &b->program);
  }
  re_seam_host_close(b->host);
  free(b->vertices);
  free(b);
}

/* Each copy reports the --renderer value that selected it -- which is just its host's name, now that
   the hand-written backends are gone and these ARE opengl, vulkan and metal. This file is compiled
   once per graphics API and cannot be told apart any other way. */
/* Not const, because the name is the one field a compiled-once-per-API file cannot write down: it
   comes from whichever seam_host_*.c this copy was linked against. Every open in a copy writes the
   same value. */
static ReBackendOps ops = {NULL, density, begin, execute, present, snapshot,
                                 texture_create, texture_adopt, texture_update, texture_destroy, close_backend};

uint32_t re_backend_seam_window_flags(void) { return re_seam_host_flags(); }

ReBackend *re_backend_seam_open(void *window, ReFontSet *fonts) {
  SeamBackend *b = calloc(1, sizeof(*b)); if (!b) return NULL;
  b->window = window; b->base.ops = &ops; b->base.fonts = fonts; b->density = 1.0f;
  ops.name = re_seam_host_name();
  char error[256] = {0};
  b->host = re_seam_host_open(window, error, sizeof(error));
  if (!b->host) { re_seam_host_fail(error); close_backend(&b->base); return NULL; }
  b->seam = re_seam_host_seam(b->host);

  ReSeamShader vertex = {0}, fragment = {0};
  vertex.glsl = re_ui_vertex_glsl; vertex.spirv = re_ui_vertex_spv; vertex.spirv_bytes = sizeof(re_ui_vertex_spv);
  vertex.msl = re_ui_vertex_msl; vertex.glsl_es = re_ui_vertex_glsl_es;
  fragment.glsl = re_ui_fragment_glsl; fragment.spirv = re_ui_fragment_spv; fragment.spirv_bytes = sizeof(re_ui_fragment_spv);
  fragment.msl = re_ui_fragment_msl; fragment.glsl_es = re_ui_fragment_glsl_es;
  b->program = re_seam_program(b->seam, &vertex, &fragment, "ui");
  if (!b->program.id) { close_backend(&b->base); return NULL; }
  b->u_size = re_seam_uniform_location(b->seam, b->program, "u_size");
  b->u_texture = re_seam_uniform_location(b->seam, b->program, "u_texture");
  if (b->u_size < 0 || b->u_texture < 0) {
    re_seam_host_fail("the draw-list shader does not expose u_size and u_texture");
    close_backend(&b->base); return NULL;
  }

  b->vertices = malloc(sizeof(Vertex) * BATCH_VERTICES);
  if (!b->vertices) { re_seam_host_fail("Cannot allocate the vertex batch"); close_backend(&b->base); return NULL; }
  b->buffer = re_seam_buffer(b->seam);
  re_seam_buffer_update(b->seam, b->buffer, NULL, sizeof(Vertex) * BATCH_VERTICES, RE_SEAM_BUFFER_DYNAMIC);
  const ReSeamVertexAttribute attributes[6] = {
    {0, 2, offsetof(Vertex, x), RE_SEAM_ATTRIBUTE_FLOAT},
    {1, 2, offsetof(Vertex, u), RE_SEAM_ATTRIBUTE_FLOAT},
    {2, 4, offsetof(Vertex, r), RE_SEAM_ATTRIBUTE_UNORM8},
    {3, 4, offsetof(Vertex, cx), RE_SEAM_ATTRIBUTE_FLOAT},
    {4, 4, offsetof(Vertex, r0), RE_SEAM_ATTRIBUTE_FLOAT},
    {5, 2, offsetof(Vertex, w), RE_SEAM_ATTRIBUTE_FLOAT},
  };
  const ReSeamVertexLayout layout = {attributes, 6, sizeof(Vertex)};
  b->array = re_seam_vertex_array(b->seam, b->buffer, &layout);

  b->atlas = re_seam_texture_2d_for(b->seam, NULL, ATLAS_SIZE, ATLAS_SIZE, RE_SEAM_FILTER_NEAREST,
                                    RE_SEAM_WRAP_CLAMP_TO_EDGE, RE_SEAM_TEXTURE_COVERAGE);
  if (!b->atlas.id) { re_seam_host_fail("Cannot allocate the glyph atlas"); close_backend(&b->base); return NULL; }
  atlas_reset(b);
  return &b->base;
}
