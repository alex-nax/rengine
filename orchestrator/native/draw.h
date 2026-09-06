#ifndef RENGINE_DRAW_H
#define RENGINE_DRAW_H
#include "common.h"
#include "render/draw_list.h"
typedef struct ReDraw ReDraw;
const char *re_draw_select(const char *name);            /* argument > RENGINE_RENDERER > platform default; NULL if unknown */
Uint32 re_draw_window_flags(const char *backend);        /* call before SDL_CreateWindow */
ReDraw *re_draw_open(SDL_Window *window, const char *font, const char *backend);
ReDraw *re_draw_active(void);
cJSON *re_draw_stats(const ReDraw *draw);
void re_draw_stats_reset(ReDraw *draw);
void re_draw_close(ReDraw *draw);
void re_draw_bind(ReDraw *draw, mu_Context *ui);
int re_draw_theme(ReDraw *draw, const char *preset); /* live preset switch; index or -1 */
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
ReTexture *re_draw_texture_create(ReDraw *draw, int width, int height);
bool re_draw_texture_update(ReTexture *texture, const void *rgba, int pitch);
void re_draw_texture_destroy(ReTexture *texture);
void re_draw_texture(ReDraw *draw, ReTexture *texture, mu_Rect rect, uint8_t flags);
int re_draw_text_width(ReDraw *draw, uint8_t face, int size, const char *text, int length); /* logical pixels; -1 measures to the terminator */
int re_draw_cell_width(const ReDraw *draw);
int re_draw_line_height(const ReDraw *draw);
bool re_draw_overflowed(const ReDraw *draw);
const char *re_draw_backend(const ReDraw *draw);
bool re_draw_snapshot(ReDraw *draw, const char *path);
#endif
