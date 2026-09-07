#include "editor.h"
#include "syntax.h"
#include "render/syntax_theme.h"
#define STB_TEXTEDIT_CHARTYPE uint32_t
#define STB_TEXTEDIT_POSITIONTYPE int
#define STB_TEXTEDIT_UNDOCHARCOUNT 16384
#include "stb_textedit.h"

#define RE_EDITOR_DIAGNOSTICS 256
typedef struct { int start_line, start_character, end_line, end_character, severity; } ReDiagnostic;

struct ReEditor {
  uint32_t *text; int length, capacity, revision;
  ReDiagnostic diagnostics[RE_EDITOR_DIAGNOSTICS]; int diagnostic_count;
  STB_TexteditState state;
  int scroll, horizontal, cw, lh;
  bool vim, insert, dragging, readonly; char pending, ignore_text;
  ReScrollbar vertical, horizontal_bar; float wheel_x, wheel_y;
  int extent_revision, line_count, longest_line;
  int language;                       /* RE_LANG_*; PLAIN draws without spans */
  uint32_t *line_state; int state_count, state_revision; /* carry state per line, so a scroll is not a rescan */
};
static int editor_scheme = RE_SCHEME_DESIGN;   /* one scheme for every editor, like an IDE's setting */
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
  if (e->readonly || length < 0 || e->length > 2 * 1024 * 1024 - length) return false;
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
  if (e->readonly) return;
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
  e->revision = 0; e->extent_revision = -1; return e;
}
void re_editor_close(ReEditor *e) { if (e) { free(e->line_state); free(e->text); free(e); } }
char *re_editor_text(ReEditor *e) {
  char *text = malloc((size_t)e->length * 4 + 1); if (!text) return NULL;
  size_t offset = 0;
  for (int i = 0; i < e->length; i++) offset += (size_t)re_encode(e->text[i], text + offset);
  text[offset] = 0; return text;
}
int re_editor_revision(const ReEditor *e) { return e->revision; }
void re_editor_vim(ReEditor *e, bool enabled) { e->vim = enabled; e->insert = !enabled; e->pending = 0; }
void re_editor_language(ReEditor *e, const char *filename) {
  if (e) { e->language = re_syntax_language(filename); e->state_revision = -1; }
}
int re_editor_scheme(const char *name) {
  for (int i = 0; i < RE_SCHEME_COUNT; i++) if (name && !strcmp(name, re_scheme_names[i])) { editor_scheme = i; return i; }
  return -1;
}
void re_editor_readonly(ReEditor *e, bool enabled) { e->readonly = enabled; }
const char *re_editor_mode(const ReEditor *e) { return !e->vim ? "Edit" : e->insert ? "Vim INSERT" : "Vim NORMAL"; }
void re_editor_scrollbars(ReEditor *e, cJSON *array) { re_scrollbar_inspect(&e->vertical, array); re_scrollbar_inspect(&e->horizontal_bar, array); }

/* One walk of the buffer converts both ends: the position is a line and a UTF-16 column, so a
   character outside the basic plane advances the column by two while a tab advances it by one. */
static void position(const ReEditor *e, int offset, int *line, int *character) {
  *line = 0; *character = 0;
  for (int i = 0; i < offset && i < e->length; i++) {
    if (e->text[i] == '\n') { (*line)++; *character = 0; }
    else *character += e->text[i] > 0xFFFF ? 2 : 1;
  }
}

/* Severity is the protocol's: 1 error, 2 warning, 3 information, 4 hint. Anything else is drawn as
   information rather than dropped, because a server inventing a severity is still telling us
   something is there. */
static mu_Color diagnostic_colour(int severity) {
  if (severity == 1) return RE_COLOR_ERR;
  if (severity == 2) return RE_COLOR_WARN;
  return RE_COLOR_INFO;
}

void re_editor_diagnostics(ReEditor *e, const cJSON *items) {
  if (!e) return;
  e->diagnostic_count = 0;
  const cJSON *item = NULL;
  cJSON_ArrayForEach(item, items) {
    if (e->diagnostic_count >= RE_EDITOR_DIAGNOSTICS) break;
    const cJSON *range = cJSON_GetObjectItemCaseSensitive(item, "range");
    const cJSON *start = cJSON_GetObjectItemCaseSensitive(range, "start");
    const cJSON *end = cJSON_GetObjectItemCaseSensitive(range, "end");
    if (!cJSON_IsObject(start) || !cJSON_IsObject(end)) continue;
    ReDiagnostic *d = &e->diagnostics[e->diagnostic_count++];
    d->start_line = (int)re_number(start, "line"); d->start_character = (int)re_number(start, "character");
    d->end_line = (int)re_number(end, "line"); d->end_character = (int)re_number(end, "character");
    d->severity = (int)re_number(item, "severity");
  }
}

int re_editor_diagnostic_count(const ReEditor *e) { return e ? e->diagnostic_count : 0; }

/* Whether this cell is inside a reported range, given the row and the column counted the way the
   protocol counts it. A zero-width range still marks one cell, or a diagnostic pointing at a missing
   semicolon would be invisible. */
static bool diagnostic_under(const ReEditor *e, int row, int character, mu_Color *colour) {
  for (int i = 0; i < e->diagnostic_count; i++) {
    const ReDiagnostic *d = &e->diagnostics[i];
    if (row < d->start_line || row > d->end_line) continue;
    if (row == d->start_line && character < d->start_character) continue;
    if (row == d->end_line) {
      int last = d->end_character > d->start_character || d->end_line > d->start_line ? d->end_character : d->start_character + 1;
      if (character >= last) continue;
    }
    *colour = diagnostic_colour(d->severity);
    return true;
  }
  return false;
}

void re_editor_selection(const ReEditor *e, ReSelection *selection, char *text, int size) {
  if (size > 0) text[0] = 0;
  if (!e || !selection) return;
  int a = e->state.select_start, b = e->state.select_end;
  if (a == b) a = b = e->state.cursor;         /* no selection: both ends are the caret */
  int from = re_min(a, b), to = re_max(a, b);
  from = re_max(0, re_min(from, e->length)); to = re_max(0, re_min(to, e->length));
  position(e, from, &selection->start_line, &selection->start_character);
  position(e, to, &selection->end_line, &selection->end_character);
  int length = 0;
  for (int i = from; i < to && length + 5 < size; i++) {
    char encoded[5]; int n = re_encode(e->text[i], encoded);
    memcpy(text + length, encoded, (size_t)n); length += n;
  }
  if (size > 0) text[length] = 0;
}
/* One line's colours. The editor stores code points, the tokeniser reads bytes, so the line is
 * encoded once and each character's kind is looked up by its byte offset — see sidecar: syntax-spans */
#define RE_SYNTAX_LINE_BYTES 4096
#define RE_SYNTAX_LINE_CHARS 1024
#define RE_SYNTAX_LINE_SPANS 256

typedef struct { uint8_t kind[RE_SYNTAX_LINE_CHARS]; int chars; } ReLineKinds;

static void line_kinds(const ReEditor *e, int start, int end, uint32_t *state, ReLineKinds *out) {
  char bytes[RE_SYNTAX_LINE_BYTES];
  int offsets[RE_SYNTAX_LINE_CHARS + 1];
  int length = 0, chars = 0;
  for (int i = start; i < end && chars < RE_SYNTAX_LINE_CHARS; i++) {
    char encoded[5]; int n = re_encode(e->text[i], encoded);
    if (length + n >= RE_SYNTAX_LINE_BYTES) break;
    offsets[chars++] = length;
    memcpy(bytes + length, encoded, (size_t)n); length += n;
  }
  offsets[chars] = length;
  out->chars = chars;
  memset(out->kind, RE_SYNTAX_TEXT, (size_t)chars);
  ReSyntaxSpan spans[RE_SYNTAX_LINE_SPANS];
  int count = re_syntax_line(e->language, bytes, length, state, spans, RE_SYNTAX_LINE_SPANS);
  int character = 0;
  for (int s = 0; s < count; s++) {
    while (character < chars && (uint32_t)offsets[character] < spans[s].start) character++;
    for (int c = character; c < chars && (uint32_t)offsets[c] < spans[s].start + spans[s].length; c++) out->kind[c] = spans[s].kind;
  }
}

/* The carry state of every line up to the last one drawn, rebuilt only when the text changes. */
static void ensure_states(ReEditor *e, int through) {
  if (e->language == RE_LANG_PLAIN) return;
  if (e->state_revision != e->revision) { e->state_count = 0; e->state_revision = e->revision; }
  if (through < e->state_count) return;
  int wanted = through + 64 < e->line_count + 1 ? through + 64 : e->line_count + 1;
  if (wanted > e->state_count) {
    uint32_t *grown = realloc(e->line_state, sizeof(uint32_t) * (size_t)(wanted + 1));
    if (!grown) return;
    e->line_state = grown;
  }
  if (!e->state_count) { e->line_state[0] = 0; e->state_count = 1; }
  int line = e->state_count - 1, index = 0;
  for (int seen = 0; seen < line && index < e->length; index++) if (e->text[index] == '\n') seen++;
  while (line < wanted && index <= e->length) {
    int start = index;
    while (index < e->length && e->text[index] != '\n') index++;
    uint32_t state = e->line_state[line];
    ReLineKinds discard;
    line_kinds(e, start, index, &state, &discard);
    e->line_state[++line] = state;
    e->state_count = line + 1;
    if (index >= e->length) break;
    index++;
  }
}

/* Line numbers, right-aligned in the gutter, with the caret's line brought forward. */
static void gutter_numbers(ReEditor *e, ReDraw *draw, mu_Rect outer, mu_Rect body, int caret_row) {
  int width = body.x - outer.x - RE_METRIC_DESIGN_GAP;
  if (width <= 0) return;
  for (int row = e->scroll; row < e->line_count; row++) {
    int y = body.y + (row - e->scroll) * e->lh;
    if (y >= body.y + body.h) break;
    char number[16]; snprintf(number, sizeof(number), "%d", row + 1);
    int text_width = re_draw_text_width(draw, RE_FACE_MONO, RE_THEME_FONT_SIZE, number, -1);
    re_draw_text(draw, number, -1, outer.x + re_max(0, width - text_width), y,
                 row == caret_row ? RE_COLOR_TEXT : RE_COLOR_EDITOR_GUTTER_FG);
  }
}
static mu_Rect viewport(ReEditor *e, mu_Rect r, int cw, int lh) {
  if (e->extent_revision != e->revision) {
    e->line_count = 1; e->longest_line = 0; int col = 0;
    for (int i = 0; i < e->length; i++) {
      if (e->text[i] == '\n') { e->line_count++; col = 0; }
      else { col += e->text[i] == '\t' ? RE_METRIC_EDITOR_TAB_CELLS : 1; e->longest_line = re_max(e->longest_line, col); }
    }
    e->extent_revision = e->revision;
  }
  mu_Rect body = r;
  /* The card's 44px gutter is part of the editor, so text, clicks and scrollbars all sit right of it. */
  int gutter = re_min(RE_METRIC_DESIGN_EDITOR_GUTTER, body.w / 3);
  body.x += gutter; body.w = re_max(0, body.w - gutter);
  bool vertical = e->line_count > re_max(1, body.h / lh);
  bool horizontal = e->longest_line + 1 > re_max(1, (body.w - (vertical ? RE_METRIC_SCROLLBAR_SIZE : 0)) / cw);
  if (horizontal) body.h = re_max(0, body.h - RE_METRIC_SCROLLBAR_SIZE);
  vertical = e->line_count > re_max(1, body.h / lh);
  if (vertical) body.w = re_max(0, body.w - RE_METRIC_SCROLLBAR_SIZE);
  re_scrollbar_set(&e->vertical, mu_rect(body.x + body.w, body.y, vertical ? RE_METRIC_SCROLLBAR_SIZE : 0, body.h), e->line_count, re_max(1, body.h / lh), e->scroll, false);
  re_scrollbar_set(&e->horizontal_bar, mu_rect(body.x, body.y + body.h, body.w, horizontal ? RE_METRIC_SCROLLBAR_SIZE : 0), e->longest_line + 1, re_max(1, body.w / cw), e->horizontal, true);
  e->scroll = e->vertical.value; e->horizontal = e->horizontal_bar.value; return body;
}
static void key(ReEditor *e, int k) { stb_textedit_key(e, &e->state, k); }
static void follow_cursor(ReEditor *e, int rows, int cols) {
  int row = 0, column = 0;
  for (int i = 0; i < e->state.cursor; i++) {
    if (e->text[i] == '\n') { row++; column = 0; } else column += e->text[i] == '\t' ? RE_METRIC_EDITOR_TAB_CELLS : 1;
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
  r = viewport(e, r, cw, lh);
  if (re_scrollbar_event(&e->vertical, event)) { e->scroll = e->vertical.value; return; }
  if (re_scrollbar_event(&e->horizontal_bar, event)) { e->horizontal = e->horizontal_bar.value; return; }
  if (event->type == SDL_WINDOWEVENT && event->window.event == SDL_WINDOWEVENT_FOCUS_LOST) { e->dragging = false; return; }
  if (event->type == SDL_MOUSEWHEEL) {
    e->scroll = re_max(0, re_min(e->vertical.maximum, e->scroll - re_wheel_steps(&e->wheel_y, &event->wheel, false, 3)));
    e->horizontal = re_max(0, re_min(e->horizontal_bar.maximum, e->horizontal + re_wheel_steps(&e->wheel_x, &event->wheel, true, 3))); return;
  }
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
  mu_Rect outer = r;
  r = viewport(e, r, e->cw, e->lh);
  re_draw_rect(draw, outer, RE_COLOR_EDITOR_BG);
  re_draw_rect(draw, mu_rect(outer.x, outer.y, re_max(0, r.x - outer.x), outer.h), RE_COLOR_EDITOR_GUTTER_BG);
  int caret_row = 0;
  for (int i = 0; i < e->state.cursor && i < e->length; i++) if (e->text[i] == '\n') caret_row++;
  if (caret_row >= e->scroll) {
    int y = r.y + (caret_row - e->scroll) * e->lh;
    if (y < r.y + r.h) re_draw_rect(draw, mu_rect(r.x, y, r.w, e->lh), RE_COLOR_EDITOR_LINE_BG);
  }
  gutter_numbers(e, draw, outer, r, caret_row);
  re_draw_clip(draw, &r);
  int rows = re_max(1, r.h / e->lh);
  ensure_states(e, e->scroll + rows + 1);
  ReLineKinds kinds; kinds.chars = 0;
  uint32_t carry = 0; int line_start = 0, drawn_row = -1;
  /* `col` is where the cell is drawn, which tabs stretch; `character` is what the protocol counts,
     which they do not. A diagnostic range has to be compared against the second. */
  int row = 0, col = 0, character = 0;
  int selection_a = re_min(e->state.select_start, e->state.select_end), selection_b = re_max(e->state.select_start, e->state.select_end);
  for (int i = 0; i <= e->length; i++) {
    int x = r.x + (col - e->horizontal) * e->cw, y = r.y + (row - e->scroll) * e->lh;
    if (y >= r.y + r.h) break;
    if (row >= e->scroll) {
      if (i >= selection_a && i < selection_b) re_draw_rect(draw, mu_rect(x, y, e->cw, e->lh), RE_COLOR_SELECTION);
      mu_Color mark;
      if (e->diagnostic_count && diagnostic_under(e, row, character, &mark)) {
        re_draw_rect(draw, mu_rect(x, y + e->lh - RE_METRIC_EDITOR_DIAGNOSTIC_HEIGHT, e->cw, RE_METRIC_EDITOR_DIAGNOSTIC_HEIGHT), mark);
      }
      if (focused && i == e->state.cursor) re_draw_rect(draw, mu_rect(x, y, e->vim && !e->insert ? e->cw : RE_METRIC_EDITOR_CARET_WIDTH, e->lh), RE_COLOR_CARET);
      if (i < e->length && e->text[i] != '\n' && e->text[i] != '\t') {
        if (e->language != RE_LANG_PLAIN && drawn_row != row) {
          int end = i; while (end < e->length && e->text[end] != '\n') end++;
          carry = row < e->state_count ? e->line_state[row] : 0;
          line_start = i; while (line_start > 0 && e->text[line_start - 1] != '\n') line_start--;
          uint32_t state = carry;
          line_kinds(e, line_start, end, &state, &kinds);
          drawn_row = row;
        }
        int character = i - line_start;
        int kind = e->language != RE_LANG_PLAIN && drawn_row == row && character >= 0 && character < kinds.chars ? kinds.kind[character] : RE_SYNTAX_TEXT;
        mu_Color colour = kind == RE_SYNTAX_TEXT ? RE_COLOR_EDITOR_FG : re_scheme_colors[editor_scheme][re_theme_preset][kind];
        char text[5]; re_encode(e->text[i], text); re_draw_text(draw, text, -1, x, y, colour);
      }
    }
    if (i < e->length && e->text[i] == '\n') { row++; col = 0; character = 0; }
    else { col += i < e->length && e->text[i] == '\t' ? RE_METRIC_EDITOR_TAB_CELLS : 1;
           character += i < e->length && e->text[i] > 0xFFFF ? 2 : 1; }
  }
  re_draw_clip(draw, NULL);
  re_scrollbar_draw(&e->vertical, draw); re_scrollbar_draw(&e->horizontal_bar, draw);
}
