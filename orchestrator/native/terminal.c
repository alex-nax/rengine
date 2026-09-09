#include "terminal.h"
#include "filelink.h"
#include <vterm.h>

#define RE_HISTORY_LINES 2000
#define RE_HISTORY_BYTES (8 * 1024 * 1024)
typedef struct { int cols; VTermScreenCell cells[]; } HistoryLine;
struct ReTerminal {
  ReSocket *socket; char id[65];
  mu_Color palette_fg, palette_bg;              /* the theme the vterm defaults were set from */
  VTerm *vt; VTermScreen *screen;
  int cols, rows, sequence; bool attached, presented, waiting_for_view;
  HistoryLine *history[RE_HISTORY_LINES]; int first, count, offset; size_t history_bytes;
  float wheel; bool alternate, cursor_visible;
  ReScrollbar scrollbar;
  mu_Rect content; int cw, lh, mouse_mode, mouse_buttons;
  float mouse_wheel_x, mouse_wheel_y; bool mute_output;
  /* vterm hands us keyboard/mouse bytes one call per character. One socket message per
     character overran the 128-deep outgoing queue and lost the rest of a paste in silence,
     so the bytes of one event are gathered here and leave as a single message. */
  char *out; size_t out_len, out_cap; int out_messages; size_t out_bytes, out_dropped;
};
static size_t line_bytes(int cols) { return sizeof(HistoryLine) + (size_t)cols * sizeof(VTermScreenCell); }
static void blank_cell(ReTerminal *t, VTermScreenCell *cell) {
  memset(cell, 0, sizeof(*cell)); cell->width = 1;
  vterm_state_get_default_colors(vterm_obtain_state(t->vt), &cell->fg, &cell->bg);
}
static int history_clear(void *user) {
  ReTerminal *t = user;
  for (int i = 0; i < t->count; i++) free(t->history[(t->first + i) % RE_HISTORY_LINES]);
  t->first = t->count = t->offset = 0; t->history_bytes = 0; t->wheel = 0; return 1;
}
static int history_push(int cols, const VTermScreenCell *cells, void *user) {
  ReTerminal *t = user; size_t bytes = line_bytes(cols);
  HistoryLine *line = malloc(bytes); if (!line) return 0;
  line->cols = cols; memcpy(line->cells, cells, (size_t)cols * sizeof(*cells));
  while (t->count && (t->count == RE_HISTORY_LINES || t->history_bytes + bytes > RE_HISTORY_BYTES)) {
    HistoryLine *old = t->history[t->first]; t->history_bytes -= line_bytes(old->cols); free(old);
    t->first = (t->first + 1) % RE_HISTORY_LINES; t->count--;
  }
  t->history[(t->first + t->count++) % RE_HISTORY_LINES] = line; t->history_bytes += bytes;
  if (t->offset) t->offset = re_min(t->count, t->offset + 1); return 1;
}
static int history_pop(int cols, VTermScreenCell *cells, void *user) {
  ReTerminal *t = user; if (!t->count) return 0;
  HistoryLine *line = t->history[(t->first + --t->count) % RE_HISTORY_LINES];
  for (int i = 0; i < cols; i++) { if (i < line->cols) cells[i] = line->cells[i]; else blank_cell(t, &cells[i]); }
  t->history_bytes -= line_bytes(line->cols); free(line);
  if (t->offset) t->offset--; return 1;
}
static int property(VTermProp prop, VTermValue *value, void *user) {
  ReTerminal *t = user;
  if (prop == VTERM_PROP_ALTSCREEN) { t->alternate = value->boolean; t->offset = 0; t->wheel = 0; }
  if (prop == VTERM_PROP_CURSORVISIBLE) t->cursor_visible = value->boolean;
  if (prop == VTERM_PROP_MOUSE) { t->mouse_mode = value->number; t->mouse_wheel_x = t->mouse_wheel_y = 0; }
  return 1;
}
static const VTermScreenCallbacks callbacks = {
  .settermprop = property, .sb_pushline = history_push, .sb_popline = history_pop, .sb_clear = history_clear
};
static bool view_cell(ReTerminal *t, int row, int col, VTermScreenCell *cell) {
  int screen_row = row - t->offset;
  if (screen_row >= 0) return vterm_screen_get_cell(t->screen, (VTermPos){screen_row, col}, cell);
  HistoryLine *line = t->history[(t->first + t->count + screen_row) % RE_HISTORY_LINES];
  if (col < line->cols) *cell = line->cells[col]; else blank_cell(t, cell);
  return true;
}
static void send(ReTerminal *t, cJSON *j) {
  cJSON_AddStringToObject(j, "id", t->id); char *bytes = cJSON_PrintUnformatted(j);
  if (bytes) re_socket_send(t->socket, bytes); free(bytes); cJSON_Delete(j);
}
static void output(const char *bytes, size_t size, void *user) {
  ReTerminal *t = user; if (t->mute_output || !size) return;
  if (t->out_len + size + 1 > t->out_cap) {
    size_t cap = t->out_cap ? t->out_cap * 2 : 1024;
    while (cap < t->out_len + size + 1) cap *= 2;
    char *next = realloc(t->out, cap); if (!next) { t->out_dropped += size; return; }
    t->out = next; t->out_cap = cap;
  }
  memcpy(t->out + t->out_len, bytes, size); t->out_len += size;
}
static void release(ReTerminal *t); /* the raw handler; the public wrapper adds the flush */
/* One message would be simplest, but the session host reads these with maxPayload 2 MB and ws
   CLOSES the connection on an oversized frame, so an unbounded paste would cost the session rather
   than the tail of the text. Chunked well below it: JSON escaping can turn one control byte into
   six characters, so 128 KiB of terminal bytes stays under the limit at any escaping. */
#define RE_TERMINAL_CHUNK (128 * 1024)
/* Every entry point that can make vterm emit ends here, so a paste, a burst of typing or a wheel
   run crosses the socket in a handful of messages instead of one per character. */
static void flush_output(ReTerminal *t) {
  size_t at = 0;
  while (at < t->out_len) {
    size_t take = t->out_len - at < RE_TERMINAL_CHUNK ? t->out_len - at : RE_TERMINAL_CHUNK;
    /* Never split a UTF-8 sequence: both halves would be invalid and cJSON would carry the damage
       into the PTY. Walk back off any continuation byte; a lone oversized sequence cannot happen. */
    if (at + take < t->out_len) {
      size_t back = take;
      while (back && ((unsigned char)t->out[at + back] & 0xC0) == 0x80) back--;
      if (back) take = back;
    }
    char saved = t->out[at + take]; t->out[at + take] = 0;
    cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "type", "input");
    cJSON_AddStringToObject(j, "data", t->out + at);
    t->out[at + take] = saved;
    t->out_messages++; t->out_bytes += take;
    send(t, j);
    at += take;
  }
  t->out_len = 0;
}
static void resize(ReTerminal *t, int cols, int rows) {
  t->cols = cols; t->rows = rows; vterm_set_size(t->vt, rows, cols);
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "type", "resize");
  cJSON_AddNumberToObject(j, "cols", cols); cJSON_AddNumberToObject(j, "rows", rows); send(t, j);
}
/* vterm keeps its default colours in its own state, so a live preset switch has to push them again. */
static void apply_palette(ReTerminal *t) {
  mu_Color text = RE_COLOR_TERMINAL_FG, surface = RE_COLOR_TERMINAL_BG;
  VTermColor fg, bg;
  vterm_color_rgb(&fg, text.r, text.g, text.b); vterm_color_rgb(&bg, surface.r, surface.g, surface.b);
  vterm_state_set_default_colors(vterm_obtain_state(t->vt), &fg, &bg);
  t->palette_fg = text; t->palette_bg = surface;
}
static bool palette_changed(const ReTerminal *t) {
  mu_Color text = RE_COLOR_TERMINAL_FG, surface = RE_COLOR_TERMINAL_BG;
  return memcmp(&text, &t->palette_fg, sizeof(text)) || memcmp(&surface, &t->palette_bg, sizeof(surface));
}
static bool reset_screen(ReTerminal *t) {
  VTerm *vt = vterm_new(t->rows, t->cols); if (!vt) return false;
  history_clear(t); if (t->vt) vterm_free(t->vt); t->vt = vt;
  t->mouse_mode = 0; t->alternate = false;
  vterm_set_utf8(t->vt, 1); t->screen = vterm_obtain_screen(t->vt);
  t->cursor_visible = true; vterm_screen_set_callbacks(t->screen, &callbacks, t);
  vterm_screen_enable_altscreen(t->screen, 1);
  apply_palette(t);
  vterm_screen_reset(t->screen, 1); vterm_output_set_callback(t->vt, output, t); return true;
}
ReTerminal *re_terminal_open(ReSocket *socket, const char *id, int cols, int rows) {
  ReTerminal *t = calloc(1, sizeof(*t)); if (!t) return NULL;
  t->socket = socket; re_copy(t->id, sizeof(t->id), id); t->cols = cols; t->rows = rows;
  if (!reset_screen(t)) { free(t); return NULL; }
  re_terminal_attach(t); return t;
}
void re_terminal_close(ReTerminal *t) { if (t) { release(t); history_clear(t); vterm_free(t->vt); free(t->out); free(t); } }
bool re_terminal_ready(ReTerminal *t) { return t && t->attached; }
ReTerminalScroll re_terminal_scroll_state(ReTerminal *t) { return (ReTerminalScroll){t->count, t->offset, t->history_bytes}; }
void re_terminal_scrollbars(ReTerminal *t, cJSON *array) { re_scrollbar_inspect(&t->scrollbar, array); }
void re_terminal_inspect_mouse(ReTerminal *t, cJSON *object) {
  cJSON_AddNumberToObject(object, "mouseMode", t->mouse_mode);
  cJSON_AddItemToObject(object, "cellSize", cJSON_CreateIntArray((int[]){t->cw, t->lh}, 2));
  cJSON_AddItemToObject(object, "terminalSize", cJSON_CreateIntArray((int[]){t->cols, t->rows}, 2));
}
void re_terminal_attach(ReTerminal *t) {
  release(t);
  t->attached = t->presented = false;
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "type", "attach"); send(t, j);
}
void re_terminal_presented(ReTerminal *t) {
  if (!t->attached || t->presented || !t->waiting_for_view) return;
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "type", "presented"); send(t, j);
  t->presented = true;
}
static void message_in(ReTerminal *t, const cJSON *j) {
  const char *type = re_string(j, "type");
  if (!strcmp(type, "disconnected")) { t->attached = t->presented = false; release(t); }
  else if (!strcmp(type, "attached")) {
    const cJSON *s = cJSON_GetObjectItemCaseSensitive(j, "session");
    if (strcmp(re_string(s, "id"), t->id)) return;
    release(t); t->attached = false;
    t->waiting_for_view = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(s, "waitingForView"));
    int cols = re_number(s, "cols"), rows = re_number(s, "rows");
    if (cols >= 2 && cols <= 500 && rows >= 2 && rows <= 300) { t->cols = cols; t->rows = rows; }
    if (!reset_screen(t)) return;
    const char *text = re_string(s, "output"); t->mute_output = true;
    vterm_input_write(t->vt, text, strlen(text)); t->mute_output = false;
    t->sequence = re_number(s, "sequence"); t->attached = true;
  } else if (!strcmp(type, "output") && !strcmp(re_string(j, "id"), t->id) && t->attached) {
    int sequence = re_number(j, "sequence");
    if (sequence <= t->sequence) return;
    if (sequence != t->sequence + 1) { re_terminal_attach(t); return; }
    const char *text = re_string(j, "data"); vterm_input_write(t->vt, text, strlen(text)); t->sequence = sequence;
  }
  vterm_screen_flush_damage(t->screen);
}
static VTermModifier modifiers(SDL_Keymod mod) {
  return (VTermModifier)(((mod & KMOD_SHIFT) ? VTERM_MOD_SHIFT : 0) |
    ((mod & KMOD_ALT) ? VTERM_MOD_ALT : 0) | ((mod & KMOD_CTRL) ? VTERM_MOD_CTRL : 0));
}
bool re_terminal_mouse_held(ReTerminal *t) { return t && t->mouse_buttons; }
static void release(ReTerminal *t) {
  if (!t) return;
  t->mute_output = !t->attached;
  for (int button = 1; button <= 3; button++) if (t->mouse_buttons & (1 << button)) vterm_mouse_button(t->vt, button, false, VTERM_MOD_NONE);
  if (t->mouse_buttons) SDL_CaptureMouse(SDL_FALSE);
  t->mouse_buttons = 0; t->mouse_wheel_x = t->mouse_wheel_y = 0; t->mute_output = false;
}
static bool mouse_event(ReTerminal *t, const SDL_Event *e, int x, int y) {
  if (!t || !t->attached || !t->cw || !t->lh || t->scrollbar.dragging) return false;
  bool inside = re_inside(t->content, x, y);
  int button = e->type == SDL_MOUSEBUTTONDOWN || e->type == SDL_MOUSEBUTTONUP ?
    (e->button.button == SDL_BUTTON_LEFT ? 1 : e->button.button == SDL_BUTTON_MIDDLE ? 2 : e->button.button == SDL_BUTTON_RIGHT ? 3 : 0) : 0;
  bool release = e->type == SDL_MOUSEBUTTONUP && button && (t->mouse_buttons & (1 << button));
  if (!release && (!t->mouse_mode || t->offset || (!inside && !t->mouse_buttons))) return false;
  SDL_Keymod mod = SDL_GetModState(); VTermModifier vm = modifiers(mod);
  if (e->type == SDL_MOUSEWHEEL && (!inside || ((mod & KMOD_SHIFT) && !t->alternate))) return false;
  if (e->type == SDL_MOUSEBUTTONDOWN && (!inside || !button)) return false;
  if (e->type == SDL_MOUSEBUTTONUP && !release) return false;
  int col = re_max(0, re_min(t->cols - 1, (x - t->content.x) / t->cw));
  int row = re_max(0, re_min(t->rows - 1, (y - t->content.y) / t->lh));
  vterm_mouse_move(t->vt, row, col, vm);
  if (button) {
    bool down = e->type == SDL_MOUSEBUTTONDOWN;
    vterm_mouse_button(t->vt, button, down, vm);
    if (down) t->mouse_buttons |= 1 << button; else t->mouse_buttons &= ~(1 << button);
    SDL_CaptureMouse(t->mouse_buttons ? SDL_TRUE : SDL_FALSE);
  } else if (e->type == SDL_MOUSEWHEEL) {
    int vertical = re_wheel_steps(&t->mouse_wheel_y, &e->wheel, false, 1);
    int horizontal = re_wheel_steps(&t->mouse_wheel_x, &e->wheel, true, 1);
    for (int i = 0; i < abs(vertical); i++) vterm_mouse_button(t->vt, vertical > 0 ? 4 : 5, true, vm);
    for (int i = 0; i < abs(horizontal); i++) vterm_mouse_button(t->vt, horizontal > 0 ? 7 : 6, true, vm);
  }
  return true;
}
static void key_event(ReTerminal *t, const SDL_Event *e) {
  if (!t) return;
  if (e->type == SDL_WINDOWEVENT && e->window.event == SDL_WINDOWEVENT_FOCUS_LOST) release(t);
  if (re_scrollbar_event(&t->scrollbar, e)) { t->offset = re_max(0, t->count - t->scrollbar.value); t->wheel = 0; return; }
  if (e->type == SDL_MOUSEWHEEL) {
    if (t->alternate) return;
    int lines = re_wheel_steps(&t->wheel, &e->wheel, false, 3);
    t->offset = re_max(0, re_min(t->count, t->offset + lines)); return;
  }
  if (e->type == SDL_KEYDOWN && (e->key.keysym.mod & KMOD_SHIFT)) {
    SDL_Keycode key = e->key.keysym.sym; int amount = re_max(1, t->rows - 1);
    if (key == SDLK_PAGEUP || key == SDLK_PAGEDOWN || key == SDLK_HOME || key == SDLK_END) {
      if (!t->alternate) {
        if (key == SDLK_HOME) t->offset = t->count;
        else if (key == SDLK_END) t->offset = 0;
        else t->offset = re_max(0, re_min(t->count, t->offset + (key == SDLK_PAGEUP ? amount : -amount)));
        t->wheel = 0; return;
      }
    }
  }
  if (!t->attached) return;
  if (e->type == SDL_TEXTINPUT) {
    t->offset = 0; t->wheel = 0;
    const char *s = e->text.text; while (*s) vterm_keyboard_unichar(t->vt, re_utf8(&s), VTERM_MOD_NONE); return;
  }
  if (e->type != SDL_KEYDOWN) return;
  SDL_Keymod mod = (SDL_Keymod)e->key.keysym.mod;
  VTermModifier vm = modifiers(mod);
  SDL_Keycode key = e->key.keysym.sym;
  if (key == SDLK_v && ((mod & KMOD_GUI) || ((mod & KMOD_CTRL) && (mod & KMOD_SHIFT)))) {
    t->offset = 0; t->wheel = 0;
    char *paste = SDL_GetClipboardText(); vterm_keyboard_start_paste(t->vt);
    const char *p = paste; while (p && *p) vterm_keyboard_unichar(t->vt, re_utf8(&p), VTERM_MOD_NONE);
    vterm_keyboard_end_paste(t->vt); SDL_free(paste); return;
  }
  VTermKey vk = VTERM_KEY_NONE;
  switch (key) {
    case SDLK_RETURN: case SDLK_KP_ENTER: vk = VTERM_KEY_ENTER; break;
    case SDLK_TAB: vk = VTERM_KEY_TAB; break;
    case SDLK_BACKSPACE: vk = VTERM_KEY_BACKSPACE; break;
    case SDLK_ESCAPE: vk = VTERM_KEY_ESCAPE; break;
    case SDLK_UP: vk = VTERM_KEY_UP; break; case SDLK_DOWN: vk = VTERM_KEY_DOWN; break;
    case SDLK_LEFT: vk = VTERM_KEY_LEFT; break; case SDLK_RIGHT: vk = VTERM_KEY_RIGHT; break;
    case SDLK_HOME: vk = VTERM_KEY_HOME; break; case SDLK_END: vk = VTERM_KEY_END; break;
    case SDLK_PAGEUP: vk = VTERM_KEY_PAGEUP; break; case SDLK_PAGEDOWN: vk = VTERM_KEY_PAGEDOWN; break;
    case SDLK_DELETE: vk = VTERM_KEY_DEL; break; case SDLK_INSERT: vk = VTERM_KEY_INS; break;
    default: if (key >= SDLK_F1 && key <= SDLK_F12) vk = (VTermKey)VTERM_KEY_FUNCTION(key - SDLK_F1 + 1); break;
  }
  if (vk) { t->offset = 0; t->wheel = 0; vterm_keyboard_key(t->vt, vk, vm); }
  else if ((mod & (KMOD_CTRL | KMOD_ALT)) && key >= 32 && key < 127) {
    t->offset = 0; t->wheel = 0; vterm_keyboard_unichar(t->vt, (uint32_t)key, vm);
  }
}
/* The public boundary: run the handler, then let one message carry everything it produced. */
void re_terminal_release(ReTerminal *t) { if (!t) return; release(t); flush_output(t); }
bool re_terminal_mouse(ReTerminal *t, const SDL_Event *e, int x, int y) {
  bool handled = mouse_event(t, e, x, y); if (t) flush_output(t); return handled;
}
void re_terminal_event(ReTerminal *t, const SDL_Event *e) { key_event(t, e); if (t) flush_output(t); }
void re_terminal_message(ReTerminal *t, const cJSON *j) { message_in(t, j); if (t) flush_output(t); }
void re_terminal_inspect_output(ReTerminal *t, cJSON *object) {
  if (!t) return;
  cJSON_AddNumberToObject(object, "outputMessages", t->out_messages);
  cJSON_AddNumberToObject(object, "outputBytes", (double)t->out_bytes);
  cJSON_AddNumberToObject(object, "outputDropped", (double)t->out_dropped);
}
void re_terminal_draw(ReTerminal *t, ReDraw *draw, mu_Rect r, bool focused) {
  if (palette_changed(t)) apply_palette(t); /* the preset switched under a live terminal */
  mu_Rect track = mu_rect(r.x + re_max(0, r.w - RE_METRIC_SCROLLBAR_SIZE), r.y, RE_METRIC_SCROLLBAR_SIZE, r.h);
  r.w = re_max(0, r.w - RE_METRIC_SCROLLBAR_SIZE);
  int cw = re_draw_cell_width(draw), lh = re_draw_line_height(draw);
  int cols = re_max(2, re_min(500, r.w / cw)), rows = re_max(2, re_min(300, r.h / lh));
  t->cw = cw; t->lh = lh; t->content = mu_rect(r.x, r.y, re_min(r.w, cols * cw), re_min(r.h, rows * lh));
  if (t->attached && (cols != t->cols || rows != t->rows)) resize(t, cols, rows);
  re_scrollbar_set(&t->scrollbar, track, t->rows + (t->alternate ? 0 : t->count), t->rows, t->count - t->offset, false);
  re_draw_clip(draw, &r);
  for (int row = 0; row < t->rows; row++) for (int col = 0; col < t->cols; col++) {
    VTermScreenCell cell;
    if (!view_cell(t, row, col, &cell)) continue;
    /* A cell that carries the default colour follows the live theme; only explicit SGR colours are
     * kept as written, so a preset switch restyles history the terminal already produced. */
    bool default_fg = VTERM_COLOR_IS_DEFAULT_FG(&cell.fg), default_bg = VTERM_COLOR_IS_DEFAULT_BG(&cell.bg);
    vterm_screen_convert_color_to_rgb(t->screen, &cell.fg); vterm_screen_convert_color_to_rgb(t->screen, &cell.bg);
    mu_Color fg = default_fg ? RE_COLOR_TERMINAL_FG : mu_color(cell.fg.rgb.red, cell.fg.rgb.green, cell.fg.rgb.blue, 255);
    mu_Color bg = default_bg ? RE_COLOR_TERMINAL_BG : mu_color(cell.bg.rgb.red, cell.bg.rgb.green, cell.bg.rgb.blue, 255);
    if (cell.attrs.reverse) { mu_Color temp = fg; fg = bg; bg = temp; }
    int x = r.x + col * cw, y = r.y + row * lh;
    re_draw_rect(draw, mu_rect(x, y, cw * re_max(1, cell.width), lh), bg);
    if (cell.chars[0] && cell.chars[0] != UINT32_MAX) {
      char text[5]; re_encode(cell.chars[0], text); re_draw_text(draw, text, -1, x, y, fg);
      if (cell.attrs.bold) re_draw_text(draw, text, -1, x + 1, y, fg);
      if (cell.attrs.underline) re_draw_rect(draw, mu_rect(x, y + lh - 2, cw, 1), fg);
    }
  }
  if (focused && !t->offset && t->cursor_visible) {
    VTermPos cursor; vterm_state_get_cursorpos(vterm_obtain_state(t->vt), &cursor);
    re_draw_rect(draw, mu_rect(r.x + cursor.col * cw, r.y + cursor.row * lh, cw, lh), RE_COLOR_TERMINAL_CURSOR);
  }
  if (t->offset) {
    char label[96]; snprintf(label, sizeof(label), "%d lines above live · Shift+End", t->offset);
    int width = re_min(r.w, (int)strlen(label) * cw);
    re_draw_rect(draw, mu_rect(r.x + r.w - width, r.y + r.h - lh, width, lh), RE_COLOR_INDICATOR);
    re_draw_text(draw, label, -1, r.x + r.w - width, r.y + r.h - lh, RE_COLOR_TEXT_INDICATOR);
  }
  re_draw_clip(draw, NULL);
  re_scrollbar_draw(&t->scrollbar, draw);
}
char *re_terminal_text(ReTerminal *t) {
  size_t capacity = (size_t)t->rows * ((size_t)t->cols * VTERM_MAX_CHARS_PER_CELL * 4 + 1) + 1;
  char *text = malloc(capacity); if (!text) return NULL; size_t size = 0;
  for (int row = 0; row < t->rows; row++) {
    size_t end = size;
    for (int col = 0; col < t->cols; col++) {
      VTermScreenCell cell; if (!view_cell(t, row, col, &cell)) continue;
      if (cell.chars[0] == UINT32_MAX) continue;
      if (!cell.chars[0]) text[size++] = ' ';
      else for (int i = 0; i < VTERM_MAX_CHARS_PER_CELL && cell.chars[i]; i++) {
        char encoded[5]; int bytes = re_encode(cell.chars[i], encoded); memcpy(text + size, encoded, bytes); size += bytes; end = size;
      }
    }
    size = end; text[size++] = '\n';
  }
  text[size] = 0;
  return text;
}
bool re_terminal_file_at(ReTerminal *t, int x, int y, char *target, size_t capacity) {
  if (!t || !t->cw || !t->lh || !re_inside(t->content, x, y) || t->scrollbar.dragging) return false;
  int row = (y - t->content.y) / t->lh, column = (x - t->content.x) / t->cw;
  VTermScreenCell clicked;
  if (!view_cell(t, row, column, &clicked) || !clicked.chars[0] || clicked.chars[0] == ' ') return false;
  char text[16384]; size_t size = 0, at = 0;
  for (int r = re_max(0, row - 2); r < re_min(t->rows, row + 3); r++) {
    bool full = false; size_t end = size;
    for (int c = 0; c < t->cols && size + 5 < sizeof(text); c++) {
      VTermScreenCell cell; if (!view_cell(t, r, c, &cell)) break;
      if (r == row && c == column) at = size;
      if (cell.chars[0] == UINT32_MAX) { if (r == row && c == column && size) at = size - 1; continue; }
      uint32_t ch = cell.chars[0] ? cell.chars[0] : ' '; char encoded[5];
      int bytes = re_encode(ch, encoded); memcpy(text + size, encoded, (size_t)bytes); size += (size_t)bytes;
      full = ch != ' ';
      if (full) end = size;
    }
    if (!full) { size = end; if (size + 1 < sizeof(text)) text[size++] = '\n'; }
  }
  text[size] = 0; return re_file_reference(text, at, target, capacity);
}
