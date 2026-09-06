#include "formatview.h"
#include "app.h"
#include <ctype.h>

struct ReFormatView {
  int mode, requested; bool chosen, awaiting;
  char format[65], title[128], entry[1024], command[512], entry_command[512], entry_error[512];
  long long page, entry_page;
  ReHexView *hex, *entry_hex; ReEditor *text, *entry_text; cJSON *preview, *entry_info;
  uint64_t *expanded; int expanded_count, expanded_capacity; /* owned expansion set; see sidecar: tree-in-microui */
};
#define RE_FORMAT_EXPANSIONS 4096
static uint64_t path_hash(const char *s) { uint64_t h = 1469598103934665603ull; while (*s) { h ^= (unsigned char)*s++; h *= 1099511628211ull; } return h; }
static int expanded_index(const ReFormatView *v, uint64_t h) { for (int i = 0; i < v->expanded_count; i++) if (v->expanded[i] == h) return i; return -1; }
static void toggle_expanded(ReFormatView *v, uint64_t h) {
  int at = expanded_index(v, h);
  if (at >= 0) { memmove(v->expanded + at, v->expanded + at + 1, (size_t)(v->expanded_count - at - 1) * sizeof(*v->expanded)); v->expanded_count--; return; }
  if (v->expanded_count >= RE_FORMAT_EXPANSIONS) { memmove(v->expanded, v->expanded + 1, (size_t)(v->expanded_count - 1) * sizeof(*v->expanded)); v->expanded_count--; }
  if (v->expanded_count >= v->expanded_capacity) {
    int capacity = re_max(64, v->expanded_capacity * 2); uint64_t *next = realloc(v->expanded, (size_t)capacity * sizeof(*next));
    if (!next) return; v->expanded = next; v->expanded_capacity = capacity;
  }
  v->expanded[v->expanded_count++] = h;
}
static const char *const MODE_NAMES[] = {"text", "raw", "preview"};
static const char *const MODE_LABELS[] = {"Text", "Raw", "Preview"};
static long long re_llong(const cJSON *j, const char *key) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(j, key); return cJSON_IsNumber(v) ? (long long)v->valuedouble : 0;
}
static void size_text(char *out, size_t n, long long size) {
  if (size < 1024) snprintf(out, n, "%lld B", size);
  else if (size < 1024 * 1024) snprintf(out, n, "%.1f KiB", (double)size / 1024.0);
  else snprintf(out, n, "%.1f MiB", (double)size / 1048576.0);
}
static void join_command(const cJSON *array, char *out, size_t n) {
  size_t at = 0; const cJSON *arg = NULL; out[0] = 0;
  cJSON_ArrayForEach(arg, array) if (cJSON_IsString(arg) && at < n - 1) at += (size_t)snprintf(out + at, n - at, "%s%s", at ? " " : "", arg->valuestring);
}
static ReEditor *readonly_editor(const char *text) {
  ReEditor *e = re_editor_open(text); if (e) re_editor_readonly(e, true); return e;
}
static void clear_entry(ReFormatView *v) {
  v->entry[0] = v->entry_error[0] = v->entry_command[0] = 0; v->entry_page = 0;
  cJSON_Delete(v->entry_info); v->entry_info = NULL; re_hex_clear(v->entry_hex); re_editor_close(v->entry_text); v->entry_text = NULL;
}

ReFormatView *re_format_open(int mode, bool chosen) {
  ReFormatView *v = calloc(1, sizeof(*v)); if (!v) return NULL;
  v->hex = re_hex_open(); v->entry_hex = re_hex_open();
  if (!v->hex || !v->entry_hex) { re_format_close(v); return NULL; }
  v->mode = v->requested = mode; v->chosen = chosen; return v;
}
void re_format_close(ReFormatView *v) {
  if (!v) return;
  re_hex_close(v->hex); re_hex_close(v->entry_hex); re_editor_close(v->text); re_editor_close(v->entry_text);
  cJSON_Delete(v->preview); cJSON_Delete(v->entry_info); free(v->expanded); free(v);
}
int re_format_mode(const ReFormatView *v) { return v->mode; }
bool re_format_chosen(const ReFormatView *v) { return v->chosen; }
void re_format_await(ReFormatView *v, bool awaiting) { v->awaiting = awaiting; }
bool re_format_awaiting(const ReFormatView *v) { return v->awaiting; }
int re_format_requested(const ReFormatView *v) { return v->requested; }
const char *re_format_mode_name(int mode) { return mode >= RE_MODE_TEXT && mode <= RE_MODE_PREVIEW ? MODE_NAMES[mode] : "pending"; }
int re_format_mode_from(const char *name) {
  for (int i = 0; i < RE_ARRAY_SIZE(MODE_NAMES); i++) if (!strcmp(MODE_NAMES[i], name)) return i;
  return -1;
}
void re_format_set_mode(ReFormatView *v, int mode, bool chosen) {
  v->mode = v->requested = mode; v->chosen = chosen; v->command[0] = 0; v->page = 0; v->expanded_count = 0; clear_entry(v);
  cJSON_Delete(v->preview); v->preview = NULL; re_editor_close(v->text); v->text = NULL; re_hex_clear(v->hex);
}
void re_format_assign(ReFormatView *v, const char *id, const char *title) { re_copy(v->format, sizeof(v->format), id); re_copy(v->title, sizeof(v->title), title); }
const char *re_format_id(const ReFormatView *v) { return v->format; }
const char *re_format_entry(const ReFormatView *v) { return v->entry; }
long long re_format_offset(const ReFormatView *v, bool entry) { return entry ? v->entry_page : v->page; }
void re_format_name_command(ReFormatView *v, const cJSON *spec, bool entry) {
  char *out = entry ? v->entry_command : v->command; size_t n = entry ? sizeof(v->entry_command) : sizeof(v->command);
  join_command(cJSON_GetObjectItemCaseSensitive(spec, "command"), out, n);
}

/* Case-insensitive shell glob on a file name: *, ? and [...] classes; mirrors the service matcher. */
bool re_format_glob(const char *g, const char *s) {
  while (*g) {
    if (*g == '*') { g++; if (!*g) return true; for (; *s; s++) if (re_format_glob(g, s)) return true; return false; }
    if (!*s) return false;
    if (*g == '[') {
      const char *close = strchr(g + 1, ']'); if (!close) { if (tolower((unsigned char)*g) != tolower((unsigned char)*s)) return false; g++; s++; continue; }
      bool negate = g[1] == '!', hit = false; int c = tolower((unsigned char)*s);
      for (const char *p = g + 1 + negate; p < close; p++) {
        if (p + 2 < close && p[1] == '-') { if (c >= tolower((unsigned char)p[0]) && c <= tolower((unsigned char)p[2])) hit = true; p += 2; }
        else if (tolower((unsigned char)*p) == c) hit = true;
      }
      if (hit == negate) return false; g = close + 1; s++; continue;
    }
    if (*g != '?' && tolower((unsigned char)*g) != tolower((unsigned char)*s)) return false;
    g++; s++;
  }
  return !*s;
}
const cJSON *re_format_match(const cJSON *formats, const char *name) {
  const cJSON *record = NULL, *glob = NULL;
  cJSON_ArrayForEach(record, formats) cJSON_ArrayForEach(glob, cJSON_GetObjectItemCaseSensitive(record, "match"))
    if (cJSON_IsString(glob) && re_format_glob(glob->valuestring, name)) return record;
  return NULL;
}

bool re_format_bytes(ReFormatView *v, const cJSON *j) {
  return re_hex_set(v->hex, re_string(j, "hex"), re_llong(j, "offset"), re_llong(j, "size"));
}
bool re_format_result(ReFormatView *v, const cJSON *j) {
  const char *kind = re_string(j, "kind");
  if (!strcmp(kind, "entry")) {
    if (strcmp(re_string(j, "entry"), v->entry)) return true;
    const cJSON *window = cJSON_GetObjectItemCaseSensitive(j, "window");
    cJSON *info = cJSON_CreateObject(); cJSON_AddStringToObject(info, "sha256", re_string(j, "sha256")); cJSON_AddNumberToObject(info, "size", (double)re_llong(j, "size"));
    cJSON_Delete(v->entry_info); v->entry_info = info; join_command(cJSON_GetObjectItemCaseSensitive(j, "command"), v->entry_command, sizeof(v->entry_command));
    re_editor_close(v->entry_text); v->entry_text = cJSON_IsString(cJSON_GetObjectItemCaseSensitive(j, "text")) ? readonly_editor(re_string(j, "text")) : NULL;
    v->entry_error[0] = 0; return re_hex_set(v->entry_hex, re_string(window, "hex"), re_llong(window, "offset"), re_llong(j, "size"));
  }
  if (strcmp(kind, "tree") && strcmp(kind, "text")) return false;
  if (!strcmp(kind, "tree") && !cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(j, "tree"))) return false;
  cJSON *copy = cJSON_Duplicate(j, 1); if (!copy) return false;
  cJSON_DeleteItemFromObject(copy, "text"); cJSON_Delete(v->preview); v->preview = copy; clear_entry(v);
  join_command(cJSON_GetObjectItemCaseSensitive(j, "command"), v->command, sizeof(v->command));
  re_editor_close(v->text); v->text = !strcmp(kind, "text") ? readonly_editor(re_string(j, "text")) : NULL; return true;
}
void re_format_entry_failed(ReFormatView *v, const char *error) { re_copy(v->entry_error, sizeof(v->entry_error), error); }
static bool tree_kind(const ReFormatView *v) { return v->preview && !strcmp(re_string(v->preview, "kind"), "tree"); }
bool re_format_scrolls(const ReFormatView *v) { return v->mode == RE_MODE_PREVIEW && !v->text; }
bool re_format_split(const ReFormatView *v) { return v->mode == RE_MODE_PREVIEW && *v->entry; }

static int count_files(const cJSON *node) {
  int total = cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(node, "files")); const cJSON *dir = NULL;
  cJSON_ArrayForEach(dir, cJSON_GetObjectItemCaseSensitive(node, "dirs")) total += count_files(dir);
  return total;
}
static int tree_rows(ReFormatView *v, ReApp *a, mu_Context *ui, const cJSON *node, const char *prefix, int depth, int tab, bool entries) {
  int action = RE_FORMAT_NONE, indent = depth * RE_METRIC_MICROUI_INDENT; const cJSON *item = NULL; char path[1024], label[1100];
  cJSON_ArrayForEach(item, cJSON_GetObjectItemCaseSensitive(node, "dirs")) {
    snprintf(path, sizeof(path), "%s%s%s", prefix, *prefix ? "/" : "", re_string(item, "name"));
    uint64_t h = path_hash(path); bool open = expanded_index(v, h) >= 0;
    snprintf(label, sizeof(label), "%s %s  (%d files)", open ? "v" : ">", re_string(item, "name"), count_files(item));
    if (indent) { mu_layout_row(ui, 2, (int[]){indent, -1}, RE_METRIC_FORMAT_ROW_HEIGHT); mu_label(ui, ""); }
    else mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_FORMAT_ROW_HEIGHT);
    mu_push_id(ui, path, (int)strlen(path));
    if (mu_button_ex(ui, label, 0, 0) && depth < RE_METRIC_FORMAT_TREE_DEPTH) { toggle_expanded(v, h); open = !open; }
    re_app_control(a, ui, "preview-dir", path, tab);
    if (open && depth < RE_METRIC_FORMAT_TREE_DEPTH) { int inner = tree_rows(v, a, ui, item, path, depth + 1, tab, entries); if (inner) action = inner; }
    mu_pop_id(ui);
  }
  cJSON_ArrayForEach(item, cJSON_GetObjectItemCaseSensitive(node, "files")) {
    const char *name = re_string(item, "name"), *file = re_string(item, "path"); char size[32]; size_text(size, sizeof(size), re_llong(item, "size"));
    if (indent) { mu_layout_row(ui, 3, (int[]){indent, -RE_METRIC_FORMAT_SIZE_WIDTH, -1}, RE_METRIC_FORMAT_ROW_HEIGHT); mu_label(ui, ""); }
    else mu_layout_row(ui, 2, (int[]){-RE_METRIC_FORMAT_SIZE_WIDTH, -1}, RE_METRIC_FORMAT_ROW_HEIGHT);
    mu_push_id(ui, file, (int)strlen(file));
    if (!entries) mu_label(ui, name);
    else if (mu_button_ex(ui, name, 0, 0)) {
      if (strlen(file) < sizeof(v->entry)) { re_copy(v->entry, sizeof(v->entry), file); v->entry_page = 0; v->entry_error[0] = 0; action = RE_FORMAT_ENTRY; }
    }
    if (entries) re_app_control(a, ui, "preview-file", file, tab);
    mu_label(ui, size); mu_pop_id(ui);
  }
  return action;
}
int re_format_ui(ReFormatView *v, ReApp *a, mu_Context *ui, const cJSON *record, int tab, const char *error) {
  int widths[8], count = 0, action = RE_FORMAT_NONE; const cJSON *modes = cJSON_GetObjectItemCaseSensitive(record, "modes");
  int offered[3], offered_count = 0;
  if (cJSON_IsArray(modes)) { const cJSON *m = NULL; cJSON_ArrayForEach(m, modes) { int mode = cJSON_IsString(m) ? re_format_mode_from(m->valuestring) : -1; if (mode >= 0 && offered_count < 3) offered[offered_count++] = mode; } }
  else { offered[0] = RE_MODE_TEXT; offered[1] = RE_MODE_RAW; offered_count = 2; }
  bool entry_hex = re_format_split(v) && !v->entry_text && re_hex_loaded(v->entry_hex);
  ReHexView *paged = v->mode == RE_MODE_RAW ? v->hex : entry_hex ? v->entry_hex : NULL;
  bool pages = paged && re_hex_loaded(paged) && re_hex_size(paged) > RE_HEX_WINDOW;
  for (int i = 0; i < offered_count; i++) widths[count++] = RE_METRIC_FORMAT_MODE_WIDTH;
  if (v->mode != RE_MODE_TEXT) widths[count++] = RE_METRIC_FORMAT_ACTION_WIDTH;
  if (re_format_split(v)) widths[count++] = RE_METRIC_FORMAT_ACTION_WIDTH;
  if (pages) { widths[count++] = RE_METRIC_FORMAT_PAGE_WIDTH; widths[count++] = RE_METRIC_FORMAT_PAGE_WIDTH; }
  widths[count++] = -1;
  mu_layout_row(ui, count, widths, RE_METRIC_FORMAT_TOOLBAR_HEIGHT);
  for (int i = 0; i < offered_count; i++) {
    char label[24]; snprintf(label, sizeof(label), "%s%s", offered[i] == v->mode ? "• " : "", MODE_LABELS[offered[i]]);
    if (mu_button(ui, label) && offered[i] != v->mode) { v->requested = offered[i]; action = RE_FORMAT_MODE; }
    re_app_control(a, ui, "format-mode", MODE_NAMES[offered[i]], tab);
  }
  if (v->mode != RE_MODE_TEXT) {
    bool failed = error && *error;
    if (mu_button(ui, failed ? "Retry" : "Refresh")) action = RE_FORMAT_LOAD;
    re_app_control(a, ui, failed ? "format-retry" : "format-refresh", "", tab);
  }
  if (re_format_split(v)) { if (mu_button(ui, "Close entry")) clear_entry(v); re_app_control(a, ui, "entry-close", "", tab); }
  if (pages) {
    long long *page = paged == v->hex ? &v->page : &v->entry_page, size = re_hex_size(paged);
    if (mu_button(ui, "< Page") && *page > 0) { *page = *page > RE_HEX_WINDOW ? *page - RE_HEX_WINDOW : 0; action = RE_FORMAT_PAGE; }
    re_app_control(a, ui, "hex-page", "previous", tab);
    if (mu_button(ui, "Page >") && *page + RE_HEX_WINDOW < size) { *page += RE_HEX_WINDOW; action = RE_FORMAT_PAGE; }
    re_app_control(a, ui, "hex-page", "next", tab);
  }
  char label[900];
  if (error && *error) snprintf(label, sizeof(label), "%s · %s", error, v->command);
  else if (v->mode == RE_MODE_RAW && re_hex_loaded(v->hex)) snprintf(label, sizeof(label), "%s · bytes 0x%llx–0x%llx of %lld · read-only", *v->title ? v->title : "Raw bytes", re_hex_base(v->hex), re_hex_base(v->hex) + re_max(0, re_hex_length(v->hex) - 1), re_hex_size(v->hex));
  else if (v->mode == RE_MODE_PREVIEW && v->preview) snprintf(label, sizeof(label), "%s · %s · read-only", v->title, v->command);
  else if (v->mode == RE_MODE_PREVIEW) snprintf(label, sizeof(label), "Running %s", v->command);
  else snprintf(label, sizeof(label), "%s", v->mode == RE_MODE_RAW ? "Loading bytes…" : *v->title ? v->title : "Binary file: text unavailable");
  mu_label(ui, label);
  if (v->mode == RE_MODE_PREVIEW && tree_kind(v)) {
    int inner = tree_rows(v, a, ui, cJSON_GetObjectItemCaseSensitive(v->preview, "tree"), "", 0, tab, cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(record, "entry")));
    if (inner) action = inner;
  }
  return action;
}
static mu_Rect entry_body(mu_Rect r) { return mu_rect(r.x, r.y + RE_METRIC_FORMAT_HEADER_HEIGHT, r.w, re_max(0, r.h - RE_METRIC_FORMAT_HEADER_HEIGHT)); }
void re_format_event(ReFormatView *v, const SDL_Event *e, mu_Rect r, int cw, int lh) {
  if (v->mode == RE_MODE_RAW) { if (re_hex_loaded(v->hex)) re_hex_event(v->hex, e, r, lh); return; }
  if (v->mode != RE_MODE_PREVIEW) return;
  if (v->text) { re_editor_event(v->text, e, r, cw, lh); return; }
  if (!*v->entry) return;
  if (v->entry_text) re_editor_event(v->entry_text, e, entry_body(r), cw, lh);
  else if (re_hex_loaded(v->entry_hex)) re_hex_event(v->entry_hex, e, entry_body(r), lh);
}
void re_format_draw(ReFormatView *v, ReDraw *draw, mu_Rect r, bool focused) {
  if (r.w <= 0 || r.h <= 0) return;
  if (v->mode == RE_MODE_RAW) { if (re_hex_loaded(v->hex)) re_hex_draw(v->hex, draw, r); else re_draw_rect(draw, r, RE_COLOR_SURFACE); return; }
  if (v->mode != RE_MODE_PREVIEW) return;
  if (v->text) { re_editor_draw(v->text, draw, r, focused); return; }
  if (!*v->entry) return;
  char header[1400], size[32]; size_text(size, sizeof(size), v->entry_info ? re_llong(v->entry_info, "size") : 0);
  if (*v->entry_error) snprintf(header, sizeof(header), "%s · %s · %s", v->entry, v->entry_error, v->entry_command);
  else if (v->entry_info) snprintf(header, sizeof(header), "%s · %s · sha256 %.16s… · %s · read-only", v->entry, size, re_string(v->entry_info, "sha256"), v->entry_command);
  else snprintf(header, sizeof(header), "%s · running %s", v->entry, v->entry_command);
  re_draw_rect(draw, r, RE_COLOR_SURFACE); re_draw_clip(draw, &r); re_draw_text(draw, header, -1, r.x, r.y, RE_COLOR_TEXT_MUTED); re_draw_clip(draw, NULL);
  if (v->entry_text) re_editor_draw(v->entry_text, draw, entry_body(r), focused);
  else if (re_hex_loaded(v->entry_hex)) re_hex_draw(v->entry_hex, draw, entry_body(r));
}
static void bounded_text(cJSON *object, const char *key, ReEditor *editor) {
  char *text = re_editor_text(editor); if (!text) return;
  if (strlen(text) > 4000) text[4000] = 0;
  cJSON_AddStringToObject(object, key, text); free(text);
}
void re_format_inspect(const ReFormatView *v, cJSON *tab) {
  cJSON_AddStringToObject(tab, "formatMode", re_format_mode_name(v->mode)); cJSON_AddStringToObject(tab, "format", v->format);
  cJSON_AddStringToObject(tab, "formatCommand", v->command); cJSON_AddBoolToObject(tab, "formatChosen", v->chosen);
  if (v->mode == RE_MODE_RAW && re_hex_loaded(v->hex)) re_hex_inspect(v->hex, tab);
  if (v->preview) {
    cJSON_AddStringToObject(tab, "previewKind", re_string(v->preview, "kind"));
    if (tree_kind(v)) {
      const cJSON *tree = cJSON_GetObjectItemCaseSensitive(v->preview, "tree"), *dir = NULL; cJSON *top = cJSON_AddArrayToObject(tab, "previewTop");
      cJSON_ArrayForEach(dir, cJSON_GetObjectItemCaseSensitive(tree, "dirs")) {
        cJSON *item = cJSON_CreateObject(); cJSON_AddStringToObject(item, "name", re_string(dir, "name"));
        cJSON_AddNumberToObject(item, "dirs", cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(dir, "dirs"))); cJSON_AddNumberToObject(item, "files", cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(dir, "files")));
        cJSON_AddItemToArray(top, item);
      }
      cJSON_AddNumberToObject(tab, "previewFiles", count_files(tree)); cJSON_AddNumberToObject(tab, "expandedDirs", v->expanded_count);
    }
    if (v->text) bounded_text(tab, "previewText", v->text);
  }
  if (*v->entry) {
    cJSON *entry = cJSON_AddObjectToObject(tab, "entry"); cJSON_AddStringToObject(entry, "path", v->entry); cJSON_AddStringToObject(entry, "command", v->entry_command);
    if (*v->entry_error) cJSON_AddStringToObject(entry, "error", v->entry_error);
    if (v->entry_info) { cJSON_AddNumberToObject(entry, "size", (double)re_llong(v->entry_info, "size")); cJSON_AddStringToObject(entry, "sha256", re_string(v->entry_info, "sha256")); }
    if (v->entry_text) bounded_text(entry, "text", v->entry_text); else if (re_hex_loaded(v->entry_hex)) re_hex_inspect(v->entry_hex, entry);
  }
}
