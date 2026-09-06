#define STB_TRUETYPE_IMPLEMENTATION
#include "stb_truetype.h"
#include "render/font.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { unsigned char *bytes; stbtt_fontinfo info; int ascent, descent, gap; } Face;
struct ReFontSet { Face faces[RE_FACE_COUNT]; bool owned[RE_FACE_COUNT]; };
static char error_text[160];

const char *re_font_error(void) { return error_text; }

/* trusted local fonts only — see sidecar: trusted-fonts */
static bool load(Face *face, const char *path) {
  if (!path || !*path) return false;
  FILE *file = fopen(path, "rb"); if (!file) return false;
  if (fseek(file, 0, SEEK_END) != 0) { fclose(file); return false; }
  long size = ftell(file);
  if (size < 16 || size >= 32L * 1024 * 1024 || fseek(file, 0, SEEK_SET) != 0) { fclose(file); return false; }
  unsigned char *bytes = malloc((size_t)size); if (!bytes) { fclose(file); return false; }
  bool ok = fread(bytes, 1, (size_t)size, file) == (size_t)size; fclose(file);
  if (!ok || !stbtt_InitFont(&face->info, bytes, stbtt_GetFontOffsetForIndex(bytes, 0))) { free(bytes); return false; }
  face->bytes = bytes; stbtt_GetFontVMetrics(&face->info, &face->ascent, &face->descent, &face->gap); return true;
}

ReFontSet *re_font_open(const char *mono_path, const char *ui_path) {
  ReFontSet *fonts = calloc(1, sizeof(*fonts)); if (!fonts) return NULL;
  const char *candidates[] = { mono_path, getenv("RENGINE_FONT"),
#ifdef __APPLE__
    "/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/SFNSMono.ttf",
#elif defined(_WIN32)
    "C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/cour.ttf",
#else
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
#endif
  };
  for (size_t i = 0; i < sizeof(candidates) / sizeof(candidates[0]); i++) {
    if (load(&fonts->faces[RE_FACE_MONO], candidates[i])) { fonts->owned[RE_FACE_MONO] = true; break; }
  }
  if (!fonts->owned[RE_FACE_MONO]) {
    snprintf(error_text, sizeof(error_text), "Set RENGINE_FONT to a trusted local monospace TTF/TTC font."); free(fonts); return NULL;
  }
  if (load(&fonts->faces[RE_FACE_UI], ui_path)) fonts->owned[RE_FACE_UI] = true;
  else fonts->faces[RE_FACE_UI] = fonts->faces[RE_FACE_MONO];
  return fonts;
}
void re_font_close(ReFontSet *fonts) {
  if (!fonts) return;
  for (int i = 0; i < RE_FACE_COUNT; i++) if (fonts->owned[i]) free(fonts->faces[i].bytes);
  free(fonts);
}
bool re_font_has_face(const ReFontSet *fonts, uint8_t face) { return fonts && face < RE_FACE_COUNT && fonts->owned[face]; }

static Face *select_face(ReFontSet *fonts, uint8_t face) { return &fonts->faces[face < RE_FACE_COUNT ? face : RE_FACE_MONO]; }
static float scale_for(const Face *face, int size, float density) { return stbtt_ScaleForPixelHeight(&face->info, (float)size * density); }

ReFontMetrics re_font_metrics(ReFontSet *fonts, uint8_t face_id, int size, float density) {
  Face *face = select_face(fonts, face_id);
  if (size <= 0) size = 16;
  if (density <= 0) density = 1.0f;
  float scale = scale_for(face, size, density); int advance, bearing;
  stbtt_GetCodepointHMetrics(&face->info, 'M', &advance, &bearing);
  ReFontMetrics m;
  m.ascent = (int)(face->ascent * scale / density + 0.5f);
  m.line_height = (int)((face->ascent - face->descent + face->gap) * scale / density + 0.5f);
  m.advance = (int)(advance * scale / density + 0.5f);
  return m;
}
bool re_font_glyph(ReFontSet *fonts, uint8_t face_id, int size, float density, uint32_t codepoint, ReGlyphBitmap *out) {
  Face *face = select_face(fonts, face_id);
  if (size <= 0) size = 16;
  if (density <= 0) density = 1.0f;
  memset(out, 0, sizeof(*out));
  out->pixels = stbtt_GetCodepointBitmap(&face->info, 0, scale_for(face, size, density), (int)codepoint, &out->w, &out->h, &out->dx, &out->dy);
  return out->pixels != NULL;
}
void re_font_glyph_free(ReGlyphBitmap *glyph) { stbtt_FreeBitmap(glyph->pixels, NULL); glyph->pixels = NULL; }
