#include "hexview.h"

struct ReHexView {
  uint8_t bytes[RE_HEX_WINDOW]; int length; long long base, size; bool loaded;
  int scroll; ReScrollbar bar; float wheel;
};
static int nibble(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; }

ReHexView *re_hex_open(void) { return calloc(1, sizeof(ReHexView)); }
void re_hex_close(ReHexView *v) { free(v); }
bool re_hex_set(ReHexView *v, const char *hex, long long base, long long size) {
  size_t chars = strlen(hex);
  if (chars % 2 || chars / 2 > RE_HEX_WINDOW || base < 0 || size < 0) return false;
  for (size_t i = 0; i < chars; i += 2) {
    int hi = nibble(hex[i]), lo = nibble(hex[i + 1]); if (hi < 0 || lo < 0) return false;
    v->bytes[i / 2] = (uint8_t)(hi << 4 | lo);
  }
  v->length = (int)(chars / 2); v->base = base; v->size = size; v->loaded = true; v->scroll = 0; return true;
}
void re_hex_clear(ReHexView *v) { v->length = 0; v->loaded = false; v->scroll = 0; v->base = v->size = 0; }
bool re_hex_loaded(const ReHexView *v) { return v->loaded; }
long long re_hex_base(const ReHexView *v) { return v->base; }
long long re_hex_size(const ReHexView *v) { return v->size; }
int re_hex_length(const ReHexView *v) { return v->length; }
int re_hex_rows(const ReHexView *v) { return (v->length + RE_HEX_COLUMNS - 1) / RE_HEX_COLUMNS; }
void re_hex_row(const ReHexView *v, int row, char *text, size_t size) {
  int start = row * RE_HEX_COLUMNS, count = re_min(RE_HEX_COLUMNS, v->length - start); size_t at = 0;
  if (count <= 0 || size < 96) { if (size) text[0] = 0; return; }
  at += (size_t)snprintf(text, size, "%08llx  ", v->base + start);
  for (int i = 0; i < RE_HEX_COLUMNS; i++) {
    if (i < count) at += (size_t)snprintf(text + at, size - at, "%02x", v->bytes[start + i]); else { text[at++] = ' '; text[at++] = ' '; }
    text[at++] = ' '; if (i == RE_HEX_COLUMNS / 2 - 1) text[at++] = ' ';
  }
  text[at++] = '|';
  for (int i = 0; i < count; i++) { uint8_t b = v->bytes[start + i]; text[at++] = b >= 32 && b < 127 ? (char)b : '.'; }
  text[at++] = '|'; text[at] = 0;
}
static mu_Rect viewport(ReHexView *v, mu_Rect r, int lh) {
  int rows = re_hex_rows(v), page = re_max(1, r.h / lh); mu_Rect body = r;
  bool vertical = rows > page;
  if (vertical) body.w = re_max(0, body.w - RE_METRIC_SCROLLBAR_SIZE);
  re_scrollbar_set(&v->bar, mu_rect(body.x + body.w, body.y, vertical ? RE_METRIC_SCROLLBAR_SIZE : 0, body.h), rows, page, v->scroll, false);
  v->scroll = v->bar.value; return body;
}
void re_hex_event(ReHexView *v, const SDL_Event *e, mu_Rect r, int lh) {
  r = viewport(v, r, lh);
  if (re_scrollbar_event(&v->bar, e)) { v->scroll = v->bar.value; return; }
  int page = re_max(1, r.h / lh);
  if (e->type == SDL_MOUSEWHEEL) v->scroll = re_max(0, re_min(v->bar.maximum, v->scroll - re_wheel_steps(&v->wheel, &e->wheel, false, 3)));
  else if (e->type == SDL_KEYDOWN) {
    SDL_Keycode k = e->key.keysym.sym;
    int delta = k == SDLK_DOWN ? 1 : k == SDLK_UP ? -1 : k == SDLK_PAGEDOWN ? page : k == SDLK_PAGEUP ? -page : k == SDLK_END ? v->bar.maximum : k == SDLK_HOME ? -v->scroll : 0;
    v->scroll = re_max(0, re_min(v->bar.maximum, v->scroll + delta));
  }
}
void re_hex_draw(ReHexView *v, ReDraw *draw, mu_Rect r) {
  int lh = re_draw_line_height(draw); r = viewport(v, r, lh);
  re_draw_clip(draw, &r); re_draw_rect(draw, r, RE_COLOR_SURFACE);
  char text[128]; int rows = re_hex_rows(v);
  for (int row = v->scroll, y = r.y; row < rows && y < r.y + r.h; row++, y += lh) {
    re_hex_row(v, row, text, sizeof(text));
    re_draw_text(draw, text, 8, r.x, y, RE_COLOR_TEXT_MUTED); re_draw_text(draw, text + 8, -1, r.x + 8 * re_draw_cell_width(draw), y, RE_COLOR_TEXT);
  }
  re_draw_clip(draw, NULL); re_scrollbar_draw(&v->bar, draw);
}
void re_hex_inspect(const ReHexView *v, cJSON *j) {
  char text[128]; re_hex_row(v, 0, text, sizeof(text));
  cJSON_AddNumberToObject(j, "hexBase", (double)v->base); cJSON_AddNumberToObject(j, "hexSize", (double)v->size);
  cJSON_AddNumberToObject(j, "hexRows", re_hex_rows(v)); cJSON_AddNumberToObject(j, "hexScroll", v->scroll); cJSON_AddStringToObject(j, "hexFirstRow", text);
}
