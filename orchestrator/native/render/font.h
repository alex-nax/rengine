/* Trusted local font faces, metrics and glyph bitmaps shared by every adapter (spec 067). */
#ifndef RENGINE_FONT_H
#define RENGINE_FONT_H
#include "render/draw_list.h"

typedef struct ReFontSet ReFontSet;
typedef struct { int ascent, line_height, advance; } ReFontMetrics;   /* logical pixels; advance is the width of 'M' */
typedef struct { int w, h, dx, dy; unsigned char *pixels; } ReGlyphBitmap; /* drawable pixels, 8-bit coverage */

ReFontSet *re_font_open(const char *mono_path, const char *ui_path);
void re_font_close(ReFontSet *fonts);
const char *re_font_error(void);
bool re_font_has_face(const ReFontSet *fonts, uint8_t face);
ReFontMetrics re_font_metrics(ReFontSet *fonts, uint8_t face, int size, float density);
bool re_font_glyph(ReFontSet *fonts, uint8_t face, int size, float density, uint32_t codepoint, ReGlyphBitmap *out);
void re_font_glyph_free(ReGlyphBitmap *glyph);
#endif
