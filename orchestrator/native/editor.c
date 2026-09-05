#include "editor.h"
#define STB_TEXTEDIT_CHARTYPE uint32_t
#define STB_TEXTEDIT_POSITIONTYPE int
#define STB_TEXTEDIT_UNDOCHARCOUNT 16384
#include "stb_textedit.h"

struct ReEditor {
  uint32_t *text; int length, capacity, revision;
  STB_TexteditState state;
  int scroll, horizontal, cw, lh;
  bool vim, insert, dragging; char pending, ignore_text;
};
#define KEY_BASE 0x200000
#define KEY_SHIFT 0x400000
#define KEY_LEFT (KEY_BASE + 1)
#define KEY_RIGHT (KEY_BASE + 2)
#define KEY_UP (KEY_BASE + 3)
#define KEY_DOWN (KEY_BASE + 4)
#define KEY_LINESTART (KEY_BASE + 5)
#define KEY_LINEEND (KEY_BASE + 6)
#define KEY_START (KEY_BASE + 7)
#define KEY_END (KEY_BASE + 8)
#define KEY_DELETE (KEY_BASE + 9)
#define KEY_BACKSPACE (KEY_BASE + 10)
#define KEY_UNDO (KEY_BASE + 11)
#define KEY_REDO (KEY_BASE + 12)
#define KEY_PAGEUP (KEY_BASE + 13)
#define KEY_PAGEDOWN (KEY_BASE + 14)

static bool insert_chars(ReEditor *e, int at, const uint32_t *text, int length) {
  if (length < 0 || e->length > 2 * 1024 * 1024 - length) return false;
  int needed = e->length + length;
  if (needed > e->capacity) {
    int capacity = re_max(needed, re_max(256, e->capacity * 2));
    uint32_t *next = realloc(e->text, (size_t)capacity * sizeof(*next));
    if (!next) return false; e->text = next; e->capacity = capacity;
  }
  memmove(e->text + at + length, e->text + at, (size_t)(e->length - at) * sizeof(*text));
  memcpy(e->text + at, text, (size_t)length * sizeof(*text)); e->length += length; e->revision++; return true;
}
static void delete_chars(ReEditor *e, int at, int length) {
  memmove(e->text + at, e->text + at + length, (size_t)(e->length - at - length) * sizeof(*e->text));
  e->length -= length; e->revision++;
}
static float char_width(ReEditor *e, int at) { return e->text[at] == '\t' ? e->cw * 4.0f : (float)e->cw; }
static void layout_row(StbTexteditRow *r, ReEditor *e, int start) {
  r->x0 = 0; r->x1 = 0; r->baseline_y_delta = (float)e->lh; r->ymin = 0; r->ymax = (float)e->lh;
  r->num_chars = 0;
  while (start + r->num_chars < e->length) {
    int at = start + r->num_chars++; if (e->text[at] == '\n') break; r->x1 += char_width(e, at);
  }
}
#define STB_TEXTEDIT_STRING ReEditor
#define STB_TEXTEDIT_STRINGLEN(e) ((e)->length)
#define STB_TEXTEDIT_GETCHAR(e, i) ((e)->text[i])
#define STB_TEXTEDIT_GETWIDTH(e, s, i) char_width(e, (s) + (i))
#define STB_TEXTEDIT_LAYOUTROW layout_row
#define STB_TEXTEDIT_DELETECHARS delete_chars
#define STB_TEXTEDIT_INSERTCHARS insert_chars
#define STB_TEXTEDIT_KEYTOTEXT(k) ((k) < KEY_BASE ? (k) : 0)
#define STB_TEXTEDIT_NEWLINE '\n'
#define STB_TEXTEDIT_K_LEFT KEY_LEFT
#define STB_TEXTEDIT_K_RIGHT KEY_RIGHT
#define STB_TEXTEDIT_K_UP KEY_UP
#define STB_TEXTEDIT_K_DOWN KEY_DOWN
#define STB_TEXTEDIT_K_LINESTART KEY_LINESTART
#define STB_TEXTEDIT_K_LINEEND KEY_LINEEND
#define STB_TEXTEDIT_K_TEXTSTART KEY_START
#define STB_TEXTEDIT_K_TEXTEND KEY_END
#define STB_TEXTEDIT_K_DELETE KEY_DELETE
#define STB_TEXTEDIT_K_BACKSPACE KEY_BACKSPACE
#define STB_TEXTEDIT_K_UNDO KEY_UNDO
#define STB_TEXTEDIT_K_REDO KEY_REDO
#define STB_TEXTEDIT_K_PGUP KEY_PAGEUP
#define STB_TEXTEDIT_K_PGDOWN KEY_PAGEDOWN
#define STB_TEXTEDIT_K_SHIFT KEY_SHIFT
#define STB_TEXTEDIT_IMPLEMENTATION
#include "stb_textedit.h"

ReEditor *re_editor_open(const char *text) {
  ReEditor *e = calloc(1, sizeof(*e)); if (!e) return NULL;
  e->cw = 8; e->lh = 20; e->insert = true;
  stb_textedit_initialize_state(&e->state, 0);
  const char *p = text;
  while (*p) {
    uint32_t cp = re_utf8(&p); if (cp == '\r') continue;
    if (!insert_chars(e, e->length, &cp, 1)) { re_editor_close(e); return NULL; }
  }
  e->revision = 0; return e;
}
void re_editor_close(ReEditor *e) { if (e) { free(e->text); free(e); } }
char *re_editor_text(ReEditor *e) {
  char *text = malloc((size_t)e->length * 4 + 1); if (!text) return NULL;
  size_t offset = 0;
  for (int i = 0; i < e->length; i++) offset += (size_t)re_encode(e->text[i], text + offset);
  text[offset] = 0; return text;
}
int re_editor_revision(const ReEditor *e) { return e->revision; }
void re_editor_vim(ReEditor *e, bool enabled) { e->vim = enabled; e->insert = !enabled; e->pending = 0; }
const char *re_editor_mode(const ReEditor *e) { return !e->vim ? "Edit" : e->insert ? "Vim INSERT" : "Vim NORMAL"; }
static void key(ReEditor *e, int k) { stb_textedit_key(e, &e->state, k); }
static void follow_cursor(ReEditor *e, int rows, int cols) {
  int row = 0, column = 0;
  for (int i = 0; i < e->state.cursor; i++) {
    if (e->text[i] == '\n') { row++; column = 0; } else column += e->text[i] == '\t' ? 4 : 1;
  }
  if (row < e->scroll) e->scroll = row;
  if (row >= e->scroll + rows) e->scroll = row - rows + 1;
  if (column < e->horizontal) e->horizontal = column;
  if (column >= e->horizontal + cols) e->horizontal = column - cols + 1;
}
static void vim_key(ReEditor *e, SDL_Keycode k) {
  char pending = e->pending; e->pending = 0;
  switch (k) {
    case SDLK_h: key(e, KEY_LEFT); break; case SDLK_l: key(e, KEY_RIGHT); break;
    case SDLK_j: key(e, KEY_DOWN); break; case SDLK_k: key(e, KEY_UP); break;
    case SDLK_0: key(e, KEY_LINESTART); break; case SDLK_DOLLAR: key(e, KEY_LINEEND); break;
    case SDLK_i: e->insert = true; e->ignore_text = 'i'; break;
    case SDLK_a: key(e, KEY_RIGHT); e->insert = true; e->ignore_text = 'a'; break;
    case SDLK_o: key(e, KEY_LINEEND); key(e, '\n'); e->insert = true; e->ignore_text = 'o'; break;
    case SDLK_x: key(e, KEY_DELETE); break; case SDLK_u: key(e, KEY_UNDO); break;
    case SDLK_g: if (pending == 'g') key(e, KEY_START); else e->pending = 'g'; break;
    case SDLK_d:
      if (pending == 'd') {
        key(e, KEY_LINESTART); int start = e->state.cursor;
        while (e->state.cursor < e->length && e->text[e->state.cursor] != '\n') e->state.cursor++;
        if (e->state.cursor < e->length) e->state.cursor++;
        e->state.select_start = start; e->state.select_end = e->state.cursor; key(e, KEY_DELETE);
      } else e->pending = 'd';
      break;
  }
}
void re_editor_event(ReEditor *e, const SDL_Event *event, mu_Rect r, int cw, int lh) {
  e->cw = cw; e->lh = lh; e->state.row_count_per_page = re_max(1, r.h / lh - 1);
  if (event->type == SDL_MOUSEWHEEL) { e->scroll = re_max(0, e->scroll - event->wheel.y * 3); return; }
  if (event->type == SDL_MOUSEBUTTONDOWN && event->button.button == SDL_BUTTON_LEFT) {
    e->dragging = true;
    stb_textedit_click(e, &e->state, (float)(event->button.x - r.x + e->horizontal * cw), (float)(event->button.y - r.y + e->scroll * lh)); return;
  }
  if (event->type == SDL_MOUSEBUTTONUP) { e->dragging = false; return; }
  if (event->type == SDL_MOUSEMOTION && e->dragging) {
    stb_textedit_drag(e, &e->state, (float)(event->motion.x - r.x + e->horizontal * cw), (float)(event->motion.y - r.y + e->scroll * lh)); return;
  }
  if (event->type == SDL_TEXTINPUT && (!e->vim || e->insert)) {
    bool ignore = e->ignore_text && event->text.text[0] == e->ignore_text && !event->text.text[1]; e->ignore_text = 0;
    if (ignore) return;
    const char *s = event->text.text; while (*s) key(e, (int)re_utf8(&s));
  }
  if (event->type == SDL_KEYDOWN) {
    e->ignore_text = 0;
    SDL_Keycode k = event->key.keysym.sym; SDL_Keymod mod = (SDL_Keymod)event->key.keysym.mod;
    bool command = (mod & (KMOD_CTRL | KMOD_GUI)) != 0; int shift = mod & KMOD_SHIFT ? KEY_SHIFT : 0;
    if (k == SDLK_ESCAPE && e->vim) { e->insert = false; e->pending = 0; return; }
    if (command && k == SDLK_a) { e->state.select_start = 0; e->state.select_end = e->state.cursor = e->length; }
    else if (command && k == SDLK_z) key(e, shift ? KEY_REDO : KEY_UNDO);
    else if (command && k == SDLK_r && e->vim) key(e, KEY_REDO);
    else if (command && (k == SDLK_c || k == SDLK_x)) {
      int begin = re_min(e->state.select_start, e->state.select_end), end = re_max(e->state.select_start, e->state.select_end);
      char *text = malloc((size_t)(end - begin) * 4 + 1); size_t at = 0;
      if (text) { for (int i = begin; i < end; i++) at += (size_t)re_encode(e->text[i], text + at); text[at] = 0; SDL_SetClipboardText(text); free(text); }
      if (k == SDLK_x) stb_textedit_cut(e, &e->state);
    } else if (command && k == SDLK_v) {
      char *paste = SDL_GetClipboardText();
      ReEditor *temp = re_editor_open(paste ? paste : "");
      if (temp) { stb_textedit_paste(e, &e->state, temp->text, temp->length); re_editor_close(temp); } SDL_free(paste);
    } else if (e->vim && !e->insert && !command) {
      if (k == SDLK_g && shift) key(e, KEY_END);
      else if (k == SDLK_4 && shift) key(e, KEY_LINEEND);
      else vim_key(e, k);
    } else if (!command) switch (k) {
      case SDLK_LEFT: key(e, KEY_LEFT | shift); break; case SDLK_RIGHT: key(e, KEY_RIGHT | shift); break;
      case SDLK_UP: key(e, KEY_UP | shift); break; case SDLK_DOWN: key(e, KEY_DOWN | shift); break;
      case SDLK_HOME: key(e, KEY_LINESTART | shift); break; case SDLK_END: key(e, KEY_LINEEND | shift); break;
      case SDLK_PAGEUP: key(e, KEY_PAGEUP | shift); break; case SDLK_PAGEDOWN: key(e, KEY_PAGEDOWN | shift); break;
      case SDLK_DELETE: key(e, KEY_DELETE); break; case SDLK_BACKSPACE: key(e, KEY_BACKSPACE); break;
      case SDLK_RETURN: key(e, '\n'); break; case SDLK_TAB: key(e, '\t'); break;
    }
  }
  if (event->type == SDL_TEXTINPUT || event->type == SDL_KEYDOWN) follow_cursor(e, re_max(1, r.h / lh), re_max(1, r.w / cw));
}
void re_editor_draw(ReEditor *e, ReDraw *draw, mu_Rect r, bool focused) {
  e->cw = re_draw_cell_width(draw); e->lh = re_draw_line_height(draw);
  re_draw_clip(draw, &r); re_draw_rect(draw, r, mu_color(20, 24, 30, 255));
  int row = 0, col = 0, selection_a = re_min(e->state.select_start, e->state.select_end), selection_b = re_max(e->state.select_start, e->state.select_end);
  for (int i = 0; i <= e->length; i++) {
    int x = r.x + (col - e->horizontal) * e->cw, y = r.y + (row - e->scroll) * e->lh;
    if (y >= r.y + r.h) break;
    if (row >= e->scroll) {
      if (i >= selection_a && i < selection_b) re_draw_rect(draw, mu_rect(x, y, e->cw, e->lh), mu_color(55, 77, 89, 255));
      if (focused && i == e->state.cursor) re_draw_rect(draw, mu_rect(x, y, e->vim && !e->insert ? e->cw : 2, e->lh), mu_color(150, 210, 185, 190));
      if (i < e->length && e->text[i] != '\n' && e->text[i] != '\t') { char text[5]; re_encode(e->text[i], text); re_draw_text(draw, text, -1, x, y, mu_color(220, 228, 234, 255)); }
    }
    if (i < e->length && e->text[i] == '\n') { row++; col = 0; } else col += i < e->length && e->text[i] == '\t' ? 4 : 1;
  }
  re_draw_clip(draw, NULL);
}
