#include "draw.h"
#define STB_TRUETYPE_IMPLEMENTATION
#include "stb_truetype.h"

#define GLYPH_COUNT 2048
typedef struct { uint32_t cp; SDL_Texture *texture; int w, h, dx, dy; bool used; } Glyph;
struct ReDraw {
  SDL_Renderer *renderer;
  unsigned char *font_bytes;
  stbtt_fontinfo font;
  float scale, density;
  int ascent, cell_width, line_height;
  Glyph glyphs[GLYPH_COUNT];
};

uint32_t re_utf8(const char **text) {
  const unsigned char *s = (const unsigned char *)*text;
  if (!*s) return 0;
  uint32_t c = *s++; int count = 0;
  if (c >= 0xc2 && c < 0xe0) { c &= 31; count = 1; }
  else if (c >= 0xe0 && c < 0xf0) { c &= 15; count = 2; }
  else if (c >= 0xf0 && c < 0xf5) { c &= 7; count = 3; }
  else if (c >= 128) { *text = (const char *)s; return 0xfffd; }
  int bytes = count;
  while (count--) {
    if ((*s & 0xc0) != 0x80) { *text = (const char *)s; return 0xfffd; }
    c = (c << 6) | (*s++ & 63);
  }
  *text = (const char *)s;
  if ((bytes == 1 && c < 128) || (bytes == 2 && c < 2048) ||
      (bytes == 3 && c < 65536) || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) return 0xfffd;
  return c;
}

int re_encode(uint32_t c, char b[5]) {
  int n;
  if (c < 128) { b[0] = (char)c; n = 1; }
  else if (c < 2048) { b[0] = (char)(0xc0 | (c >> 6)); b[1] = (char)(0x80 | (c & 63)); n = 2; }
  else if (c < 65536) { b[0] = (char)(0xe0 | (c >> 12)); b[1] = (char)(0x80 | ((c >> 6) & 63)); b[2] = (char)(0x80 | (c & 63)); n = 3; }
  else { b[0] = (char)(0xf0 | (c >> 18)); b[1] = (char)(0x80 | ((c >> 12) & 63)); b[2] = (char)(0x80 | ((c >> 6) & 63)); b[3] = (char)(0x80 | (c & 63)); n = 4; }
  b[n] = 0; return n;
}

static int text_width(mu_Font font, const char *s, int length) {
  ReDraw *d = font; int count = 0;
  const char *end = s + (length < 0 ? strlen(s) : (size_t)length);
  while (*s && s < end) { re_utf8(&s); count++; }
  return count * d->cell_width;
}
static int text_height(mu_Font font) { return ((ReDraw *)font)->line_height; }

ReDraw *re_draw_open(SDL_Window *window, const char *font_path) {
  ReDraw *d = calloc(1, sizeof(*d));
  if (!d) return NULL;
  d->renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC);
  if (!d->renderer) d->renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE);
  if (!d->renderer) { free(d); return NULL; }
  const char *candidates[] = { font_path, getenv("RENGINE_FONT"),
#ifdef __APPLE__
    "/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/SFNSMono.ttf",
#elif defined(_WIN32)
    "C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/cour.ttf",
#else
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
#endif
  };
  for (int i = 0; i < RE_ARRAY_SIZE(candidates); i++) {
    if (!candidates[i] || !*candidates[i]) continue;
    size_t length = 0;
    d->font_bytes = SDL_LoadFile(candidates[i], &length);
    if (!d->font_bytes) continue;
    if (length >= 16 && length < 32 * 1024 * 1024 &&
        stbtt_InitFont(&d->font, d->font_bytes, stbtt_GetFontOffsetForIndex(d->font_bytes, 0))) break;
    SDL_free(d->font_bytes); d->font_bytes = NULL;
  }
  if (!d->font_bytes) { SDL_SetError("Set RENGINE_FONT to a trusted local monospace TTF/TTC font."); re_draw_close(d); return NULL; }
  int ascent, descent, gap, advance, bearing;
  stbtt_GetFontVMetrics(&d->font, &ascent, &descent, &gap);
  int drawable_width, drawable_height, window_width, window_height;
  SDL_GetRendererOutputSize(d->renderer, &drawable_width, &drawable_height); SDL_GetWindowSize(window, &window_width, &window_height);
  d->density = (float)drawable_width / re_max(1, window_width);
  d->scale = stbtt_ScaleForPixelHeight(&d->font, 16.0f * d->density);
  d->ascent = (int)(ascent * d->scale / d->density + 0.5f);
  d->line_height = 20;
  stbtt_GetCodepointHMetrics(&d->font, 'M', &advance, &bearing);
  d->cell_width = (int)(advance * d->scale / d->density + 0.5f);
  SDL_SetRenderDrawBlendMode(d->renderer, SDL_BLENDMODE_BLEND);
  return d;
}

void re_draw_close(ReDraw *d) {
  if (!d) return;
  for (int i = 0; i < GLYPH_COUNT; i++) if (d->glyphs[i].texture) SDL_DestroyTexture(d->glyphs[i].texture);
  SDL_free(d->font_bytes); SDL_DestroyRenderer(d->renderer); free(d);
}
void re_draw_bind(ReDraw *d, mu_Context *ui) {
  mu_init(ui); ui->text_width = text_width; ui->text_height = text_height; ui->style->font = d;
  ui->style->size.y = d->line_height;
  ui->style->colors[MU_COLOR_WINDOWBG] = mu_color(20, 24, 30, 255);
  ui->style->colors[MU_COLOR_BUTTON] = mu_color(38, 46, 56, 255);
  ui->style->colors[MU_COLOR_BUTTONHOVER] = mu_color(52, 68, 78, 255);
  ui->style->colors[MU_COLOR_BUTTONFOCUS] = mu_color(59, 86, 86, 255);
  ui->style->colors[MU_COLOR_TEXT] = mu_color(220, 228, 234, 255);
}
void re_draw_begin(ReDraw *d, int w, int h) {
  int dw, dh; SDL_GetRendererOutputSize(d->renderer, &dw, &dh);
  float density = (float)dw / re_max(1, w);
  if (density != d->density) {
    for (int i = 0; i < GLYPH_COUNT; i++) { if (d->glyphs[i].texture) SDL_DestroyTexture(d->glyphs[i].texture); memset(&d->glyphs[i], 0, sizeof(Glyph)); }
    d->density = density; d->scale = stbtt_ScaleForPixelHeight(&d->font, 16.0f * density);
  }
  SDL_RenderSetLogicalSize(d->renderer, w, h);
  SDL_RenderSetClipRect(d->renderer, NULL);
  SDL_SetRenderDrawColor(d->renderer, 14, 18, 23, 255); SDL_RenderClear(d->renderer);
}
void re_draw_rect(ReDraw *d, mu_Rect r, mu_Color c) {
  SDL_Rect rect = {r.x, r.y, r.w, r.h};
  SDL_SetRenderDrawColor(d->renderer, c.r, c.g, c.b, c.a); SDL_RenderFillRect(d->renderer, &rect);
}
void re_draw_clip(ReDraw *d, const mu_Rect *r) {
  if (!r) SDL_RenderSetClipRect(d->renderer, NULL);
  else { SDL_Rect rect = {r->x, r->y, re_max(0, r->w), re_max(0, r->h)}; SDL_RenderSetClipRect(d->renderer, &rect); }
}
static Glyph *glyph(ReDraw *d, uint32_t cp) {
  Glyph *g = &d->glyphs[cp % GLYPH_COUNT];
  if (g->used && g->cp == cp) return g;
  if (g->texture) SDL_DestroyTexture(g->texture);
  memset(g, 0, sizeof(*g)); g->cp = cp; g->used = true;
  unsigned char *pixels = stbtt_GetCodepointBitmap(&d->font, 0, d->scale, (int)cp, &g->w, &g->h, &g->dx, &g->dy);
  if (!pixels || !g->w || !g->h) { stbtt_FreeBitmap(pixels, NULL); return g; }
  SDL_Surface *s = SDL_CreateRGBSurfaceWithFormat(0, g->w, g->h, 32, SDL_PIXELFORMAT_RGBA32);
  if (s) {
    for (int y = 0; y < g->h; y++) for (int x = 0; x < g->w; x++) {
      uint8_t *p = (uint8_t *)s->pixels + y * s->pitch + x * 4;
      p[0] = p[1] = p[2] = 255; p[3] = pixels[y * g->w + x];
    }
    g->texture = SDL_CreateTextureFromSurface(d->renderer, s); SDL_FreeSurface(s);
    if (g->texture) SDL_SetTextureBlendMode(g->texture, SDL_BLENDMODE_BLEND);
  }
  stbtt_FreeBitmap(pixels, NULL); return g;
}
void re_draw_text(ReDraw *d, const char *s, int length, int x, int y, mu_Color color) {
  const char *end = s + (length < 0 ? strlen(s) : (size_t)length);
  while (*s && s < end) {
    uint32_t cp = re_utf8(&s); Glyph *g = glyph(d, cp);
    if (g->texture) {
      SDL_FRect target = {x + g->dx / d->density, y + d->ascent + g->dy / d->density + 2,
                         g->w / d->density, g->h / d->density};
      SDL_SetTextureColorMod(g->texture, color.r, color.g, color.b);
      SDL_SetTextureAlphaMod(g->texture, color.a); SDL_RenderCopyF(d->renderer, g->texture, NULL, &target);
    }
    x += d->cell_width;
  }
}
void re_draw_commands(ReDraw *d, mu_Context *ui) {
  mu_Command *cmd = NULL;
  while (mu_next_command(ui, &cmd)) {
    if (cmd->type == MU_COMMAND_RECT) re_draw_rect(d, cmd->rect.rect, cmd->rect.color);
    else if (cmd->type == MU_COMMAND_CLIP) re_draw_clip(d, &cmd->clip.rect);
    else if (cmd->type == MU_COMMAND_TEXT) re_draw_text(d, cmd->text.str, -1, cmd->text.pos.x, cmd->text.pos.y, cmd->text.color);
    else if (cmd->type == MU_COMMAND_ICON) {
      const char *icons[] = {"?", "x", "+", ">", "v"};
      int id = cmd->icon.id; const char *s = id >= 0 && id < RE_ARRAY_SIZE(icons) ? icons[id] : "?";
      re_draw_text(d, s, -1, cmd->icon.rect.x + (cmd->icon.rect.w - d->cell_width) / 2,
                   cmd->icon.rect.y + (cmd->icon.rect.h - d->line_height) / 2, cmd->icon.color);
    }
  }
  re_draw_clip(d, NULL);
}
void re_draw_end(ReDraw *d) { SDL_RenderPresent(d->renderer); }
int re_draw_cell_width(const ReDraw *d) { return d->cell_width; }
int re_draw_line_height(const ReDraw *d) { return d->line_height; }
SDL_Renderer *re_draw_renderer(ReDraw *d) { return d->renderer; }
bool re_draw_snapshot(ReDraw *d, const char *path) {
  int w, h; SDL_GetRendererOutputSize(d->renderer, &w, &h);
  SDL_Surface *s = SDL_CreateRGBSurfaceWithFormat(0, w, h, 32, SDL_PIXELFORMAT_RGBA32);
  if (!s) return false;
  bool ok = SDL_RenderReadPixels(d->renderer, NULL, s->format->format, s->pixels, s->pitch) == 0 && SDL_SaveBMP(s, path) == 0;
  SDL_FreeSurface(s); return ok;
}
