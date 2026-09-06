#ifndef RENGINE_SCROLL_H
#define RENGINE_SCROLL_H
#include "draw.h"
#define RE_SCROLLBAR_SIZE 14
typedef struct {
  mu_Rect track, thumb; int total, page, value, maximum, grab; bool horizontal, dragging;
} ReScrollbar;
int re_wheel_steps(float *remainder, const SDL_MouseWheelEvent *event, bool horizontal, float scale);
void re_scrollbar_set(ReScrollbar *bar, mu_Rect track, int total, int page, int value, bool horizontal);
bool re_scrollbar_event(ReScrollbar *bar, const SDL_Event *event);
void re_scrollbar_draw(const ReScrollbar *bar, ReDraw *draw);
void re_scrollbar_inspect(const ReScrollbar *bar, cJSON *array);
#endif
