#include "scroll.h"
#include <math.h>

int re_wheel_steps(float *remainder, const SDL_MouseWheelEvent *event, bool horizontal, float scale) {
  float precise = horizontal ? event->preciseX : event->preciseY;
  float amount = precise ? precise : (float)(horizontal ? event->x : event->y);
  if (!isfinite(amount)) return 0;
  if (amount * *remainder < 0) *remainder = 0;
  *remainder += (amount < -1000 ? -1000 : amount > 1000 ? 1000 : amount) * scale;
  int steps = (int)*remainder; *remainder -= steps; return steps;
}
static void release(ReScrollbar *bar) {
  if (bar->dragging) SDL_CaptureMouse(SDL_FALSE); bar->dragging = false;
}
void re_scrollbar_set(ReScrollbar *bar, mu_Rect track, int total, int page, int value, bool horizontal) {
  bar->total = re_max(0, total); bar->page = re_max(1, page);
  bar->maximum = re_max(0, total - bar->page); bar->value = re_max(0, re_min(value, bar->maximum));
  bar->horizontal = horizontal;
  if (!bar->maximum || track.w <= 0 || track.h <= 0) { bar->track = bar->thumb = mu_rect(0, 0, 0, 0); release(bar); return; }
  bar->track = bar->thumb = track;
  int length = horizontal ? track.w : track.h;
  int thumb = re_min(length, re_max(RE_METRIC_SCROLLBAR_THUMB_MIN, (int)((int64_t)length * bar->page / bar->total)));
  int offset = (int)((int64_t)bar->value * (length - thumb) / bar->maximum);
  if (horizontal) { bar->thumb.x += offset; bar->thumb.w = thumb; }
  else { bar->thumb.y += offset; bar->thumb.h = thumb; }
}
bool re_scrollbar_event(ReScrollbar *bar, const SDL_Event *event) {
  if (event->type == SDL_WINDOWEVENT && event->window.event == SDL_WINDOWEVENT_FOCUS_LOST) { release(bar); return false; }
  if (event->type == SDL_MOUSEBUTTONUP && event->button.button == SDL_BUTTON_LEFT && bar->dragging) { release(bar); return true; }
  if (event->type == SDL_MOUSEBUTTONDOWN && event->button.button == SDL_BUTTON_LEFT && re_inside(bar->track, event->button.x, event->button.y)) {
    int position = bar->horizontal ? event->button.x : event->button.y;
    int thumb_start = bar->horizontal ? bar->thumb.x : bar->thumb.y;
    if (re_inside(bar->thumb, event->button.x, event->button.y)) { bar->grab = position - thumb_start; bar->dragging = true; SDL_CaptureMouse(SDL_TRUE); }
    else bar->value = re_max(0, re_min(bar->maximum, bar->value + (position < thumb_start ? -bar->page : bar->page)));
    return true;
  }
  if (event->type == SDL_MOUSEMOTION && !bar->dragging) bar->hover = re_inside(bar->track, event->motion.x, event->motion.y);
  if (event->type == SDL_MOUSEMOTION && bar->dragging) {
    int position = bar->horizontal ? event->motion.x : event->motion.y;
    int start = bar->horizontal ? bar->track.x : bar->track.y;
    int travel = bar->horizontal ? bar->track.w - bar->thumb.w : bar->track.h - bar->thumb.h;
    int offset = re_max(0, re_min(travel, position - start - bar->grab));
    bar->value = travel > 0 ? (int)(((int64_t)offset * bar->maximum + travel / 2) / travel) : 0;
    return true;
  }
  return false;
}
/* The card's overlay bar: the track is transparent, the thumb is the only mark, and dragging takes
 * the accent so the pointer target is unambiguous. */
void re_scrollbar_draw(const ReScrollbar *bar, ReDraw *draw) {
  if (!bar->track.w || !bar->track.h) return;
  mu_Color track = RE_COLOR_SCROLL_TRACK;
  if (track.a) re_draw_rect(draw, bar->track, track);
  mu_Rect thumb = bar->thumb;
  int inset = RE_METRIC_DESIGN_SCROLL_INSET;
  if (bar->horizontal) { thumb.y += inset; thumb.h -= 2 * inset; } else { thumb.x += inset; thumb.w -= 2 * inset; }
  if (thumb.w <= 0 || thumb.h <= 0) return;
  float radius = (float)(bar->horizontal ? thumb.h : thumb.w) / 2;
  mu_Color fill = bar->dragging ? RE_COLOR_ACCENT : bar->hover ? RE_COLOR_SCROLL_THUMB_ACTIVE : RE_COLOR_SCROLL_THUMB;
  re_draw_rrect(draw, thumb, fill, radius, RE_CORNERS_ALL);
}
void re_scrollbar_inspect(const ReScrollbar *bar, cJSON *array) {
  if (!bar->track.w || !bar->track.h) return;
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "axis", bar->horizontal ? "x" : "y");
  cJSON_AddNumberToObject(j, "value", bar->value); cJSON_AddNumberToObject(j, "maximum", bar->maximum);
  cJSON_AddNumberToObject(j, "page", bar->page);
  cJSON_AddItemToObject(j, "track", cJSON_CreateIntArray((int[]){bar->track.x, bar->track.y, bar->track.w, bar->track.h}, 4));
  cJSON_AddItemToObject(j, "thumb", cJSON_CreateIntArray((int[]){bar->thumb.x, bar->thumb.y, bar->thumb.w, bar->thumb.h}, 4));
  cJSON_AddItemToArray(array, j);
}
