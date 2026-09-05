#ifndef RENGINE_DRAW_H
#define RENGINE_DRAW_H
#include "common.h"
typedef struct ReDraw ReDraw;
ReDraw *re_draw_open(SDL_Window *window, const char *font);
void re_draw_close(ReDraw *draw);
void re_draw_bind(ReDraw *draw, mu_Context *ui);
void re_draw_begin(ReDraw *draw, int width, int height);
void re_draw_commands(ReDraw *draw, mu_Context *ui);
void re_draw_end(ReDraw *draw);
void re_draw_rect(ReDraw *draw, mu_Rect rect, mu_Color color);
void re_draw_clip(ReDraw *draw, const mu_Rect *rect);
void re_draw_text(ReDraw *draw, const char *text, int len, int x, int y, mu_Color color);
int re_draw_cell_width(const ReDraw *draw);
int re_draw_line_height(const ReDraw *draw);
SDL_Renderer *re_draw_renderer(ReDraw *draw);
bool re_draw_snapshot(ReDraw *draw, const char *path);
#endif
