#ifndef RENGINE_DRAW_H
#define RENGINE_DRAW_H
/* Not common.h: that pulls SDL, and this header is the one the owned control layer (ui/ui.h) leans
   on — which is what kept a layer with no windowing in it from compiling for a phone (charter D59). */
#include <stdint.h>
#include "microui.h"
#include "theme.h"
#include "cJSON.h"
#include "render/draw_list.h"
#include "render/utf8.h"

/* The three helpers this header's consumers use, which used to arrive through common.h along with
   SDL. common.h keeps its own copies guarded, so the files that still include it are unchanged. */
#ifndef RE_ARRAY_SIZE
#define RE_ARRAY_SIZE(a) ((int)(sizeof(a) / sizeof((a)[0])))
#endif
#ifndef RE_MIN_MAX_DEFINED
#define RE_MIN_MAX_DEFINED
static inline int re_min(int a, int b) { return a < b ? a : b; }
static inline int re_max(int a, int b) { return a > b ? a : b; }
#endif
typedef struct ReDraw ReDraw;
const char *re_draw_select(const char *name);            /* argument > RENGINE_RENDERER > platform default; NULL if unknown */
uint32_t re_draw_window_flags(const char *backend);      /* call before the window is made */
/* `window` is opaque: SDL_Window* on the desktop, ANativeWindow* on Android. See seam_host.h. */
ReDraw *re_draw_open(void *window, const char *font, const char *backend);
ReDraw *re_draw_active(void);
cJSON *re_draw_stats(const ReDraw *draw);
void re_draw_stats_reset(ReDraw *draw);
void re_draw_close(ReDraw *draw);
void re_draw_bind(ReDraw *draw, mu_Context *ui);
int re_draw_theme(ReDraw *draw, const char *preset); /* live preset switch; index or -1 */
/* The window's size in LOGICAL pixels. The backend derives this frame's density by dividing the
   drawable it owns by `width`, so handing it physical pixels reports a density of 1 and draws the
   whole interface at 1/density scale — which reads as missing text rather than as a wrong size. */
void re_draw_begin(ReDraw *draw, int width, int height);
void re_draw_commands(ReDraw *draw, mu_Context *ui);
void re_draw_end(ReDraw *draw);
void re_draw_rect(ReDraw *draw, mu_Rect rect, mu_Color color);
void re_draw_clip(ReDraw *draw, const mu_Rect *rect);
void re_draw_text(ReDraw *draw, const char *text, int len, int x, int y, mu_Color color);
void re_draw_text_face(ReDraw *draw, uint8_t face, int size, const char *text, int len, int x, int y, mu_Color color);
void re_draw_rrect(ReDraw *draw, mu_Rect rect, mu_Color color, float radius, uint8_t corners);
void re_draw_frame(ReDraw *draw, mu_Rect rect, mu_Color border, mu_Color highlight, float radius);
void re_draw_shadow(ReDraw *draw, mu_Rect rect, mu_Color color, float radius, int width);
void re_draw_ring(ReDraw *draw, mu_Rect rect, mu_Color color, float radius, int width);
void re_draw_gradient(ReDraw *draw, mu_Rect rect, mu_Color from, mu_Color to, float radius, uint8_t corners, uint8_t axis);
void re_draw_icon(ReDraw *draw, uint8_t icon, mu_Rect rect, mu_Color color);
/* An icon at an explicit pixel size, for a mark that has to fit a box smaller than the text size. */
void re_draw_icon_sized(ReDraw *draw, uint8_t icon, int size, mu_Rect rect, mu_Color color);
ReTexture *re_draw_texture_create(ReDraw *draw, int width, int height);
bool re_draw_texture_update(ReTexture *texture, const void *rgba, int pitch);
void re_draw_texture_destroy(ReTexture *texture);
void re_draw_texture(ReDraw *draw, ReTexture *texture, mu_Rect rect, uint8_t flags);
int re_draw_text_width(ReDraw *draw, uint8_t face, int size, const char *text, int length); /* logical pixels; -1 measures to the terminator */
int re_draw_cell_width(const ReDraw *draw);
int re_draw_line_height(const ReDraw *draw);
bool re_draw_overflowed(const ReDraw *draw);
ReDrawList *re_draw_list(ReDraw *draw);   /* this frame's list, for a plugin frame to append to (spec 106) */
const char *re_draw_backend(const ReDraw *draw);
bool re_draw_snapshot(ReDraw *draw, const char *path);
#endif
