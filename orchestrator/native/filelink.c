#include "filelink.h"
#include "app.h"
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static bool copy_span(char *out, size_t capacity, const char *start, const char *end) {
  size_t n = 0;
  for (const char *p = start; p < end; p++) {
    if (*p == '\n' || *p == '\r') {
      while (n && (out[n - 1] == ' ' || out[n - 1] == '\t')) n--;
      while (p + 1 < end && strchr(" \t\r\n", p[1])) p++;
      continue;
    }
    if (n + 1 >= capacity) return false; out[n++] = *p;
  }
  if (!n) return false; out[n] = 0; return true;
}
static const char *closing_paren(const char *start) {
  int depth = 1;
  for (const char *p = start; *p; p++) { if (*p == '(') depth++; if (*p == ')' && !--depth) return p; }
  return NULL;
}
bool re_file_reference(const char *text, size_t at, char *target, size_t capacity) {
  if (!text || at >= strlen(text)) return false;
  for (const char *p = text; (p = strchr(p, '[')); p++) {
    const char *middle = strstr(p, "]("); if (!middle || (strchr(p, '\n') && strchr(p, '\n') < middle)) continue;
    const char *start = middle + 2, *end = closing_paren(start);
    if (!end || text + at < p || text + at > end) continue;
    if (*start == '<' && end > start + 1 && end[-1] == '>') { start++; end--; }
    return copy_span(target, capacity, start, end);
  }
  for (const char *p = text; (p = strchr(p, '(')); p++) {
    const char *end = closing_paren(p + 1);
    if (!end || text + at <= p || text + at >= end) continue;
    if (!memchr(p, '/', (size_t)(end - p)) && !memchr(p, '.', (size_t)(end - p))) continue;
    return copy_span(target, capacity, p + 1, end);
  }
  const char *start = text + at, *end = start;
  const char *delimiters = " \t\r\n\"'`<>[]()";
  if (strchr(delimiters, *start)) return false;
  while (start > text && !strchr(delimiters, start[-1])) start--;
  while (*end && !strchr(delimiters, *end)) end++;
  while (end > start && strchr(",;.", end[-1])) end--;
  if (!memchr(start, '.', (size_t)(end - start)) && !memchr(start, '/', (size_t)(end - start))) return false;
  return copy_span(target, capacity, start, end);
}
static int hex(unsigned char c) {
  if (c >= '0' && c <= '9') return c - '0'; c = (unsigned char)tolower(c);
  return c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
}
static bool number(const char *s, int *value) {
  if (!*s) return false; int n = 0;
  for (; *s; s++) { if (!isdigit((unsigned char)*s) || n > 100000) return false; n = n * 10 + *s - '0'; }
  if (!n) return false; *value = n; return true;
}
static bool path_prefix(const char *s, const char *root, size_t length) {
  for (size_t i = 0; i < length; i++) {
    unsigned char a = (unsigned char)s[i], b = (unsigned char)root[i];
    if (!a) return false; if (a == '\\') a = '/'; if (b == '\\') b = '/';
#ifdef _WIN32
    a = (unsigned char)tolower(a); b = (unsigned char)tolower(b);
#endif
    if (a != b) return false;
  }
  return s[length] == '/' || s[length] == '\\' || !s[length];
}
bool re_file_target(const char *target, const char *root, char *relative, size_t capacity, int *line, int *column) {
  char decoded[4096]; size_t n = 0; const char *s = target;
  *line = *column = 0; if (!s || !root || !*root || !capacity) return false;
  if (!strncmp(s, "file://", 7)) {
    s += 7; if (!strncmp(s, "localhost/", 10)) s += 9;
    if (*s != '/') return false;
    if (isalpha((unsigned char)s[1]) && s[2] == ':') s++;
  } else if (strstr(s, "://")) return false;
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '%') { if (!s[1] || !s[2] || hex((unsigned char)s[1]) < 0 || hex((unsigned char)s[2]) < 0) return false;
      c = (unsigned char)(hex((unsigned char)s[1]) * 16 + hex((unsigned char)s[2])); s += 2; }
    if (c < 32 || c == 127 || n + 1 >= sizeof(decoded)) return false;
    decoded[n++] = c == '\\' ? '/' : (char)c;
  }
  decoded[n] = 0;
  char *hash = strrchr(decoded, '#');
  if (hash) { if (hash[1] != 'L' || !number(hash + 2, line)) return false; *hash = 0; }
  char *colon = strrchr(decoded, ':'); int last = 0;
  if (colon && number(colon + 1, &last)) {
    *colon = 0; *line = last; char *before = strrchr(decoded, ':');
    if (before && number(before + 1, line)) { *column = last; *before = 0; }
  }
  s = decoded;
  /* Claude Code writes an @-mention for a file picked in its composer, and prose paths under ~.
     Neither is a path this resolver can use verbatim: they become a literal "@…" or "~" directory
     inside the project, so the hover offers a link that opens nothing. Only a LEADING @ is dropped,
     which leaves node_modules/@scope/… alone. ~ expands and then faces the same root check as any
     absolute path, so a home path outside the clicked terminal's root is still refused. */
  if (*s == '@' && s[1]) s++;
  char home_path[4096];
  if (*s == '~' && (!s[1] || s[1] == '/')) {
    const char *home = getenv("HOME");
#ifdef _WIN32
    if (!home || !*home) home = getenv("USERPROFILE");
#endif
    if (!home || !*home) return false;
    if ((size_t)snprintf(home_path, sizeof(home_path), "%s%s", home, s + 1) >= sizeof(home_path)) return false;
    for (char *p = home_path; *p; p++) if (*p == '\\') *p = '/';
    s = home_path;
  }
  bool drive = isalpha((unsigned char)s[0]) && s[1] == ':' && s[2] == '/';
  if (*s == '/' || drive) {
    size_t root_length = strlen(root); while (root_length > 1 && (root[root_length - 1] == '/' || root[root_length - 1] == '\\')) root_length--;
    if (!path_prefix(s, root, root_length)) return false;
    s += root_length; if (*s == '/') s++;
  }
  if (strchr(s, ':') || strchr(s, '?') || strchr(s, '#')) return false;
  n = 0;
  while (*s) {
    while (*s == '/') s++; const char *end = strchr(s, '/'); if (!end) end = s + strlen(s);
    size_t length = (size_t)(end - s); if (!length) break;
    if (length == 1 && *s == '.') { s = end; continue; }
    if (length == 2 && !memcmp(s, "..", 2)) {
      if (!n) return false; while (n && relative[n - 1] != '/') n--; if (n) n--; s = end; continue;
    }
    if (n + (n ? 1 : 0) + length >= capacity) return false;
    if (n) relative[n++] = '/'; memcpy(relative + n, s, length); n += length; s = end;
  }
  relative[n] = 0; return n != 0;
}

static bool local_reference(ReApp *a, int source, const char *target, char *relative, size_t capacity, int *line, int *column) {
  if (source < 0 || source >= RE_TABS || !a->tabs[source].used) return false;
  const char *root_path = NULL; const cJSON *root;
  cJSON_ArrayForEach(root, cJSON_GetObjectItemCaseSensitive(a->state, "roots"))
    if (!strcmp(re_string(root, "id"), a->tabs[source].root)) root_path = re_string(root, "path");
  return root_path && re_file_target(target, root_path, relative, capacity, line, column);
}
bool re_app_open_reference(ReApp *a, int source, const char *target) {
  char relative[2048]; int line, column;
  if (!local_reference(a, source, target, relative, sizeof(relative), &line, &column)) {
    re_copy(a->status, sizeof(a->status), "File reference is invalid or outside this terminal's project."); return false;
  }
  const char *name = strrchr(relative, '/');
  int tab = re_app_tab(a, RE_EDITOR, a->tabs[source].root, relative, "", name ? name + 1 : relative);
  if (tab < 0) return false;
  ReTab *t = &a->tabs[tab];
  if (t->editor) re_editor_goto(t->editor, line, column);
  else { t->link_line = line; t->link_column = column; }
  snprintf(a->status, sizeof(a->status), "Opened %s", relative); return true;
}

void re_app_file_link_hover(ReApp *a) {
  static const char hint[] = "Cmd/Ctrl-click to open ";
  bool hover = false;
  if (!a->file_link_inactive && !a->quitting && !a->overlay && !*a->dropdown && a->drag_tab < 0 && a->resize_pane < 0)
    for (int i = 0; i < RE_TABS; i++) if (a->tabs[i].terminal && re_inside(a->tabs[i].rect, a->mouse_x, a->mouse_y)) {
      char target[4096], relative[2048]; int line, column;
      if (re_terminal_file_at(a->tabs[i].terminal, a->mouse_x, a->mouse_y, target, sizeof(target)) &&
          local_reference(a, i, target, relative, sizeof(relative), &line, &column)) {
        hover = true; snprintf(a->status, sizeof(a->status), "%s%.470s", hint, target);
      }
      break;
    }
  SDL_Cursor *cursor = hover && a->file_link_cursor ? a->file_link_cursor : SDL_GetDefaultCursor();
  if (SDL_GetCursor() != cursor) SDL_SetCursor(cursor);
  if (!hover && !strncmp(a->status, hint, sizeof(hint) - 1)) a->status[0] = 0;
}

bool re_app_file_link_event(ReApp *a, const SDL_Event *e) {
  if (e->type == SDL_WINDOWEVENT && e->window.event == SDL_WINDOWEVENT_FOCUS_LOST) a->file_link_pressed = false;
  if (a->file_link_pressed && e->type == SDL_MOUSEBUTTONUP && e->button.button == SDL_BUTTON_LEFT) { a->file_link_pressed = false; return true; }
  if (a->quitting || a->drag_tab >= 0 || a->resize_pane >= 0 || !(SDL_GetModState() & (KMOD_GUI | KMOD_CTRL))) return false;
  bool click = e->type == SDL_MOUSEBUTTONDOWN && e->button.button == SDL_BUTTON_LEFT;
  if (!click) return false;
  for (int i = 0; i < RE_TABS; i++) if (a->tabs[i].terminal && re_inside(a->tabs[i].rect, a->mouse_x, a->mouse_y)) {
    char target[4096];
    if (re_terminal_file_at(a->tabs[i].terminal, a->mouse_x, a->mouse_y, target, sizeof(target))) {
      re_terminal_release(a->tabs[i].terminal); a->file_link_pressed = true;
      re_app_open_reference(a, i, target); return true;
    }
  }
  return false;
}
