#define STB_TRUETYPE_IMPLEMENTATION
#include "stb_truetype.h"
#include "render/font.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "render/utf8.h"

#ifndef RENGINE_FONT_DIR
#define RENGINE_FONT_DIR "third_party"
#endif

typedef struct { unsigned char *bytes; stbtt_fontinfo info; int ascent, descent, gap; } Face;
struct ReFontSet { Face faces[RE_FACE_COUNT]; bool owned[RE_FACE_COUNT]; };
static char error_text[160];
/* Where the bundled UI and icon faces live. The desktop's build compiles in the vendored tree; an
   app that ships them inside its package (the Android companion unpacks them out of its assets)
   only learns the directory at run time, and says so before opening the set. */
static char bundle_dir[512] = RENGINE_FONT_DIR;

const char *re_font_error(void) { return error_text; }
void re_font_bundle_dir(const char *dir) {
  if (dir && *dir) snprintf(bundle_dir, sizeof(bundle_dir), "%s", dir);
}

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
  /* Bundled faces (spec 076 decisions 5 and 6); each falls back rather than failing the desktop. */
  static const struct { uint8_t face; const char *file; } bundled[] = {
    {RE_FACE_UI, "inter/Inter-Regular.ttf"},
    {RE_FACE_UI_MEDIUM, "inter/Inter-Medium.ttf"},
    {RE_FACE_UI_SEMIBOLD, "inter/Inter-SemiBold.ttf"},
    {RE_FACE_ICON, "phosphor/Phosphor.ttf"},
  };
  for (size_t i = 0; i < sizeof(bundled) / sizeof(bundled[0]); i++) {
    char path[640];
    snprintf(path, sizeof(path), "%s/%s", bundle_dir, bundled[i].file);
    if (load(&fonts->faces[bundled[i].face], path)) fonts->owned[bundled[i].face] = true;
  }
  if (load(&fonts->faces[RE_FACE_UI], ui_path)) fonts->owned[RE_FACE_UI] = true; /* RENGINE_UI_FONT wins over the bundle */
  for (int i = RE_FACE_UI; i < RE_FACE_COUNT; i++) {
    if (!fonts->owned[i]) fonts->faces[i] = fonts->faces[i == RE_FACE_UI_MEDIUM || i == RE_FACE_UI_SEMIBOLD ? RE_FACE_UI : RE_FACE_MONO];
  }
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
/* Symbols no installed face draws, mapped to the nearest shape that every mono face has. Terminal
 * programs use these freely; an empty box is worse than a close equivalent — see sidecar: glyph-fallback */
static uint32_t substitute(uint32_t codepoint) {
  switch (codepoint) {
    case 0x23F4: return 0x25C0; /* ⏴ medium left triangle  -> ◀ */
    case 0x23F5: return 0x25B6; /* ⏵ medium right triangle -> ▶ */
    case 0x23F6: return 0x25B2; /* ⏶ medium up triangle    -> ▲ */
    case 0x23F7: return 0x25BC; /* ⏷ medium down triangle  -> ▼ */
    case 0x23F9: return 0x25A0; /* ⏹ stop                  -> ■ */
    case 0x23FA: return 0x25CF; /* ⏺ record                -> ● */
    default: return codepoint;
  }
}
/* The requested face first, then the other loaded faces, then the substitution: a run keeps its own
 * face wherever it can, and only a glyph nobody has falls back. Advances are unaffected, so the
 * monospace grid and every adapter's placement stay as they were. */
static Face *face_for(ReFontSet *fonts, uint8_t face_id, uint32_t codepoint, uint32_t *drawn) {
  Face *requested = select_face(fonts, face_id);
  *drawn = codepoint;
  if (stbtt_FindGlyphIndex(&requested->info, (int)codepoint)) return requested;
  for (int i = 0; i < RE_FACE_COUNT; i++) {
    if (!fonts->owned[i] || i == face_id) continue;
    if (stbtt_FindGlyphIndex(&fonts->faces[i].info, (int)codepoint)) return &fonts->faces[i];
  }
  uint32_t near = substitute(codepoint);
  if (near == codepoint) return requested;
  *drawn = near;
  if (stbtt_FindGlyphIndex(&requested->info, (int)near)) return requested;
  for (int i = 0; i < RE_FACE_COUNT; i++) {
    if (!fonts->owned[i] || i == face_id) continue;
    if (stbtt_FindGlyphIndex(&fonts->faces[i].info, (int)near)) return &fonts->faces[i];
  }
  *drawn = codepoint;
  return requested;
}
bool re_font_glyph(ReFontSet *fonts, uint8_t face_id, int size, float density, uint32_t codepoint, ReGlyphBitmap *out) {
  if (size <= 0) size = 16;
  if (density <= 0) density = 1.0f;
  uint32_t drawn = codepoint;
  Face *face = face_for(fonts, face_id, codepoint, &drawn);
  memset(out, 0, sizeof(*out));
  out->pixels = stbtt_GetCodepointBitmap(&face->info, 0, scale_for(face, size, density), (int)drawn, &out->w, &out->h, &out->dx, &out->dy);
  return out->pixels != NULL;
}
void re_font_glyph_free(ReGlyphBitmap *glyph) { stbtt_FreeBitmap(glyph->pixels, NULL); glyph->pixels = NULL; }

/* The monospace face keeps its integer logical advance, which is what the reference snapshots were
 * measured with; proportional faces accumulate real advances in drawable space. */
static float glyph_advance(Face *face, int size, float density, uint32_t codepoint) {
  int advance, bearing;
  stbtt_GetCodepointHMetrics(&face->info, (int)codepoint, &advance, &bearing);
  return (float)advance * scale_for(face, size, density);
}
ReTextPen re_font_pen(ReFontSet *fonts, uint8_t face_id, int size, float density, int x) {
  ReTextPen pen;
  memset(&pen, 0, sizeof(pen));
  pen.fonts = fonts; pen.face = face_id; pen.size = size > 0 ? size : 16; pen.density = density > 0 ? density : 1.0f;
  pen.mono = face_id == RE_FACE_MONO; pen.logical = x; pen.drawable = (float)x * pen.density;
  pen.advance = re_font_metrics(fonts, face_id, pen.size, pen.density).advance;
  return pen;
}
/* Proportional runs land on whole drawable pixels: the glyph bitmaps carry no sub-pixel phase, and
 * the SDL reference positions its texture rects in logical space, so rounding here is what keeps
 * all four adapters on the same pixels. */
float re_font_pen_x(const ReTextPen *pen) {
  return pen->mono ? (float)pen->logical * pen->density : (float)(int)(pen->drawable + 0.5f);
}
void re_font_pen_step(ReTextPen *pen, uint32_t codepoint) {
  if (pen->mono) { pen->logical += pen->advance; return; }
  pen->drawable += glyph_advance(select_face(pen->fonts, pen->face), pen->size, pen->density, codepoint);
}
int re_font_text_width(ReFontSet *fonts, uint8_t face_id, int size, float density, const char *text, int length) {
  if (!text || length <= 0) return 0;
  if (size <= 0) size = 16;
  if (density <= 0) density = 1.0f;
  if (face_id == RE_FACE_MONO) {
    int advance = re_font_metrics(fonts, face_id, size, density).advance, count = 0;
    for (const char *s = text, *end = text + length; *s && s < end; count++) re_utf8(&s);
    return advance * count;
  }
  Face *face = select_face(fonts, face_id);
  float total = 0;
  for (const char *s = text, *end = text + length; *s && s < end;) total += glyph_advance(face, size, density, re_utf8(&s));
  return (int)(total / density + 0.5f);
}
