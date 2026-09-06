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
int re_font_text_width(ReFontSet *fonts, uint8_t face, int size, float density, const char *text, int length); /* logical pixels */

/* Text pen: every adapter walks a run the same way, so their snapshots agree — see sidecar: pen-parity */
typedef struct { ReFontSet *fonts; float density, drawable; int logical, advance, size; uint8_t face; bool mono; } ReTextPen;
ReTextPen re_font_pen(ReFontSet *fonts, uint8_t face, int size, float density, int x); /* x in logical pixels */
float re_font_pen_x(const ReTextPen *pen);                                             /* drawable pixels */
void re_font_pen_step(ReTextPen *pen, uint32_t codepoint);
bool re_font_glyph(ReFontSet *fonts, uint8_t face, int size, float density, uint32_t codepoint, ReGlyphBitmap *out);
void re_font_glyph_free(ReGlyphBitmap *glyph);
#endif
