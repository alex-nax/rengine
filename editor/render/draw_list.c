#include "render/draw_list.h"
#include <stdlib.h>
#include <string.h>

#define RE_DRAW_LIST_DEFAULT_COMMANDS ((size_t)1 << 20)
#define RE_DRAW_LIST_DEFAULT_STRINGS ((size_t)16 << 20)

void re_draw_list_init(ReDrawList *l) {
  memset(l, 0, sizeof(*l)); l->max_commands = RE_DRAW_LIST_DEFAULT_COMMANDS; l->max_strings = RE_DRAW_LIST_DEFAULT_STRINGS; l->density = 1.0f;
}
void re_draw_list_limits(ReDrawList *l, size_t max_commands, size_t max_strings) { l->max_commands = max_commands; l->max_strings = max_strings; }
void re_draw_list_free(ReDrawList *l) { free(l->commands); free(l->strings); memset(l, 0, sizeof(*l)); }
void re_draw_list_reset(ReDrawList *l, int width, int height, float density, ReColor clear) {
  l->count = 0; l->string_size = 0; l->width = width; l->height = height; l->density = density > 0 ? density : 1.0f; l->clear = clear; l->overflow = false;
}

static bool grow(void **data, size_t *capacity, size_t needed, size_t maximum, size_t item) {
  if (needed > maximum) return false;
  if (needed <= *capacity) return true;
  size_t next = *capacity ? *capacity : 256;
  while (next < needed) next *= 2;
  if (next > maximum) next = maximum;
  void *block = realloc(*data, next * item);
  if (!block) return false;
  *data = block; *capacity = next; return true;
}
/* Overflow is sticky for the frame: later commands are dropped so the accepted prefix stays in order. */
static ReCommand *push(ReDrawList *l, uint8_t type) {
  if (l->overflow || !grow((void **)&l->commands, &l->capacity, l->count + 1, l->max_commands, sizeof(ReCommand))) { l->overflow = true; return NULL; }
  ReCommand *c = &l->commands[l->count++]; memset(c, 0, sizeof(*c)); c->type = type; return c;
}

bool re_draw_list_clip(ReDrawList *l, const ReRect *rect) {
  ReCommand *c = push(l, RE_CMD_CLIP); if (!c) return false;
  if (rect) c->rect = *rect; else c->flags = RE_CLIP_RESET;
  return true;
}
bool re_draw_list_rect(ReDrawList *l, ReRect rect, ReColor color) {
  ReCommand *c = push(l, RE_CMD_RECT); if (!c) return false;
  c->rect = rect; c->color = color; return true;
}
bool re_draw_list_rrect(ReDrawList *l, ReRect rect, ReColor color, float radius, uint8_t corners) {
  ReCommand *c = push(l, RE_CMD_RRECT); if (!c) return false;
  c->rect = rect; c->color = color; c->radius = radius; c->corners = corners; return true;
}
bool re_draw_list_gradient(ReDrawList *l, ReRect rect, ReColor from, ReColor to, float radius, uint8_t corners, uint8_t axis) {
  ReCommand *c = push(l, RE_CMD_GRADIENT); if (!c) return false;
  c->rect = rect; c->color = from; c->secondary = to; c->radius = radius; c->corners = corners;
  c->flags = axis == RE_GRADIENT_VERTICAL ? RE_GRADIENT_VERTICAL : RE_GRADIENT_HORIZONTAL; return true;
}
bool re_draw_list_frame(ReDrawList *l, ReRect rect, ReColor border, ReColor highlight, float radius) {
  ReCommand *c = push(l, RE_CMD_FRAME); if (!c) return false;
  c->rect = rect; c->color = border; c->secondary = highlight; c->radius = radius; c->corners = RE_CORNERS_ALL; return true;
}
bool re_draw_list_shadow(ReDrawList *l, ReRect rect, ReColor color, float radius, int width) {
  ReCommand *c = push(l, RE_CMD_SHADOW); if (!c) return false;
  c->rect = rect; c->color = color; c->radius = radius; c->width = (int16_t)(width > 0 ? width : 1); c->corners = RE_CORNERS_ALL; return true;
}
bool re_draw_list_ring(ReDrawList *l, ReRect rect, ReColor color, float radius, int width) {
  ReCommand *c = push(l, RE_CMD_RING); if (!c) return false;
  c->rect = rect; c->color = color; c->radius = radius; c->width = (int16_t)(width > 0 ? width : 1); c->corners = RE_CORNERS_ALL; return true;
}
bool re_draw_list_text(ReDrawList *l, uint8_t face, int size, int x, int y, ReColor color, const char *text, int length) {
  if (!text) return true;
  size_t bytes = length < 0 ? strlen(text) : (size_t)length;
  if (l->overflow || !grow((void **)&l->strings, &l->string_capacity, l->string_size + bytes + 1, l->max_strings, 1)) { l->overflow = true; return false; }
  ReCommand *c = push(l, RE_CMD_TEXT); if (!c) return false;
  c->face = face; c->size = (int16_t)size; c->rect.x = x; c->rect.y = y; c->color = color;
  c->text_offset = (uint32_t)l->string_size; c->text_length = (uint32_t)bytes;
  memcpy(l->strings + l->string_size, text, bytes); l->strings[l->string_size + bytes] = 0; l->string_size += bytes + 1;
  return true;
}
bool re_draw_list_icon(ReDrawList *l, uint8_t icon, int size, ReRect rect, ReColor color) {
  ReCommand *c = push(l, RE_CMD_ICON); if (!c) return false;
  c->icon = icon; c->size = (int16_t)size; c->rect = rect; c->color = color; return true;
}
bool re_draw_list_texture(ReDrawList *l, ReTexture *texture, ReRect rect, uint8_t flags) {
  if (!texture) return true;
  ReCommand *c = push(l, RE_CMD_TEXTURE); if (!c) return false;
  c->texture = texture; c->rect = rect; c->flags = flags; return true;
}
const char *re_draw_list_string(const ReDrawList *l, const ReCommand *c) {
  return c->type == RE_CMD_TEXT && c->text_offset + c->text_length < l->string_size ? l->strings + c->text_offset : "";
}
