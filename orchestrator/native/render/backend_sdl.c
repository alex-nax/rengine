#include "render/backend_sdl.h"
#include "render/utf8.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

#define GLYPH_SLOTS 4096
typedef struct { uint32_t codepoint; uint8_t face; int16_t size; SDL_Texture *texture; int w, h, dx, dy; bool used; } Glyph;
typedef struct { ReTexture base; SDL_Texture *texture; } SdlTexture;
typedef struct { ReBackend base; SDL_Renderer *renderer; float density; Glyph glyphs[GLYPH_SLOTS]; } SdlBackend;

static void set_color(SdlBackend *b, ReColor c) { SDL_SetRenderDrawColor(b->renderer, c.r, c.g, c.b, c.a); }
static SDL_Rect sdl_rect(ReRect r) { SDL_Rect s = {r.x, r.y, r.w, r.h}; return s; }

static void purge_glyphs(SdlBackend *b) {
  for (int i = 0; i < GLYPH_SLOTS; i++) { if (b->glyphs[i].texture) SDL_DestroyTexture(b->glyphs[i].texture); memset(&b->glyphs[i], 0, sizeof(Glyph)); }
}
static Glyph *glyph(SdlBackend *b, uint8_t face, int16_t size, uint32_t codepoint) {
  Glyph *g = &b->glyphs[(codepoint * 31u + face * 7919u + (uint32_t)size * 131u) % GLYPH_SLOTS];
  if (g->used && g->codepoint == codepoint && g->face == face && g->size == size) return g;
  if (g->texture) SDL_DestroyTexture(g->texture);
  memset(g, 0, sizeof(*g)); g->codepoint = codepoint; g->face = face; g->size = size; g->used = true;
  ReGlyphBitmap bitmap;
  if (!re_font_glyph(b->base.fonts, face, size, b->density, codepoint, &bitmap) || !bitmap.w || !bitmap.h) { re_font_glyph_free(&bitmap); return g; }
  g->w = bitmap.w; g->h = bitmap.h; g->dx = bitmap.dx; g->dy = bitmap.dy;
  SDL_Surface *s = SDL_CreateRGBSurfaceWithFormat(0, g->w, g->h, 32, SDL_PIXELFORMAT_RGBA32);
  if (s) {
    for (int y = 0; y < g->h; y++) for (int x = 0; x < g->w; x++) {
      uint8_t *p = (uint8_t *)s->pixels + y * s->pitch + x * 4;
      p[0] = p[1] = p[2] = 255; p[3] = bitmap.pixels[y * g->w + x];
    }
    g->texture = SDL_CreateTextureFromSurface(b->renderer, s); SDL_FreeSurface(s);
    if (g->texture) SDL_SetTextureBlendMode(g->texture, SDL_BLENDMODE_BLEND);
  }
  re_font_glyph_free(&bitmap); return g;
}

/* Text runs reproduce the previous immediate-mode placement exactly — see sidecar: reference-identity */
static void draw_text(SdlBackend *b, ReColor color, uint8_t face, int size, int x, int y, const char *s, const char *end) {
  ReFontMetrics m = re_font_metrics(b->base.fonts, face, size, b->density);
  ReTextPen pen = re_font_pen(b->base.fonts, face, size, b->density, x);
  while (*s && s < end) {
    uint32_t cp = re_utf8(&s); Glyph *g = glyph(b, face, (int16_t)size, cp);
    if (g->texture) {
      SDL_FRect target = {re_font_pen_x(&pen) / b->density + g->dx / b->density, y + m.ascent + g->dy / b->density + 2, g->w / b->density, g->h / b->density};
      SDL_SetTextureColorMod(g->texture, color.r, color.g, color.b);
      SDL_SetTextureAlphaMod(g->texture, color.a); SDL_RenderCopyF(b->renderer, g->texture, NULL, &target);
    }
    re_font_pen_step(&pen, cp);
  }
}

/* Rounded shapes are per-row spans: a reference for the GPU adapters, not an anti-aliased result. */
static int corner_inset(int radius, int row) {
  float t = (float)radius - ((float)row + 0.5f), v = (float)radius * (float)radius - t * t;
  return v <= 0 ? radius : (int)((float)radius - sqrtf(v) + 0.5f);
}
static int clamp_radius(ReRect r, float radius) {
  int rad = (int)radius;
  if (rad > r.w / 2) rad = r.w / 2;
  if (rad > r.h / 2) rad = r.h / 2;
  return rad < 0 ? 0 : rad;
}
static void span(SdlBackend *b, int x, int y, int w, int h) { if (w > 0 && h > 0) { SDL_Rect s = {x, y, w, h}; SDL_RenderFillRect(b->renderer, &s); } }
static void fill_rrect(SdlBackend *b, ReRect r, ReColor c, float radius, uint8_t corners) {
  set_color(b, c); int rad = clamp_radius(r, radius);
  if (rad <= 0 || !corners) { span(b, r.x, r.y, r.w, r.h); return; }
  for (int i = 0; i < rad; i++) {
    int li = corners & RE_CORNER_TOP_LEFT ? corner_inset(rad, i) : 0, ri = corners & RE_CORNER_TOP_RIGHT ? corner_inset(rad, i) : 0;
    span(b, r.x + li, r.y + i, r.w - li - ri, 1);
    int bl = corners & RE_CORNER_BOTTOM_LEFT ? corner_inset(rad, i) : 0, br = corners & RE_CORNER_BOTTOM_RIGHT ? corner_inset(rad, i) : 0;
    span(b, r.x + bl, r.y + r.h - 1 - i, r.w - bl - br, 1);
  }
  span(b, r.x, r.y + rad, r.w, r.h - 2 * rad);
}
static void outline_rrect(SdlBackend *b, ReRect r, ReColor c, float radius, uint8_t corners) {
  set_color(b, c); int rad = clamp_radius(r, radius);
  if (r.w <= 0 || r.h <= 0) return;
  if (rad <= 0 || !corners) { SDL_Rect s = sdl_rect(r); SDL_RenderDrawRect(b->renderer, &s); return; }
  for (int i = 0; i < rad; i++) {
    int lo = corners & RE_CORNER_TOP_LEFT ? corner_inset(rad, i) : 0, ro = corners & RE_CORNER_TOP_RIGHT ? corner_inset(rad, i) : 0;
    int lp = i ? (corners & RE_CORNER_TOP_LEFT ? corner_inset(rad, i - 1) : 0) : r.w - ro, rp = i ? (corners & RE_CORNER_TOP_RIGHT ? corner_inset(rad, i - 1) : 0) : 0;
    if (i == 0) span(b, r.x + lo, r.y, r.w - lo - ro, 1);
    else { span(b, r.x + lo, r.y + i, lp > lo ? lp - lo : 1, 1); span(b, r.x + r.w - (rp > ro ? rp : ro + 1), r.y + i, rp > ro ? rp - ro : 1, 1); }
    int bl = corners & RE_CORNER_BOTTOM_LEFT ? corner_inset(rad, i) : 0, br = corners & RE_CORNER_BOTTOM_RIGHT ? corner_inset(rad, i) : 0;
    int blp = i ? (corners & RE_CORNER_BOTTOM_LEFT ? corner_inset(rad, i - 1) : 0) : 0, brp = i ? (corners & RE_CORNER_BOTTOM_RIGHT ? corner_inset(rad, i - 1) : 0) : 0;
    if (i == 0) span(b, r.x + bl, r.y + r.h - 1, r.w - bl - br, 1);
    else { span(b, r.x + bl, r.y + r.h - 1 - i, blp > bl ? blp - bl : 1, 1); span(b, r.x + r.w - (brp > br ? brp : br + 1), r.y + r.h - 1 - i, brp > br ? brp - br : 1, 1); }
  }
  span(b, r.x, r.y + rad, 1, r.h - 2 * rad); span(b, r.x + r.w - 1, r.y + rad, 1, r.h - 2 * rad);
}
static void draw_icon(SdlBackend *b, const ReCommand *c) {
  char glyph[5]; int size = c->size > 0 ? c->size : 16;
  int length = re_encode(re_icon_codepoints[c->icon < RE_ICON_COUNT ? c->icon : RE_ICON_UNKNOWN], glyph);
  ReFontMetrics m = re_font_metrics(b->base.fonts, RE_FACE_ICON, size, b->density);
  int width = re_font_text_width(b->base.fonts, RE_FACE_ICON, size, b->density, glyph, length);
  draw_text(b, c->color, RE_FACE_ICON, size, c->rect.x + (c->rect.w - width) / 2, c->rect.y + (c->rect.h - m.line_height) / 2, glyph, glyph + length);
}

static float density(ReBackend *backend, int logical_width) {
  SdlBackend *b = (SdlBackend *)backend; int dw, dh;
  SDL_GetRendererOutputSize(b->renderer, &dw, &dh);
  return (float)dw / (logical_width > 1 ? logical_width : 1);
}
static bool begin(ReBackend *backend, const ReDrawList *list) {
  SdlBackend *b = (SdlBackend *)backend;
  if (list->density != b->density) { purge_glyphs(b); b->density = list->density; }
  SDL_RenderSetLogicalSize(b->renderer, list->width, list->height);
  SDL_RenderSetClipRect(b->renderer, NULL);
  set_color(b, list->clear); SDL_RenderClear(b->renderer);
  return true;
}
static void execute(ReBackend *backend, const ReDrawList *list) {
  SdlBackend *b = (SdlBackend *)backend;
  for (size_t i = 0; i < list->count; i++) {
    const ReCommand *c = &list->commands[i];
    switch (c->type) {
      case RE_CMD_CLIP:
        if (c->flags & RE_CLIP_RESET) SDL_RenderSetClipRect(b->renderer, NULL);
        else { SDL_Rect rect = {c->rect.x, c->rect.y, c->rect.w > 0 ? c->rect.w : 0, c->rect.h > 0 ? c->rect.h : 0}; SDL_RenderSetClipRect(b->renderer, &rect); }
        break;
      case RE_CMD_RECT: { SDL_Rect rect = sdl_rect(c->rect); set_color(b, c->color); SDL_RenderFillRect(b->renderer, &rect); break; }
      case RE_CMD_RRECT: fill_rrect(b, c->rect, c->color, c->radius, c->corners); break;
      case RE_CMD_FRAME: {
        outline_rrect(b, c->rect, c->color, c->radius, c->corners);
        int rad = clamp_radius(c->rect, c->radius);
        if (c->secondary.a) { set_color(b, c->secondary); span(b, c->rect.x + 1 + rad, c->rect.y + 1, c->rect.w - 2 - 2 * rad, 1); }
        break;
      }
      case RE_CMD_SHADOW:
        for (int k = c->width; k >= 1; k--) {
          ReColor layer = c->color; layer.a = (uint8_t)(c->color.a / c->width);
          fill_rrect(b, re_rect(c->rect.x - k, c->rect.y - k, c->rect.w + 2 * k, c->rect.h + 2 * k), layer, c->radius + (float)k, RE_CORNERS_ALL);
        }
        break;
      case RE_CMD_RING:
        for (int k = 1; k <= c->width; k++) outline_rrect(b, re_rect(c->rect.x - k, c->rect.y - k, c->rect.w + 2 * k, c->rect.h + 2 * k), c->color, c->radius + (float)k, RE_CORNERS_ALL);
        break;
      case RE_CMD_TEXT: {
        const char *s = re_draw_list_string(list, c);
        draw_text(b, c->color, c->face, c->size > 0 ? c->size : 16, c->rect.x, c->rect.y, s, s + c->text_length); break;
      }
      case RE_CMD_ICON: draw_icon(b, c); break;
      case RE_CMD_TEXTURE: {
        SdlTexture *t = (SdlTexture *)c->texture; SDL_Rect dest = sdl_rect(c->rect);
        if (t && t->texture) SDL_RenderCopyEx(b->renderer, t->texture, NULL, &dest, 0, NULL, c->flags & RE_DRAW_FLIP_Y ? SDL_FLIP_VERTICAL : SDL_FLIP_NONE);
        break;
      }
      default: break;
    }
  }
  SDL_RenderFlush(b->renderer); /* submit queued commands so execute measures the same work as the GPU adapters */
}
static void present(ReBackend *backend) { SDL_RenderPresent(((SdlBackend *)backend)->renderer); }
static bool snapshot(ReBackend *backend, const char *path) {
  SdlBackend *b = (SdlBackend *)backend; int w, h; SDL_GetRendererOutputSize(b->renderer, &w, &h);
  SDL_Surface *s = SDL_CreateRGBSurfaceWithFormat(0, w, h, 32, SDL_PIXELFORMAT_RGBA32);
  if (!s) return false;
  bool ok = SDL_RenderReadPixels(b->renderer, NULL, s->format->format, s->pixels, s->pitch) == 0 && SDL_SaveBMP(s, path) == 0;
  SDL_FreeSurface(s); return ok;
}
static ReTexture *texture_create(ReBackend *backend, int width, int height) {
  SdlBackend *b = (SdlBackend *)backend;
  SdlTexture *t = calloc(1, sizeof(*t)); if (!t) return NULL;
  t->texture = SDL_CreateTexture(b->renderer, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STREAMING, width, height);
  if (!t->texture) { free(t); return NULL; }
  t->base.owner = backend; t->base.width = width; t->base.height = height; return &t->base;
}
static bool texture_update(ReTexture *texture, const void *rgba, int pitch) {
  SdlTexture *t = (SdlTexture *)texture; return t && t->texture && SDL_UpdateTexture(t->texture, NULL, rgba, pitch) == 0;
}
static void texture_destroy(ReTexture *texture) {
  SdlTexture *t = (SdlTexture *)texture; if (!t) return;
  if (t->texture) SDL_DestroyTexture(t->texture); free(t);
}
static void close_backend(ReBackend *backend) {
  SdlBackend *b = (SdlBackend *)backend; if (!b) return;
  purge_glyphs(b); SDL_DestroyRenderer(b->renderer); free(b);
}
static const ReBackendOps ops = {"sdl", density, begin, execute, present, snapshot, texture_create, texture_update, texture_destroy, close_backend};

ReBackend *re_backend_sdl_open(SDL_Window *window, ReFontSet *fonts) {
  SdlBackend *b = calloc(1, sizeof(*b)); if (!b) return NULL;
  b->renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC);
  if (!b->renderer) b->renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE);
  if (!b->renderer) { free(b); return NULL; }
  SDL_SetRenderDrawBlendMode(b->renderer, SDL_BLENDMODE_BLEND);
  b->base.ops = &ops; b->base.fonts = fonts; b->density = 1.0f; return &b->base;
}
