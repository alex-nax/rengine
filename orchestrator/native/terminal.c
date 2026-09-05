#include "terminal.h"
#include <vterm.h>

struct ReTerminal {
  ReSocket *socket; char id[65];
  VTerm *vt; VTermScreen *screen;
  int cols, rows, sequence; bool attached, presented, waiting_for_view;
};
static void send(ReTerminal *t, cJSON *j) {
  cJSON_AddStringToObject(j, "id", t->id); char *bytes = cJSON_PrintUnformatted(j);
  if (bytes) re_socket_send(t->socket, bytes); free(bytes); cJSON_Delete(j);
}
static void output(const char *bytes, size_t size, void *user) {
  ReTerminal *t = user; char *text = malloc(size + 1); if (!text) return;
  memcpy(text, bytes, size); text[size] = 0;
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "type", "input"); cJSON_AddStringToObject(j, "data", text);
  free(text); send(t, j);
}
static void resize(ReTerminal *t, int cols, int rows) {
  t->cols = cols; t->rows = rows; vterm_set_size(t->vt, rows, cols);
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "type", "resize");
  cJSON_AddNumberToObject(j, "cols", cols); cJSON_AddNumberToObject(j, "rows", rows); send(t, j);
}
ReTerminal *re_terminal_open(ReSocket *socket, const char *id, int cols, int rows) {
  ReTerminal *t = calloc(1, sizeof(*t)); if (!t) return NULL;
  t->socket = socket; re_copy(t->id, sizeof(t->id), id); t->cols = cols; t->rows = rows;
  t->vt = vterm_new(rows, cols); if (!t->vt) { free(t); return NULL; }
  vterm_set_utf8(t->vt, 1); t->screen = vterm_obtain_screen(t->vt);
  vterm_screen_enable_altscreen(t->screen, 1);
  VTermColor fg, bg; vterm_color_rgb(&fg, 220, 228, 234); vterm_color_rgb(&bg, 20, 24, 30);
  vterm_state_set_default_colors(vterm_obtain_state(t->vt), &fg, &bg);
  vterm_screen_reset(t->screen, 1); vterm_output_set_callback(t->vt, output, t);
  re_terminal_attach(t); return t;
}
void re_terminal_close(ReTerminal *t) { if (t) { vterm_free(t->vt); free(t); } }
void re_terminal_attach(ReTerminal *t) {
  t->attached = t->presented = false;
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "type", "attach"); send(t, j);
}
void re_terminal_presented(ReTerminal *t) {
  if (!t->attached || t->presented || !t->waiting_for_view) return;
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "type", "presented"); send(t, j);
  t->presented = true;
}
void re_terminal_message(ReTerminal *t, const cJSON *j) {
  const char *type = re_string(j, "type");
  if (!strcmp(type, "attached")) {
    const cJSON *s = cJSON_GetObjectItemCaseSensitive(j, "session");
    if (strcmp(re_string(s, "id"), t->id)) return;
    t->waiting_for_view = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(s, "waitingForView"));
    int cols = re_number(s, "cols"), rows = re_number(s, "rows");
    if (cols >= 2 && cols <= 500 && rows >= 2 && rows <= 300) { t->cols = cols; t->rows = rows; vterm_set_size(t->vt, rows, cols); }
    vterm_screen_reset(t->screen, 1);
    const char *text = re_string(s, "output"); vterm_input_write(t->vt, text, strlen(text));
    t->sequence = re_number(s, "sequence"); t->attached = true;
  } else if (!strcmp(type, "output") && !strcmp(re_string(j, "id"), t->id) && t->attached) {
    int sequence = re_number(j, "sequence");
    if (sequence <= t->sequence) return;
    if (sequence != t->sequence + 1) { re_terminal_attach(t); return; }
    const char *text = re_string(j, "data"); vterm_input_write(t->vt, text, strlen(text)); t->sequence = sequence;
  }
  vterm_screen_flush_damage(t->screen);
}
void re_terminal_event(ReTerminal *t, const SDL_Event *e) {
  if (!t || !t->attached) return;
  if (e->type == SDL_TEXTINPUT) {
    const char *s = e->text.text; while (*s) vterm_keyboard_unichar(t->vt, re_utf8(&s), VTERM_MOD_NONE); return;
  }
  if (e->type != SDL_KEYDOWN) return;
  SDL_Keymod mod = (SDL_Keymod)e->key.keysym.mod;
  VTermModifier vm = (VTermModifier)(((mod & KMOD_SHIFT) ? VTERM_MOD_SHIFT : 0) |
    ((mod & KMOD_ALT) ? VTERM_MOD_ALT : 0) | ((mod & KMOD_CTRL) ? VTERM_MOD_CTRL : 0));
  SDL_Keycode key = e->key.keysym.sym;
  if (key == SDLK_v && ((mod & KMOD_GUI) || ((mod & KMOD_CTRL) && (mod & KMOD_SHIFT)))) {
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
  if (vk) vterm_keyboard_key(t->vt, vk, vm);
  else if ((mod & (KMOD_CTRL | KMOD_ALT)) && key >= 32 && key < 127) vterm_keyboard_unichar(t->vt, (uint32_t)key, vm);
}
void re_terminal_draw(ReTerminal *t, ReDraw *draw, mu_Rect r, bool focused) {
  int cw = re_draw_cell_width(draw), lh = re_draw_line_height(draw);
  int cols = re_max(2, re_min(500, r.w / cw)), rows = re_max(2, re_min(300, r.h / lh));
  if (t->attached && (cols != t->cols || rows != t->rows)) resize(t, cols, rows);
  re_draw_clip(draw, &r);
  for (int row = 0; row < t->rows; row++) for (int col = 0; col < t->cols; col++) {
    VTermScreenCell cell;
    if (!vterm_screen_get_cell(t->screen, (VTermPos){row, col}, &cell)) continue;
    vterm_screen_convert_color_to_rgb(t->screen, &cell.fg); vterm_screen_convert_color_to_rgb(t->screen, &cell.bg);
    mu_Color fg = mu_color(cell.fg.rgb.red, cell.fg.rgb.green, cell.fg.rgb.blue, 255);
    mu_Color bg = mu_color(cell.bg.rgb.red, cell.bg.rgb.green, cell.bg.rgb.blue, 255);
    if (cell.attrs.reverse) { mu_Color temp = fg; fg = bg; bg = temp; }
    int x = r.x + col * cw, y = r.y + row * lh;
    re_draw_rect(draw, mu_rect(x, y, cw * re_max(1, cell.width), lh), bg);
    if (cell.chars[0] && cell.chars[0] != UINT32_MAX) {
      char text[5]; re_encode(cell.chars[0], text); re_draw_text(draw, text, -1, x, y, fg);
      if (cell.attrs.bold) re_draw_text(draw, text, -1, x + 1, y, fg);
      if (cell.attrs.underline) re_draw_rect(draw, mu_rect(x, y + lh - 2, cw, 1), fg);
    }
  }
  if (focused) {
    VTermPos cursor; vterm_state_get_cursorpos(vterm_obtain_state(t->vt), &cursor);
    re_draw_rect(draw, mu_rect(r.x + cursor.col * cw, r.y + cursor.row * lh, cw, lh), mu_color(145, 205, 181, 100));
  }
  re_draw_clip(draw, NULL);
}
char *re_terminal_text(ReTerminal *t) {
  size_t capacity = (size_t)t->cols * t->rows * 6 + 1; char *text = malloc(capacity);
  if (text) { size_t size = vterm_screen_get_text(t->screen, text, capacity - 1, (VTermRect){0, t->rows, 0, t->cols}); text[size] = 0; }
  return text;
}
