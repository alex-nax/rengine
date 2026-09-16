/* rEngine draw-list contract, version 1 (docs/specs/067-draw-list-contract.md).
   Backend-neutral: no windowing or graphics-API headers. Coordinates are logical pixels. */
#ifndef RENGINE_DRAW_LIST_H
#define RENGINE_DRAW_LIST_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define RE_DRAW_LIST_VERSION 2

typedef struct { uint8_t r, g, b, a; } ReColor;
typedef struct { int x, y, w, h; } ReRect;
typedef struct ReTexture ReTexture;

enum { RE_FACE_MONO = 0, RE_FACE_UI = 1, RE_FACE_UI_MEDIUM = 2, RE_FACE_UI_SEMIBOLD = 3, RE_FACE_ICON = 4, RE_FACE_COUNT = 5 };
#include "render/icons.h" /* generated: RE_ICON_* and their codepoints in the pinned icon face */
enum { RE_CORNER_TOP_LEFT = 1, RE_CORNER_TOP_RIGHT = 2, RE_CORNER_BOTTOM_RIGHT = 4, RE_CORNER_BOTTOM_LEFT = 8, RE_CORNERS_ALL = 15 };
enum { RE_CLIP_RESET = 1, RE_DRAW_FLIP_Y = 2 };
enum { RE_GRADIENT_HORIZONTAL = 0, RE_GRADIENT_VERTICAL = 1 };

typedef enum {
  RE_CMD_CLIP = 1, RE_CMD_RECT, RE_CMD_RRECT, RE_CMD_FRAME, RE_CMD_SHADOW, RE_CMD_RING, RE_CMD_TEXT, RE_CMD_ICON, RE_CMD_TEXTURE,
  RE_CMD_GRADIENT                      /* version 2: two-stop ramp, `flags` carries RE_GRADIENT_* */
} ReCommandType;

typedef struct {
  uint8_t type, face, icon, corners, flags;
  int16_t size;                        /* text and icon pixel size */
  int16_t width;                       /* ring width; shadow falloff extent */
  ReRect rect;                         /* text: x and y are the top-left of the line box */
  ReColor color, secondary;            /* frame: border and inner highlight; gradient: first and last stop */
  float radius;
  uint32_t text_offset, text_length;   /* bytes in the list's arena, NUL-terminated there */
  ReTexture *texture;
} ReCommand;

typedef struct {
  ReCommand *commands; size_t count, capacity, max_commands;
  char *strings; size_t string_size, string_capacity, max_strings;
  int width, height; float density; ReColor clear;
  bool overflow;
} ReDrawList;

void re_draw_list_init(ReDrawList *list);
void re_draw_list_limits(ReDrawList *list, size_t max_commands, size_t max_strings);
void re_draw_list_free(ReDrawList *list);
void re_draw_list_reset(ReDrawList *list, int width, int height, float density, ReColor clear);
bool re_draw_list_clip(ReDrawList *list, const ReRect *rect);
bool re_draw_list_rect(ReDrawList *list, ReRect rect, ReColor color);
bool re_draw_list_rrect(ReDrawList *list, ReRect rect, ReColor color, float radius, uint8_t corners);
bool re_draw_list_frame(ReDrawList *list, ReRect rect, ReColor border, ReColor highlight, float radius);
bool re_draw_list_shadow(ReDrawList *list, ReRect rect, ReColor color, float radius, int width);
bool re_draw_list_ring(ReDrawList *list, ReRect rect, ReColor color, float radius, int width);
bool re_draw_list_text(ReDrawList *list, uint8_t face, int size, int x, int y, ReColor color, const char *text, int length);
bool re_draw_list_icon(ReDrawList *list, uint8_t icon, int size, ReRect rect, ReColor color);
bool re_draw_list_texture(ReDrawList *list, ReTexture *texture, ReRect rect, uint8_t flags);
/* A two-stop ramp across `rect`, rounded like an rrect. Adapters step it one logical pixel at a
 * time through re_gradient_sample, so every backend produces the same ramp (spec 076 decision 7). */
bool re_draw_list_gradient(ReDrawList *list, ReRect rect, ReColor from, ReColor to, float radius, uint8_t corners, uint8_t axis);
const char *re_draw_list_string(const ReDrawList *list, const ReCommand *command);

static inline ReColor re_color(uint8_t r, uint8_t g, uint8_t b, uint8_t a) { ReColor c = {r, g, b, a}; return c; }
static inline ReRect re_rect(int x, int y, int w, int h) { ReRect r = {x, y, w, h}; return r; }
/* Stop `step` of `steps` along a ramp. Shared by every adapter so the ramp is backend-neutral. */
static inline ReColor re_gradient_sample(ReColor from, ReColor to, int step, int steps) {
  if (steps <= 1) return from;
  int n = steps - 1, s = step < 0 ? 0 : (step > n ? n : step);
  ReColor c;
  c.r = (uint8_t)((from.r * (n - s) + to.r * s + n / 2) / n);
  c.g = (uint8_t)((from.g * (n - s) + to.g * s + n / 2) / n);
  c.b = (uint8_t)((from.b * (n - s) + to.b * s + n / 2) / n);
  c.a = (uint8_t)((from.a * (n - s) + to.a * s + n / 2) / n);
  return c;
}
#endif
