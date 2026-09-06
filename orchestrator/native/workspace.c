#include "app.h"
#include "scene.h"
#include "ui/ui.h"
#include "editor.h"
#include "render/syntax_theme.h"
#include "theme_file.h"

static void inspect_rect(ReApp *a, const char *role, const char *key, int tab, mu_Rect r) {
  if (!a->controls || cJSON_GetArraySize(a->controls) >= 512) return;
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "role", role); cJSON_AddStringToObject(j, "key", key);
  cJSON_AddNumberToObject(j, "tab", tab); cJSON_AddItemToObject(j, "rect", cJSON_CreateIntArray((int[]){r.x, r.y, r.w, r.h}, 4));
  cJSON_AddItemToArray(a->controls, j);
}
/* A control is recorded at the part of it a person could actually reach: its rectangle clipped to
 * the container being built. A row scrolled out of view records nothing. */
static void control_clipped(ReApp *a, mu_Context *ui, const char *role, const char *key, int tab, mu_Rect r) {
  if (!a->controls) return;
  mu_Rect clip = mu_get_clip_rect(ui);
  int x = re_max(r.x, clip.x), y = re_max(r.y, clip.y);
  int right = re_min(r.x + r.w, clip.x + clip.w), bottom = re_min(r.y + r.h, clip.y + clip.h);
  if (right <= x || bottom <= y) return;
  inspect_rect(a, role, key, tab, mu_rect(x, y, right - x, bottom - y));
}
void re_app_control(ReApp *a, mu_Context *ui, const char *role, const char *key, int tab) {
  control_clipped(a, ui, role, key, tab, ui->last_rect);
}
static const char *root_name(ReApp *a, const char *id) {
  const cJSON *root = NULL;
  cJSON_ArrayForEach(root, cJSON_GetObjectItemCaseSensitive(a->state, "roots"))
    if (!strcmp(re_string(root, "id"), id)) return re_string(root, "name");
  return "Missing root";
}
static const char *root_path(ReApp *a, const char *id) {
  const cJSON *root = NULL;
  cJSON_ArrayForEach(root, cJSON_GetObjectItemCaseSensitive(a->state, "roots"))
    if (!strcmp(re_string(root, "id"), id)) return re_string(root, "path");
  return "";
}
static int tab_icon(const ReTab *t) {
  switch (t->type) {
    case RE_TREE: return RE_ICON_TREE;
    case RE_SESSIONS: return RE_ICON_MENU;
    case RE_DASHBOARD: return RE_ICON_PROJECT;
    case RE_DEVICES: return RE_ICON_MENU;
    case RE_TERMINAL: return t->game ? RE_ICON_RUN : RE_ICON_SHELL;
    default: return t->game ? RE_ICON_RUN : RE_ICON_FILE;
  }
}

/* The toolbar is one row laid out left to right, so every cell keeps the card's geometry. */
typedef struct { mu_Context *ui; ReDraw *draw; int x, y, h, right; } ReToolbar;

static ReToolbar toolbar_open(mu_Context *ui, int width) {
  ReToolbar bar;
  bar.ui = ui; bar.draw = re_draw_active();
  bar.h = RE_METRIC_DESIGN_CONTROL_HEIGHT;
  bar.y = (RE_METRIC_DESIGN_TOOLBAR_HEIGHT - bar.h) / 2;
  bar.x = RE_METRIC_DESIGN_TOOLBAR_PAD;
  bar.right = width - RE_METRIC_DESIGN_TOOLBAR_PAD;
  return bar;
}
static int toolbar_width(const ReToolbar *bar, const char *label, int icon, int opt) {
  int size = opt & RE_UI_SMALL ? RE_METRIC_DESIGN_SIZE_SM : RE_METRIC_DESIGN_SIZE;
  int pad = opt & RE_UI_FIELD_PAD ? RE_METRIC_DESIGN_FIELD_PAD : RE_METRIC_DESIGN_CONTROL_PAD;
  int width = re_draw_text_width(bar->draw, RE_FACE_UI_MEDIUM, size, label, -1) + 2 * pad;
  if (icon != RE_ICON_UNKNOWN) width += size + RE_METRIC_DESIGN_ICON_GAP;
  if (opt & RE_UI_CARET) width += size + RE_METRIC_DESIGN_ICON_GAP;
  return width;
}
static void toolbar_next(ReToolbar *bar, int width, int gap) {
  bar->x += gap;
  mu_layout_set_next(bar->ui, mu_rect(bar->x, bar->y, width, bar->h), 0);
  bar->x += width;
}
static int toolbar_cell(ReToolbar *bar, const char *label, int icon, int opt, int gap) {
  int width = opt & RE_UI_ICON_ONLY ? RE_METRIC_DESIGN_ICON_BUTTON : toolbar_width(bar, label, icon, opt);
  toolbar_next(bar, width, gap);
  return re_ui_button_ex(bar->ui, label, icon, opt);
}
/* Brand mark: the accent square with the wordmark beside it, as the card draws it. */
static void toolbar_brand(ReToolbar *bar) {
  int size = RE_METRIC_DESIGN_SIZE_LG, mark = RE_METRIC_DESIGN_BRAND_MARK;
  mu_Rect box = mu_rect(bar->x, bar->y + (bar->h - mark) / 2, mark, mark);
  re_draw_rrect(bar->draw, box, RE_COLOR_ACCENT, RE_METRIC_DESIGN_BRAND_RADIUS, RE_CORNERS_ALL);
  re_draw_text_face(bar->draw, RE_FACE_UI_SEMIBOLD, RE_METRIC_DESIGN_SIZE_SM, "r", -1,
                    box.x + (mark - re_draw_text_width(bar->draw, RE_FACE_UI_SEMIBOLD, RE_METRIC_DESIGN_SIZE_SM, "r", -1)) / 2,
                    box.y + (mark - RE_METRIC_DESIGN_SIZE_SM) / 2 - 1, RE_COLOR_TEXT_ON_ACCENT);
  bar->x += mark + RE_METRIC_DESIGN_GAP_LG;
  re_draw_text_face(bar->draw, RE_FACE_UI_SEMIBOLD, size, "rEngine", -1, bar->x, bar->y + (bar->h - size) / 2 - 1, RE_COLOR_TEXT_STRONG);
  bar->x += re_draw_text_width(bar->draw, RE_FACE_UI_SEMIBOLD, size, "rEngine", -1);
}
static void toolbar_label(ReToolbar *bar, const char *label) {
  int width = re_draw_text_width(bar->draw, RE_FACE_UI, RE_METRIC_DESIGN_SIZE_SM, label, -1);
  toolbar_next(bar, width, RE_METRIC_DESIGN_GAP_LG);
  re_ui_label_ex(bar->ui, label, RE_UI_MUTED | RE_UI_SMALL);
}
static void toolbar_separator(ReToolbar *bar) {
  toolbar_next(bar, 1, RE_METRIC_DESIGN_GAP_LG + RE_METRIC_DESIGN_GAP);
  re_ui_separator(bar->ui);
  bar->x += RE_METRIC_DESIGN_GAP;
}
static bool session_running(ReApp *a, const char *id) {
  const cJSON *session = NULL;
  cJSON_ArrayForEach(session, cJSON_GetObjectItemCaseSensitive(a->state, "sessions"))
    if (!strcmp(re_string(session, "id"), id)) return !strcmp(re_string(session, "state"), "running");
  return false;
}
static void launch_terminal(ReApp *a, bool agent, bool menu) {
  if (!*a->root) { re_copy(a->status, sizeof(a->status), "Add or select a project first."); return; }
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "rootId", a->root);
  if (agent) { cJSON_AddStringToObject(j, "type", "agent"); cJSON_AddStringToObject(j, "agent", a->agent); cJSON_AddStringToObject(j, "action", menu || !*a->agent ? "menu" : "launch"); }
  re_app_action(a, "terminal", j); cJSON_Delete(j);
}
/* The card's meta column: a directory's direct-child count, an unsaved draft, or a symlink. */
static const char *entry_meta(ReApp *a, const ReTab *t, const cJSON *entry, const char *path, char *buffer, size_t size) {
  for (int i = 0; i < RE_TABS; i++) {
    const ReTab *open = &a->tabs[i];
    if (open->dirty && open->type == RE_EDITOR && !strcmp(open->root, t->root) && !strcmp(open->path, path)) return "M";
  }
  if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(entry, "symlink"))) return "link";
  const cJSON *children = cJSON_GetObjectItemCaseSensitive(entry, "children");
  if (cJSON_IsNumber(children)) { snprintf(buffer, size, "%d", (int)children->valuedouble); return buffer; }
  return "";
}
/* Explorer rows. In flat mode a directory row drills in, which is the behaviour the desktop has
 * always had. In nested mode the row expands the directory in place and the caret glyph drills in,
 * so today's behaviour stays reachable (spec 080 decision 9). The mode is a setting, never inferred
 * from how large a project is (decision 1). */
static void tree_rows(ReApp *a, mu_Context *ui, int index, const cJSON *entries, int depth) {
  ReTab *t = &a->tabs[index];
  const cJSON *entry = NULL;
  cJSON_ArrayForEach(entry, entries) {
    mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DESIGN_TREE_ROW);
    const char *name = re_string(entry, "name"), *path = re_string(entry, "path");
    bool directory = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(entry, "directory"));
    bool nested = a->explorer_nested && directory;
    int slot = nested ? re_app_expanded(a, index, path) : -1;
    char meta_text[16]; const char *meta = entry_meta(a, t, entry, path, meta_text, sizeof(meta_text));
    int opt = strcmp(meta, "M") ? 0 : RE_UI_STRONG;
    if (*t->selected && !strcmp(t->selected, path)) opt |= RE_UI_ON;
    int icon = directory ? (slot >= 0 ? RE_ICON_EXPANDED : RE_ICON_COLLAPSED) : RE_ICON_HOLLOW;
    mu_push_id(ui, path, (int)strlen(path));   /* names repeat between folders; the path does not */
    bool clicked = re_ui_row_ex(ui, name, icon, meta, depth, opt) != 0;
    mu_Rect row = ui->last_rect;
    re_app_control(a, ui, "tree-entry", path, index);
    mu_Rect caret = mu_rect(row.x + RE_METRIC_DESIGN_ICON_GAP + depth * RE_METRIC_DESIGN_TREE_INDENT,
                            row.y, RE_METRIC_DESIGN_SIZE, row.h);
    if (nested) control_clipped(a, ui, "tree-drill", path, index, caret);
    mu_pop_id(ui);
    if (clicked) {
      if (strlen(path) >= sizeof(t->path)) { re_copy(t->error, sizeof(t->error), "File path exceeds the view limit."); continue; }
      bool on_caret = nested && re_inside(caret, ui->mouse_pos.x, ui->mouse_pos.y);
      if (nested && !on_caret) { re_app_expand(a, index, path); slot = re_app_expanded(a, index, path); }
      else if (directory) {
        re_app_expansions_clear(a, index);     /* a new root is a new tree */
        re_copy(t->path, sizeof(t->path), path); t->selected[0] = 0;
        re_app_load(a, index); re_app_layout_changed(a);
        continue;
      } else {
        /* The selection is the file being worked on, not whichever folder was last toggled. It is
         * what decides which branch the row cap must not close under (spec 080 decision 8). */
        re_copy(t->selected, sizeof(t->selected), path);
        re_app_tab(a, RE_EDITOR, t->root, path, "", name);
      }
    }
    if (slot >= 0) {
      const cJSON *children = cJSON_GetObjectItemCaseSensitive(a->expansions[slot].data, "entries");
      if (!children) {
        mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DESIGN_TREE_ROW);
        re_ui_row_ex(ui, "Loading…", RE_ICON_UNKNOWN, "", depth + 1, RE_UI_MUTED | RE_UI_DISABLED);
      } else tree_rows(a, ui, index, children, depth + 1);
    }
  }
}

static void tree_ui(ReApp *a, mu_Context *ui, int index) {
  ReTab *t = &a->tabs[index];
  ReDraw *draw = re_draw_active();
  /* Path bar: up, then the root and the path within it, as the card shows. */
  mu_layout_row(ui, 2, (int[]){RE_METRIC_DESIGN_ICON_BUTTON, -1}, RE_METRIC_DESIGN_ROW);
  if (re_ui_button_ex(ui, "Up", RE_ICON_ARROW_UP, RE_UI_GHOST | RE_UI_ICON_ONLY | (*t->path ? 0 : RE_UI_DISABLED))) {
    char *slash = strrchr(t->path, '/'); if (slash) *slash = 0; else t->path[0] = 0;
    re_app_expansions_clear(a, index); t->selected[0] = 0;
    re_app_load(a, index); re_app_layout_changed(a);
  }
  re_app_control(a, ui, "tree-up", "", index);
  mu_Rect path_rect = mu_layout_next(ui);
  int size = RE_METRIC_DESIGN_SIZE, text_y = path_rect.y + (path_rect.h - size) / 2 - 1;
  const char *root = root_name(a, t->root);
  int root_width = re_draw_text_width(draw, RE_FACE_UI_MEDIUM, size, root, -1);
  re_draw_text_face(draw, RE_FACE_UI_MEDIUM, size, root, -1, path_rect.x, text_y, RE_COLOR_TEXT);
  if (*t->path) {
    char rest[1024]; snprintf(rest, sizeof(rest), "/%s", t->path);
    int rest_width = re_draw_text_width(draw, RE_FACE_UI, size, rest, -1);
    mu_Rect clip = mu_rect(path_rect.x + root_width, path_rect.y, re_max(0, path_rect.w - root_width), path_rect.h);
    bool fits = rest_width <= clip.w;
    if (!fits) re_draw_clip(draw, &clip);
    re_draw_text_face(draw, RE_FACE_UI, size, rest, -1, clip.x, text_y, RE_COLOR_TEXT_MUTED);
    if (!fits) re_draw_clip(draw, NULL);
  }
  if (!t->data) {
    mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DESIGN_TREE_ROW);
    re_ui_label_ex(ui, *t->error ? t->error : "Loading files…", RE_UI_MUTED);
    return;
  }
  tree_rows(a, ui, index, cJSON_GetObjectItemCaseSensitive(t->data, "entries"), 0);
  if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(t->data, "truncated"))) {
    mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DESIGN_TREE_ROW);
    re_ui_label_ex(ui, "Showing the first 2,000 directory entries.", RE_UI_MUTED | RE_UI_SMALL);
  }
}
/* A session's state maps to the card's semantic dot. */
static int session_pill(const char *state) {
  if (!strcmp(state, "running")) return RE_UI_PILL_OK;
  if (!strcmp(state, "stopping")) return RE_UI_PILL_WARN;
  if (!strcmp(state, "exited")) return RE_UI_PILL_NEUTRAL;
  return RE_UI_PILL_INFO;
}
static void sessions_columns(mu_Context *ui, const char *first, const char *second, const char *third) {
  mu_layout_row(ui, 4, (int[]){-RE_METRIC_SESSIONS_ACTIONS_WIDTH - RE_METRIC_SESSIONS_STATE_WIDTH, RE_METRIC_SESSIONS_STATE_WIDTH,
                               RE_METRIC_SESSIONS_ATTACH_WIDTH, -1}, RE_METRIC_DESIGN_ROW);
  re_ui_label_ex(ui, first, RE_UI_MUTED | RE_UI_SMALL);
  re_ui_label_ex(ui, second, RE_UI_MUTED | RE_UI_SMALL);
  re_ui_label_ex(ui, third, RE_UI_MUTED | RE_UI_SMALL);
  re_ui_label_ex(ui, "", RE_UI_MUTED | RE_UI_SMALL);
}
static void sessions_ui(ReApp *a, mu_Context *ui) {
  sessions_columns(ui, "Session", "State", "");
  const cJSON *session = NULL;
  cJSON_ArrayForEach(session, cJSON_GetObjectItemCaseSensitive(a->state, "sessions")) {
    const char *id = re_string(session, "id"), *root = re_string(session, "rootId");
    const char *state = re_string(session, "state"), *type = re_string(session, "type");
    mu_push_id(ui, id, (int)strlen(id));
    mu_layout_row(ui, 4, (int[]){-RE_METRIC_SESSIONS_ACTIONS_WIDTH - RE_METRIC_SESSIONS_STATE_WIDTH, RE_METRIC_SESSIONS_STATE_WIDTH,
                                 RE_METRIC_SESSIONS_ATTACH_WIDTH, -1}, RE_METRIC_SESSIONS_ROW_HEIGHT);
    char label[1024]; snprintf(label, sizeof(label), "%s · %s", re_string(session, "title"), root_name(a, root));
    re_ui_row_ex(ui, label, !strcmp(type, "agent") ? RE_ICON_AGENT : !strcmp(type, "game") ? RE_ICON_RUN : RE_ICON_SHELL, "", 0, RE_UI_DISABLED);
    char pill[64]; snprintf(pill, sizeof(pill), "%s · %d", state, re_number(session, "pid"));
    re_ui_pill(ui, pill, session_pill(state));
    if (re_ui_button_ex(ui, "Attach", RE_ICON_UNKNOWN, RE_UI_SMALL)) {
      re_app_tab(a, !strcmp(type, "game") ? RE_GAME : RE_TERMINAL, root, "", id, re_string(session, "title"));
    }
    re_app_control(a, ui, "attach", id, -1);
    if (re_ui_button_ex(ui, "Stop", RE_ICON_UNKNOWN, RE_UI_GHOST | RE_UI_SMALL)) {
      cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "id", id); re_app_action(a, "stop", j); cJSON_Delete(j);
    }
    re_app_control(a, ui, "stop", id, -1);
    mu_pop_id(ui);
  }
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_SESSIONS_HEADING_HEIGHT);
  re_ui_label_ex(ui, "Recovery drafts", RE_UI_STRONG);
  const cJSON *draft = NULL;
  cJSON_ArrayForEach(draft, cJSON_GetObjectItemCaseSensitive(a->state, "drafts")) {
    mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DESIGN_TREE_ROW);
    const char *path = re_string(draft, "path");
    char label[2300]; snprintf(label, sizeof(label), "%s · %s", root_name(a, re_string(draft, "rootId")), path);
    if (re_ui_row_ex(ui, label, RE_ICON_DIRTY, "draft", 0, 0)) {
      re_app_tab(a, RE_EDITOR, re_string(draft, "rootId"), path, "", path);
    }
  }
}
/* "Game/ClientShell/HUD.cpp" reads as "Game / ClientShell / HUD.cpp" in the card. */
static void breadcrumb(char *out, size_t size, const char *path) {
  size_t used = 0;
  for (const char *s = path; *s && used + 4 < size; s++) {
    if (*s == '/') { out[used++] = ' '; out[used++] = '/'; out[used++] = ' '; }
    else out[used++] = *s;
  }
  out[used] = 0;
  if (!used && size) re_copy(out, size, "Untitled");
}
static void editor_ui(ReApp *a, mu_Context *ui, int index, mu_Rect content, mu_Rect below) {
  ReTab *t = &a->tabs[index]; int mode = t->format ? re_format_mode(t->format) : RE_MODE_TEXT, action = RE_FORMAT_NONE, top = RE_METRIC_EDITOR_TOP;
  if (t->format && mode != RE_MODE_PENDING) { action = re_format_ui(t->format, a, ui, re_app_format_record(a, t), index, t->error); top += RE_METRIC_FORMAT_ROW_ADVANCE; }
  if (mode == RE_MODE_TEXT || mode == RE_MODE_PENDING) {
    /* Breadcrumb, state, then the actions on the right, as the editor card lays them out. */
    mu_layout_row(ui, 4, (int[]){-RE_METRIC_EDITOR_SAVE_WIDTH - RE_METRIC_EDITOR_DISCARD_WIDTH - RE_METRIC_EDITOR_MODE_WIDTH,
                                 RE_METRIC_EDITOR_MODE_WIDTH, RE_METRIC_EDITOR_DISCARD_WIDTH, RE_METRIC_EDITOR_SAVE_WIDTH},
                  RE_METRIC_EDITOR_TOOLBAR_HEIGHT);
    char crumbs[1100]; breadcrumb(crumbs, sizeof(crumbs), t->path);
    re_ui_label_ex(ui, crumbs, RE_UI_MUTED);
    re_ui_pill(ui, t->conflict ? "conflict" : t->dirty ? "unsaved draft" : t->editor ? re_editor_mode(t->editor) : "loading",
               t->conflict ? RE_UI_PILL_ERR : t->dirty ? RE_UI_PILL_WARN : RE_UI_PILL_NEUTRAL);
    if (re_ui_button_ex(ui, "Discard", RE_ICON_UNKNOWN, RE_UI_GHOST)) re_app_discard(a, index);
    re_app_control(a, ui, "discard", "", index);
    if (re_ui_button_ex(ui, "Save", RE_ICON_UNKNOWN, t->dirty ? RE_UI_PRIMARY : 0)) re_app_save(a, index);
    re_app_control(a, ui, "save", "", index);
    t->rect = mu_rect(content.x + RE_METRIC_EDITOR_INSET, content.y + top, re_max(0, content.w - 2 * RE_METRIC_EDITOR_INSET), re_max(0, content.h - RE_METRIC_EDITOR_BOTTOM - (top - RE_METRIC_EDITOR_TOP)));
    if (*t->error) {
      mu_layout_set_next(ui, mu_rect(content.x + RE_METRIC_EDITOR_INSET, content.y + content.h - RE_METRIC_EDITOR_ERROR_HEIGHT - RE_METRIC_EDITOR_ERROR_INSET, content.w - 2 * RE_METRIC_EDITOR_INSET, RE_METRIC_EDITOR_ERROR_HEIGHT), 0); mu_label(ui, t->error);
    }
  } else if (mode == RE_MODE_RAW || !re_format_scrolls(t->format)) {
    t->rect = mu_rect(content.x + RE_METRIC_EDITOR_INSET, content.y + RE_METRIC_EDITOR_TOP, re_max(0, content.w - 2 * RE_METRIC_EDITOR_INSET), re_max(0, content.h - RE_METRIC_EDITOR_BOTTOM));
  } else t->rect = below;
  if (action == RE_FORMAT_MODE) re_app_mode(a, index, re_format_requested(t->format));
  else if (action == RE_FORMAT_LOAD) { t->error[0] = 0; re_app_load(a, index); }
  else if (action == RE_FORMAT_ENTRY) re_app_load_entry(a, index);
  else if (action == RE_FORMAT_PAGE) { if (*re_format_entry(t->format)) re_app_load_entry(a, index); else re_app_load(a, index); }
}
static void pane_header(ReApp *a, mu_Context *ui, int n) {
  RePane *p = &a->layout.panes[n]; ReTabStrip *strip = &a->strips[n];
  ReDraw *draw = re_draw_active();
  re_ui_panel(draw, mu_rect(p->rect.x, p->rect.y, p->rect.w, RE_METRIC_DESIGN_TABS_HEIGHT), RE_COLOR_TABS_BG);
  if (!p->count) {
    int size = RE_METRIC_DESIGN_SIZE;
    re_draw_text_face(draw, RE_FACE_UI, size, "Empty pane · choose a view above", -1,
                      p->rect.x + RE_METRIC_DESIGN_PAD, p->rect.y + (RE_METRIC_DESIGN_TABS_HEIGHT - size) / 2 - 1, RE_COLOR_TEXT_MUTED);
    return;
  }
  int available = re_max(0, p->rect.w - 2 * RE_METRIC_TAB_INSET), nav = p->count * RE_METRIC_TAB_WIDTH > available ? re_min(RE_METRIC_TAB_NAV_WIDTH, available / 4) : 0;
  available -= 2 * nav;
  int slots = re_max(1, available / RE_METRIC_TAB_WIDTH), cell = re_min(RE_METRIC_TAB_WIDTH, available), selected_tab = p->tabs[p->selected];
  strip->first = re_max(0, re_min(strip->first, p->count - slots));
  if (strip->width != p->rect.w || strip->count != p->count || strip->selected != p->selected || strip->tab != selected_tab) {
    if (p->selected < strip->first) strip->first = p->selected;
    if (p->selected >= strip->first + slots) strip->first = p->selected - slots + 1;
  }
  strip->width = p->rect.w; strip->count = p->count; strip->selected = p->selected; strip->tab = selected_tab;
  int top = p->rect.y + RE_METRIC_TAB_TOP, height = RE_METRIC_DESIGN_TABS_HEIGHT - RE_METRIC_TAB_TOP;
  if (nav) {
    mu_layout_set_next(ui, mu_rect(p->rect.x + RE_METRIC_TAB_INSET, top, re_max(0, nav - RE_METRIC_TAB_GAP), height), 0);
    if (re_ui_button_ex(ui, "tab-previous", RE_ICON_CARET_LEFT, RE_UI_GHOST | RE_UI_ICON_ONLY)) strip->first = re_max(0, strip->first - slots);
    re_app_control(a, ui, "tab-scroll", "previous", n);
    mu_layout_set_next(ui, mu_rect(p->rect.x + p->rect.w - RE_METRIC_TAB_INSET - nav, top, re_max(0, nav - RE_METRIC_TAB_GAP), height), 0);
    if (re_ui_button_ex(ui, "tab-next", RE_ICON_COLLAPSED, RE_UI_GHOST | RE_UI_ICON_ONLY)) strip->first = re_min(re_max(0, p->count - slots), strip->first + slots);
    re_app_control(a, ui, "tab-scroll", "next", n);
  }
  for (int i = strip->first; i < re_min(p->count, strip->first + slots); i++) {
    int tab = p->tabs[i]; ReTab *t = &a->tabs[tab];
    /* The close control sits inside the tab, as the card draws it. */
    int close_width = re_min(RE_METRIC_DESIGN_ICON_BUTTON, re_max(0, cell / 3));
    mu_Rect r = mu_rect(p->rect.x + RE_METRIC_TAB_INSET + nav + (i - strip->first) * cell, top,
                        re_max(0, cell - RE_METRIC_TAB_GAP), height);
    mu_Rect close = mu_rect(r.x + r.w - close_width - RE_METRIC_DESIGN_GAP, r.y + (r.h - close_width) / 2, close_width, close_width);
    t->header = r;
    /* The tab face is owned drawing; the hit areas stay controls so automation and focus work. */
    re_ui_tab(draw, r, t->title, tab_icon(t), i == p->selected, t->dirty, close_width + RE_METRIC_DESIGN_GAP);
    mu_layout_set_next(ui, r, 0); mu_push_id(ui, &tab, sizeof(tab));
    if (re_ui_button_ex(ui, "", RE_ICON_UNKNOWN, RE_UI_GHOST | RE_UI_ICON_ONLY | RE_UI_TRANSPARENT)) {
      p->selected = i; a->layout.active = n; a->focus = -1; re_app_layout_changed(a);
    }
    re_app_control(a, ui, "tab", "", tab);
    mu_layout_set_next(ui, close, 0);
    bool closed = re_ui_button_ex(ui, "close", RE_ICON_CLOSE, RE_UI_GHOST | RE_UI_ICON_ONLY);
    re_app_control(a, ui, "detach", "", tab);
    if (closed) {
      re_layout_remove(&a->layout, tab); a->focus = -1;
      re_recording_close(t->recorder); t->recorder = NULL;
      re_terminal_close(t->terminal); t->terminal = NULL; re_game_close(t->game); t->game = NULL;
      t->header = mu_rect(0, 0, 0, 0); re_app_layout_changed(a);
    }
    mu_pop_id(ui); if (closed) break;
  }
}

/* The segmented status bar of the card: mode, message, then right-aligned facts. */
void re_app_status(ReApp *a, ReDraw *draw) {
  int height = RE_METRIC_DESIGN_STATUS_HEIGHT, size = RE_METRIC_DESIGN_SIZE_SM;
  int y = a->height - height, text_y = y + (height - size) / 2 - 1, x = RE_METRIC_DESIGN_PAD;
  re_ui_panel(draw, mu_rect(0, y, a->width, height), RE_COLOR_STATUS_BG);
  ReTab *focused = a->focus >= 0 && a->focus < RE_TABS ? &a->tabs[a->focus] : NULL;
  const char *mode = focused && focused->editor && a->vim ? re_editor_mode(focused->editor) : NULL;
  if (mode && *mode) {
    int width = re_draw_text_width(draw, RE_FACE_UI_SEMIBOLD, size, mode, -1) + 2 * RE_METRIC_DESIGN_GAP_LG;
    re_draw_rect(draw, mu_rect(0, y, width, height), RE_COLOR_STATUS_ACCENT_BG);
    re_draw_text_face(draw, RE_FACE_UI_SEMIBOLD, size, mode, -1, RE_METRIC_DESIGN_GAP_LG, text_y, RE_COLOR_STATUS_ACCENT_FG);
    x = width + RE_METRIC_DESIGN_PAD;
  }
  char facts[256];
  int sessions = cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(a->state, "sessions"));
  snprintf(facts, sizeof(facts), "%s · %s · %d session%s", root_name(a, a->root), *a->agent ? a->agent : "no agent",
           sessions, sessions == 1 ? "" : "s");
  int facts_width = re_draw_text_width(draw, RE_FACE_UI, size, facts, -1);
  int right = a->width - RE_METRIC_DESIGN_PAD - facts_width;
  re_draw_text_face(draw, RE_FACE_UI, size, facts, -1, right, text_y, RE_COLOR_STATUS_FG);
  re_draw_icon(draw, RE_ICON_AGENT, mu_rect(right - size - RE_METRIC_DESIGN_GAP, y, size, height), RE_COLOR_TEXT_FAINT);
  mu_Rect clip = mu_rect(x, y, re_max(0, right - x - RE_METRIC_DESIGN_PAD - size), height);
  re_draw_clip(draw, &clip);
  re_draw_text_face(draw, RE_FACE_UI, size, a->status, -1, x, text_y, RE_COLOR_STATUS_FG);
  re_draw_clip(draw, NULL);
}

/* The one overlay layer: sections of ordinary controls on a popover ground (spec 080). */
/* The workspace commands a menu row or a shortcut can run. The hints beside the rows name these
 * exact chords, and re_app_event serves them, so a menu never advertises a key that does nothing. */
enum { RE_COMMAND_SPLIT_VERTICAL = 0, RE_COMMAND_SPLIT_HORIZONTAL, RE_COMMAND_MERGE,
       RE_COMMAND_SHELL, RE_COMMAND_AGENT, RE_COMMAND_CLOSE_VIEW };
#if defined(__APPLE__)
#define RE_SHORTCUT_SPLIT_VERTICAL   "Cmd \\"
#define RE_SHORTCUT_SPLIT_HORIZONTAL "Cmd Shift \\"
#define RE_SHORTCUT_MERGE            "Cmd Backspace"
#define RE_SHORTCUT_SHELL            "Cmd T"
#define RE_SHORTCUT_CLOSE            "Cmd W"
#else
#define RE_SHORTCUT_SPLIT_VERTICAL   "Ctrl \\"
#define RE_SHORTCUT_SPLIT_HORIZONTAL "Ctrl Shift \\"
#define RE_SHORTCUT_MERGE            "Ctrl Backspace"
#define RE_SHORTCUT_SHELL            "Ctrl T"
#define RE_SHORTCUT_CLOSE            "Ctrl W"
#endif

static void close_view(ReApp *a) {
  RePane *p = &a->layout.panes[a->layout.active];
  if (!p->count) { re_copy(a->status, sizeof(a->status), "This pane has no view to close."); return; }
  int tab = p->tabs[p->selected]; ReTab *t = &a->tabs[tab];
  re_layout_remove(&a->layout, tab); a->focus = -1;
  re_recording_close(t->recorder); t->recorder = NULL;
  re_terminal_close(t->terminal); t->terminal = NULL; re_game_close(t->game); t->game = NULL;
  t->header = mu_rect(0, 0, 0, 0); re_app_layout_changed(a);
}
static void run_command(ReApp *a, int command) {
  switch (command) {
    case RE_COMMAND_SPLIT_VERTICAL: re_layout_split(&a->layout, a->layout.active, 1); re_app_layout_changed(a); break;
    case RE_COMMAND_SPLIT_HORIZONTAL: re_layout_split(&a->layout, a->layout.active, 2); re_app_layout_changed(a); break;
    case RE_COMMAND_MERGE:
      if (re_layout_collapse(&a->layout, a->layout.active) >= 0) { a->focus = -1; re_app_layout_changed(a); }
      else re_copy(a->status, sizeof(a->status), "This is already the only pane.");
      break;
    case RE_COMMAND_SHELL: launch_terminal(a, false, false); break;
    case RE_COMMAND_AGENT: launch_terminal(a, true, false); break;
    case RE_COMMAND_CLOSE_VIEW: close_view(a); break;
    default: break;
  }
}

/* Opening a surface closes whatever was open, which is how spec 080 decision 5 stays true without a
 * rule anyone has to remember: the workspace holds one overlay kind, not a flag per surface. */
static void overlay_open(ReApp *a, mu_Context *ui, int kind) {
  if (a->overlay == kind) { a->overlay = RE_OVERLAY_NONE; a->overlay_restore = true; return; }
  a->overlay = kind; a->overlay_anchor = ui->last_rect; a->overlay_opener = ui->last_id;
}
static void overlay_close(ReApp *a) { if (a->overlay) { a->overlay = RE_OVERLAY_NONE; a->overlay_restore = true; } }

/* Every overlay is the same surface: a shadow, a raised ground and a frame, placed under its anchor
 * and pulled inside the window. The caller then fills it with rows. */
static bool overlay_begin(ReApp *a, mu_Context *ui, int width, int height) {
  int pad = RE_METRIC_DESIGN_PAD, gap = RE_METRIC_DESIGN_GAP;
  int x = re_min(a->overlay_anchor.x, a->width - width - pad);
  int y = a->overlay_anchor.y + a->overlay_anchor.h + gap;
  if (y + height > a->height - pad) y = re_max(pad, a->overlay_anchor.y - height - gap);
  mu_Rect rect = mu_rect(re_max(pad, x), y, width, height);
  a->overlay_rect = rect;
  mu_Container *container = mu_get_container(ui, "Overlay");
  container->rect = rect;
  /* The overlay is drawn above every pane, and input has to agree: microui routes the mouse to the
   * frontmost container, and clicking a pane brings that pane forward, which would leave the surface
   * visible but deaf. Bringing it to front each frame keeps what is on top the thing you can click. */
  mu_bring_to_front(ui, container);
  if (!mu_begin_window_ex(ui, "Overlay", rect, MU_OPT_NOTITLE | MU_OPT_NORESIZE | MU_OPT_NOCLOSE | MU_OPT_NOSCROLL | MU_OPT_NOFRAME)) return false;
  re_ui_overlay_begin();
  re_ui_popover(rect);
  return true;
}
static void overlay_end(mu_Context *ui) { re_ui_overlay_end(); mu_end_window(ui); }

/* The project menu from the menus card: the roots, the live one marked, then the add action. */
static void roots_menu(ReApp *a, mu_Context *ui) {
  cJSON *roots = cJSON_GetObjectItemCaseSensitive(a->state, "roots");
  int count = cJSON_GetArraySize(roots), row = RE_METRIC_DESIGN_ROW;
  int height = RE_METRIC_DESIGN_PAD * 2 + (count + 1) * (row + 2) + RE_METRIC_DESIGN_GAP * 2;
  if (!overlay_begin(a, ui, RE_METRIC_SETTINGS_WIDTH, height)) return;
  for (int i = 0; i < count; i++) {
    const cJSON *entry = cJSON_GetArrayItem(roots, i);
    const char *id = re_string(entry, "id"), *name = root_name(a, id);
    mu_layout_row(ui, 1, (int[]){-1}, row);
    mu_push_id(ui, id, (int)strlen(id));
    if (re_ui_menu_item(ui, name, RE_ICON_PROJECT, "", !strcmp(id, a->root))) {
      re_copy(a->root, sizeof(a->root), id); overlay_close(a);
    }
    re_app_control(a, ui, "menu-root", name, -1);
    mu_pop_id(ui);
  }
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DESIGN_GAP * 2);
  re_ui_menu_separator(ui);
  mu_layout_row(ui, 1, (int[]){-1}, row);
  if (re_ui_menu_item(ui, "Add project\u2026", RE_ICON_ADD, "", false)) {
    if (*a->project_input) { cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "path", a->project_input); re_app_action(a, "roots", j); cJSON_Delete(j); }
    else re_copy(a->status, sizeof(a->status), "Type a project path in the toolbar, then choose Add project.");
    overlay_close(a);
  }
  re_app_control(a, ui, "menu-root", "Add project", -1);
  overlay_end(ui);
}

/* The context menu from the menus card, with the shortcuts the workspace actually serves. */
static void pane_menu(ReApp *a, mu_Context *ui) {
  int row = RE_METRIC_DESIGN_ROW, sep = RE_METRIC_DESIGN_GAP * 2;
  int height = RE_METRIC_DESIGN_PAD * 2 + 6 * (row + 2) + 2 * sep;
  if (!overlay_begin(a, ui, RE_METRIC_SETTINGS_WIDTH, height)) return;
  struct { const char *label; int icon; const char *hint; int action; } items[] = {
    {"Split vertical", RE_ICON_SPLIT_VERTICAL, RE_SHORTCUT_SPLIT_VERTICAL, RE_COMMAND_SPLIT_VERTICAL},
    {"Split horizontal", RE_ICON_SPLIT_HORIZONTAL, RE_SHORTCUT_SPLIT_HORIZONTAL, RE_COMMAND_SPLIT_HORIZONTAL},
    {"Merge pane", RE_ICON_MERGE_PANE, RE_SHORTCUT_MERGE, RE_COMMAND_MERGE},
    {"", 0, "", -1},
    {"New shell here", RE_ICON_SHELL, RE_SHORTCUT_SHELL, RE_COMMAND_SHELL},
    {"New agent session", RE_ICON_AGENT, "", RE_COMMAND_AGENT},
    {"", 0, "", -1},
    {"Close view", RE_ICON_CLOSE, RE_SHORTCUT_CLOSE, RE_COMMAND_CLOSE_VIEW},
  };
  for (int i = 0; i < (int)(sizeof(items) / sizeof(items[0])); i++) {
    if (items[i].action < 0) { mu_layout_row(ui, 1, (int[]){-1}, sep); re_ui_menu_separator(ui); continue; }
    mu_layout_row(ui, 1, (int[]){-1}, row);
    if (re_ui_menu_item(ui, items[i].label, items[i].icon, items[i].hint, false)) {
      run_command(a, items[i].action); overlay_close(a);
    }
    re_app_control(a, ui, "menu-pane", items[i].label, -1);
  }
  overlay_end(ui);
}

/* Theme files: the path field resolves against the active root when it is not absolute, which is the
 * reach spec 080 allows (a project root and the workspace's own directory). */
static void theme_file_path(ReApp *a, const char *given, char *out, size_t size) {
  if (*given == '/' || (given[0] && given[1] == ':')) { snprintf(out, size, "%s", given); return; }
  const char *base = root_path(a, a->root);
  snprintf(out, size, "%s%s%s", base, *base ? "/" : "", given);
}
static bool theme_remembered(ReApp *a, const char *root) {
  const cJSON *themes = cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(a->state, "preferences"), "themes");
  return *re_string(themes, root) != 0;
}
static void theme_remember(ReApp *a, const char *root, const char *name) {
  cJSON *themes = cJSON_CreateObject(); cJSON_AddStringToObject(themes, root, name);
  cJSON *j = cJSON_CreateObject(); cJSON_AddItemToObject(j, "themes", themes);
  re_app_action(a, "preferences", j); cJSON_Delete(j);
}
static void theme_file_import(ReApp *a) {
  char message[256], path[2048];
  if (!*a->theme_path) { re_copy(a->status, sizeof(a->status), "Type a theme file path first."); return; }
  theme_file_path(a, a->theme_path, path, sizeof(path));
  re_theme_file_load(path, message, sizeof(message));
  float hue = re_theme_file_hue();
  if (hue >= 0) a->accent_hue = hue;
  re_copy(a->status, sizeof(a->status), message);
}
static void theme_file_export(ReApp *a) {
  char message[256], path[2048];
  if (!*a->theme_path) { re_copy(a->status, sizeof(a->status), "Type a theme file path to export to."); return; }
  theme_file_path(a, a->theme_path, path, sizeof(path));
  re_theme_file_save(path, re_theme_preset_names[a->preset], message, sizeof(message));
  re_copy(a->status, sizeof(a->status), message);
}
/* A root carries its theme at .rengine/theme.conf. The probe only reads the header, and only when
 * the popover is open, so opening a repository costs nothing. */
static void project_theme_probe(ReApp *a) {
  if (!strcmp(a->project_theme_root, a->root)) return;
  re_copy(a->project_theme_root, sizeof(a->project_theme_root), a->root);
  a->project_theme[0] = 0; a->project_theme_path[0] = 0;
  const char *base = root_path(a, a->root);
  if (!*base) return;
  snprintf(a->project_theme_path, sizeof(a->project_theme_path), "%s/.rengine/theme.conf", base);
  FILE *handle = fopen(a->project_theme_path, "rb");
  if (!handle) { a->project_theme_path[0] = 0; return; }
  char line[256] = {0};
  if (fgets(line, sizeof(line), handle)) {
    const char *quote = strchr(line, '"');
    const char *close = quote ? strchr(quote + 1, '"') : NULL;
    if (close) {
      size_t n = (size_t)(close - quote - 1);
      if (n >= sizeof(a->project_theme)) n = sizeof(a->project_theme) - 1;
      memcpy(a->project_theme, quote + 1, n); a->project_theme[n] = 0;
    }
  }
  fclose(handle);
  if (!*a->project_theme) a->project_theme_path[0] = 0;
}

void re_app_project_theme(ReApp *a) {
  project_theme_probe(a);
  if (!*a->project_theme || !theme_remembered(a, a->root)) return;
  char message[256];
  re_theme_file_load(a->project_theme_path, message, sizeof(message));
  float hue = re_theme_file_hue();
  if (hue >= 0) a->accent_hue = hue;
  re_copy(a->status, sizeof(a->status), message);
}

static void settings_ui(ReApp *a, mu_Context *ui) {
  int pad = RE_METRIC_DESIGN_PAD, row = RE_METRIC_DESIGN_CONTROL_HEIGHT, gap = RE_METRIC_DESIGN_GAP;
  int rows = 10 + (*a->project_theme ? 1 : 0);
  int height = pad * 2 + rows * (row + gap) + 4 * RE_METRIC_DESIGN_ROW;
  if (!overlay_begin(a, ui, RE_METRIC_SETTINGS_WIDTH, height)) return;
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DESIGN_ROW);
  re_ui_heading(ui, "Appearance");
  mu_layout_row(ui, 2, (int[]){RE_METRIC_SETTINGS_LABEL_WIDTH, -1}, row);
  re_ui_label_ex(ui, "Theme", RE_UI_MUTED | RE_UI_SMALL);
  if (re_ui_button_ex(ui, re_theme_preset_names[a->preset], RE_ICON_THEME, RE_UI_ALIGN_LEFT | RE_UI_CARET)) {
    a->preset = (a->preset + 1) % RE_PRESET_COUNT;
    re_draw_theme(re_draw_active(), re_theme_preset_names[a->preset]);
    cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "theme", re_theme_preset_names[a->preset]);
    re_app_action(a, "preferences", j); cJSON_Delete(j);
  }
  re_app_control(a, ui, "settings", "theme", -1);
  mu_layout_row(ui, 2, (int[]){RE_METRIC_SETTINGS_LABEL_WIDTH, -1}, row);
  re_ui_label_ex(ui, "Syntax", RE_UI_MUTED | RE_UI_SMALL);
  if (re_ui_button_ex(ui, *a->scheme ? a->scheme : re_scheme_names[0], RE_ICON_FILE, RE_UI_ALIGN_LEFT | RE_UI_CARET)) {
    int current = 0;
    for (int i = 0; i < RE_SCHEME_COUNT; i++) if (!strcmp(re_scheme_names[i], *a->scheme ? a->scheme : re_scheme_names[0])) current = i;
    re_copy(a->scheme, sizeof(a->scheme), re_scheme_names[(current + 1) % RE_SCHEME_COUNT]);
    re_editor_scheme(a->scheme);
    cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "syntax", a->scheme);
    re_app_action(a, "preferences", j); cJSON_Delete(j);
  }
  re_app_control(a, ui, "settings", "syntax", -1);
  mu_layout_row(ui, 2, (int[]){RE_METRIC_SETTINGS_LABEL_WIDTH, -1}, row);
  re_ui_label_ex(ui, "Accent", RE_UI_MUTED | RE_UI_SMALL);
  if (re_ui_hue_slider(ui, &a->accent_hue)) {
    re_theme_hue_set(a->accent_hue);
    cJSON *j = cJSON_CreateObject(); cJSON_AddNumberToObject(j, "accentHue", a->accent_hue);
    re_app_action(a, "preferences", j); cJSON_Delete(j);
  }
  re_app_control(a, ui, "settings", "accent", -1);
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DESIGN_ROW);
  re_ui_heading(ui, "Editor");
  int vim = a->vim;
  mu_layout_row(ui, 1, (int[]){-1}, row);
  if (re_ui_checkbox(ui, "Vim mode", &vim)) {
    a->vim = vim != 0;
    for (int i = 0; i < RE_TABS; i++) if (a->tabs[i].editor) re_editor_vim(a->tabs[i].editor, a->vim);
    cJSON *j = cJSON_CreateObject(); cJSON_AddBoolToObject(j, "vim", a->vim); re_app_action(a, "preferences", j); cJSON_Delete(j);
  }
  re_app_control(a, ui, "settings", "vim", -1);
  int nested = a->explorer_nested;
  mu_layout_row(ui, 1, (int[]){-1}, row);
  if (re_ui_checkbox(ui, "Expand folders in place", &nested)) {
    a->explorer_nested = nested != 0;
    cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "explorer", a->explorer_nested ? "nested" : "flat");
    re_app_action(a, "preferences", j); cJSON_Delete(j);
  }
  re_app_control(a, ui, "settings", "explorer", -1);
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DESIGN_ROW);
  re_ui_heading(ui, "Theme file");
  mu_layout_row(ui, 1, (int[]){-1}, row);
  re_ui_textbox_ex(ui, a->theme_path, sizeof(a->theme_path), RE_ICON_FILE, "themes/sunset.conf", 0);
  re_app_control(a, ui, "settings", "theme-path", -1);
  mu_layout_row(ui, 2, (int[]){RE_METRIC_SETTINGS_WIDTH / 2 - RE_METRIC_DESIGN_PAD, -1}, row);
  if (re_ui_button_ex(ui, "Import", RE_ICON_ARROW_UP, 0)) theme_file_import(a);
  re_app_control(a, ui, "settings", "import", -1);
  if (re_ui_button_ex(ui, "Export", RE_ICON_FILE, 0)) theme_file_export(a);
  re_app_control(a, ui, "settings", "export", -1);
  project_theme_probe(a);
  if (*a->project_theme) {
    mu_layout_row(ui, 1, (int[]){-1}, row);
    char offer[128]; snprintf(offer, sizeof(offer), "Use \"%s\" from this project", a->project_theme);
    /* Offered, never applied on its own: a repository never changes the workspace's appearance
     * until someone here asks for it (charter D34). */
    if (re_ui_menu_item(ui, offer, RE_ICON_PROJECT, "", theme_remembered(a, a->root))) {
      char message[256];
      if (re_theme_file_load(a->project_theme_path, message, sizeof(message))) theme_remember(a, a->root, a->project_theme);
      re_copy(a->status, sizeof(a->status), message);
    }
    re_app_control(a, ui, "settings", "project-theme", -1);
  }
  overlay_end(ui);
}

void re_app_ui(ReApp *a, mu_Context *ui, int width, int height) {
  if (a->controls) { cJSON_Delete(a->controls); a->controls = cJSON_CreateArray(); }
  int opts = MU_OPT_NOTITLE | MU_OPT_NORESIZE | MU_OPT_NOCLOSE | MU_OPT_NOSCROLL;
  a->width = width; a->height = height;
  re_ui_begin(re_draw_active(), (double)SDL_GetTicks64() / 1000.0); /* one clock for every control's transitions */
  mu_get_container(ui, "Toolbar")->rect = mu_rect(0, 0, width, RE_METRIC_DESIGN_TOOLBAR_HEIGHT);
  if (mu_begin_window_ex(ui, "Toolbar", mu_rect(0, 0, width, RE_METRIC_DESIGN_TOOLBAR_HEIGHT), opts | MU_OPT_NOFRAME)) {
    ReToolbar bar = toolbar_open(ui, width);
    re_ui_panel(bar.draw, mu_rect(0, 0, width, RE_METRIC_DESIGN_TOOLBAR_HEIGHT), RE_COLOR_TOOLBAR_BG);
    toolbar_brand(&bar);
    int views = 5, view_index = 0, group_left = 0;
    struct { const char *label; int icon; } switcher[] = {
      {"Tree", RE_ICON_TREE}, {"Dashboard", RE_ICON_PROJECT}, {"Devices", RE_ICON_MENU}, {"Shell", RE_ICON_SHELL}, {"Agent", RE_ICON_AGENT} };
    for (int i = 0; i < views; i++, view_index++) {
      int opt = RE_UI_GROUP_MIDDLE;
      if (i == 0) opt = RE_UI_GROUP_FIRST;
      else if (i == views - 1) opt = RE_UI_GROUP_LAST;
      if (!i) group_left = bar.x + RE_METRIC_DESIGN_GAP_LG;
      if (toolbar_cell(&bar, switcher[i].label, switcher[i].icon, opt, i ? 0 : RE_METRIC_DESIGN_GAP_LG)) {
        if (i == 0) { if (*a->root) re_app_tab(a, RE_TREE, a->root, "", "", "Project"); }
        else if (i == 1) { if (re_app_dashboard(a, a->root) < 0) re_copy(a->status, sizeof(a->status), "Add or select a project first."); }
        else if (i == 2) { if (re_app_devices(a, a->root) < 0) re_copy(a->status, sizeof(a->status), "Add or select a project first."); }
        else launch_terminal(a, i == 4, false);
      }
      re_app_control(a, ui, "toolbar", switcher[i].label, -1);
    }
    re_draw_ring(bar.draw, mu_rect(group_left, bar.y, bar.x - group_left, bar.h), RE_COLOR_BORDER, RE_METRIC_DESIGN_RADIUS, 1);
    if (toolbar_cell(&bar, "Manage", RE_ICON_UNKNOWN, RE_UI_GHOST, RE_METRIC_DESIGN_GAP_LG)) launch_terminal(a, true, true);
    re_app_control(a, ui, "toolbar", "Manage", -1);
    if (toolbar_cell(&bar, "Sessions", RE_ICON_UNKNOWN, RE_UI_GHOST, RE_METRIC_DESIGN_GAP_LG)) re_app_tab(a, RE_SESSIONS, "", "", "", "Sessions");
    re_app_control(a, ui, "toolbar", "Sessions", -1);
    toolbar_separator(&bar);
    if (toolbar_cell(&bar, "Split vertical", RE_ICON_SPLIT_VERTICAL, RE_UI_GHOST | RE_UI_ICON_ONLY, RE_METRIC_DESIGN_GAP_LG)) {
      re_layout_split(&a->layout, a->layout.active, 1); re_app_layout_changed(a);
    }
    re_app_control(a, ui, "toolbar", "Split vertical", -1);
    if (toolbar_cell(&bar, "Split horizontal", RE_ICON_SPLIT_HORIZONTAL, RE_UI_GHOST | RE_UI_ICON_ONLY, RE_METRIC_DESIGN_GAP_LG)) {
      re_layout_split(&a->layout, a->layout.active, 2); re_app_layout_changed(a);
    }
    re_app_control(a, ui, "toolbar", "Split horizontal", -1);
    if (toolbar_cell(&bar, "Merge pane", RE_ICON_MERGE_PANE, RE_UI_GHOST | RE_UI_ICON_ONLY, RE_METRIC_DESIGN_GAP_LG)) {
      if (re_layout_collapse(&a->layout, a->layout.active) >= 0) { a->focus = -1; re_app_layout_changed(a); }
      else re_copy(a->status, sizeof(a->status), "This is already the only pane.");
    }
    re_app_control(a, ui, "toolbar", "Merge pane", -1);
    toolbar_separator(&bar);
    if (toolbar_cell(&bar, root_name(a, a->root), RE_ICON_PROJECT,
                     RE_UI_ALIGN_LEFT | RE_UI_CARET | (a->overlay == RE_OVERLAY_ROOTS ? RE_UI_ON : 0), RE_METRIC_DESIGN_GAP_LG)) {
      overlay_open(a, ui, RE_OVERLAY_ROOTS);   /* the project list is a menu now, not a cycle (spec 080) */
    }
    re_app_control(a, ui, "toolbar", "Root", -1);
    /* The path field takes the slack, as the card's caption describes. */
    int trailing = toolbar_width(&bar, "Add project", RE_ICON_UNKNOWN, 0)
                 + re_draw_text_width(bar.draw, RE_FACE_UI, RE_METRIC_DESIGN_SIZE_SM, "Agent", -1)
                 + RE_METRIC_TOOLBAR_AGENT_WIDTH
                 + RE_METRIC_DESIGN_ICON_BUTTON
                 + 5 * RE_METRIC_DESIGN_GAP_LG;
    toolbar_next(&bar, re_max(RE_METRIC_DESIGN_ICON_BUTTON, bar.right - bar.x - trailing), RE_METRIC_DESIGN_GAP_LG);
    re_ui_textbox_ex(ui, a->project_input, sizeof(a->project_input), RE_ICON_SEARCH, "Project path or repository URL…", 0);
    re_app_control(a, ui, "textbox", "project", -1);
    if (toolbar_cell(&bar, "Add project", RE_ICON_UNKNOWN, 0, RE_METRIC_DESIGN_GAP_LG)) {
      cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "path", a->project_input); re_app_action(a, "roots", j); cJSON_Delete(j);
    }
    re_app_control(a, ui, "toolbar", "Add project", -1);
    toolbar_label(&bar, "Agent");
    toolbar_next(&bar, RE_METRIC_TOOLBAR_AGENT_WIDTH, RE_METRIC_DESIGN_GAP_LG);
    re_ui_textbox_ex(ui, a->agent, sizeof(a->agent), RE_ICON_AGENT, "codex", 0);
    re_app_control(a, ui, "textbox", "agent", -1);
    /* Vim moved into the settings popover with the rest of the settings (spec 080 decision 4). */
    if (toolbar_cell(&bar, "Settings", RE_ICON_THEME, RE_UI_GHOST | RE_UI_ICON_ONLY | (a->overlay == RE_OVERLAY_SETTINGS ? RE_UI_ON : 0), RE_METRIC_DESIGN_GAP_LG)) {
      overlay_open(a, ui, RE_OVERLAY_SETTINGS);
    }
    re_app_control(a, ui, "toolbar", "Settings", -1);
    mu_end_window(ui);
  }
  if (a->overlay_restore) { mu_set_focus(ui, a->overlay_opener); a->overlay_restore = false; }
  if (a->overlay == RE_OVERLAY_SETTINGS) settings_ui(a, ui);
  else if (a->overlay == RE_OVERLAY_ROOTS) roots_menu(a, ui);
  else if (a->overlay == RE_OVERLAY_PANE) pane_menu(a, ui);
  re_layout_measure(&a->layout, mu_rect(0, RE_METRIC_WORKSPACE_TOP, width, height - RE_METRIC_WORKSPACE_TOP - RE_METRIC_WORKSPACE_STATUS_HEIGHT));
  for (int i = 0; i < RE_TABS; i++) { a->tabs[i].rect = mu_rect(0, 0, 0, 0); a->tabs[i].header = mu_rect(0, 0, 0, 0); }
  for (int n = 0; n < RE_PANES; n++) {
    RePane *p = &a->layout.panes[n]; if (!p->used || p->axis) continue;
    char title[40]; snprintf(title, sizeof(title), "Pane header %d", n); mu_Rect header = p->rect; header.h = RE_METRIC_PANE_HEADER_HEIGHT;
    mu_get_container(ui, title)->rect = header;
    if (mu_begin_window_ex(ui, title, header, opts | MU_OPT_NOFRAME)) { /* the strip is owned drawing */
      pane_header(a, ui, n);
      mu_end_window(ui);
    }
    snprintf(title, sizeof(title), "Pane content %d", n);
    mu_Rect content = mu_rect(p->rect.x, p->rect.y + RE_METRIC_PANE_CONTENT_TOP, p->rect.w, re_max(0, p->rect.h - RE_METRIC_PANE_CONTENT_TOP)), below = mu_rect(0, 0, 0, 0);
    if (!p->count) { mu_get_container(ui, title)->rect = content; continue; }
    int index = p->tabs[p->selected]; ReTab *t = &a->tabs[index];
    bool format_view = t->type == RE_EDITOR && t->format && re_format_scrolls(t->format);
    int content_opts = t->type == RE_TREE || t->type == RE_SESSIONS || t->type == RE_DASHBOARD || t->type == RE_DEVICES || format_view ? opts & ~MU_OPT_NOSCROLL : opts;
    if (format_view && re_format_split(t->format)) {
      int h = content.h * RE_METRIC_FORMAT_ENTRY_PERCENT / 100;
      below = mu_rect(content.x + RE_METRIC_EDITOR_INSET, content.y + content.h - h, re_max(0, content.w - 2 * RE_METRIC_EDITOR_INSET), re_max(0, h - RE_METRIC_EDITOR_INSET)); content.h -= h;
    }
    mu_get_container(ui, title)->rect = content;
    re_ui_panel(re_draw_active(), content, RE_COLOR_SURFACE); /* the window is frameless so views can draw their own faces */
    if (mu_begin_window_ex(ui, title, content, content_opts | MU_OPT_NOFRAME)) {
      re_ui_clip(ui);   /* a scrolled view's own drawing stays inside its pane (KI: rows over the toolbar) */
      /* The explorer shows the root in its own path bar; every other view keeps this row. */
      if (t->type != RE_TREE) { mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_PANE_ROOT_ROW_HEIGHT); re_ui_label_ex(ui, root_name(a, t->root), RE_UI_MUTED); }
      if (t->type == RE_TREE) tree_ui(a, ui, index);
      else if (t->type == RE_SESSIONS) sessions_ui(a, ui);
      else if (t->type == RE_DASHBOARD) re_dashboard_ui(a, ui, index);
      else if (t->type == RE_DEVICES) re_devices_ui(a, ui, index);
      else if (t->type == RE_EDITOR) editor_ui(a, ui, index, content, below);
      else if (t->type == RE_TERMINAL) {
        t->rect = mu_rect(content.x + RE_METRIC_TERMINAL_INSET, content.y + RE_METRIC_TERMINAL_TOP, re_max(0, content.w - 2 * RE_METRIC_TERMINAL_INSET), re_max(0, content.h - RE_METRIC_TERMINAL_BOTTOM));
      } else if (t->type == RE_GAME && t->terminal) {
        bool running = session_running(a, t->session);
        mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_GAME_ROW_HEIGHT);
        mu_label(ui, running ? "Running in its own window" : "Game exited · reattach or Stop in Sessions"); re_app_control(a, ui, "game-status", running ? "running" : "exited", index);
        t->rect = mu_rect(content.x + RE_METRIC_GAME_INSET, content.y + RE_METRIC_GAME_TOP, re_max(0, content.w - 2 * RE_METRIC_GAME_INSET), re_max(0, content.h - RE_METRIC_GAME_BOTTOM));
      } else if (t->game) {
        /* One row: the capture control, then the recording toggle, the ring commit and the status
           (spec 081). The game rectangle below it keeps its metrics. */
        mu_layout_row(ui, 4, (int[]){RE_METRIC_GAME_CAPTURE_WIDTH, RE_METRIC_RECORDING_TOGGLE_WIDTH,
                                     RE_METRIC_RECORDING_COMMIT_WIDTH, -1}, RE_METRIC_GAME_ROW_HEIGHT);
        if (mu_button(ui, t->game->captured ? "Captured · Esc releases" : "Capture mouse")) { re_game_capture(t->game); a->focus = index; }
        re_recording_ui(a, ui, index);
        t->rect = mu_rect(content.x + RE_METRIC_GAME_INSET, content.y + RE_METRIC_GAME_TOP, re_max(0, content.w - 2 * RE_METRIC_GAME_INSET), re_max(0, content.h - RE_METRIC_GAME_BOTTOM));
      }
      mu_end_window(ui);
      if (a->controls && (t->type == RE_TREE || t->type == RE_SESSIONS || t->type == RE_DASHBOARD || t->type == RE_DEVICES || format_view)) {
        mu_Container *container = mu_get_container(ui, title);
        if (container->content_size.y + ui->style->padding * 2 > container->body.h) {
          inspect_rect(a, "scrollbar", "y", index, mu_rect(container->body.x + container->body.w, container->body.y, ui->style->scrollbar_size, container->body.h));
        }
      }
    }
  }
  re_ui_end(re_draw_active());   /* the panes and the status bar draw next, and they clip themselves */
}
void re_app_draw(ReApp *a, ReDraw *draw) {
  for (int i = 0; i < RE_TABS; i++) {
    ReTab *t = &a->tabs[i];
    if (t->game) {
      re_game_tick(t->game, draw);
      if (t->rect.w <= 0 && (t->game->captured || t->game->focused)) re_game_release(t->game);
    }
    if (t->rect.w <= 0 || t->rect.h <= 0) { if (t->terminal) re_terminal_release(t->terminal); continue; }
    if (t->terminal) re_terminal_draw(t->terminal, draw, t->rect, a->focus == i);
    if (t->editor) re_editor_draw(t->editor, draw, t->rect, a->focus == i);
    else if (t->format) re_format_draw(t->format, draw, t->rect, a->focus == i);
    if (t->game) re_game_draw(t->game, draw, t->rect);
  }
  for (int n = 0; n < RE_PANES; n++) if (a->layout.panes[n].used && a->layout.panes[n].axis)
    re_draw_rect(draw, a->layout.panes[n].divider, RE_COLOR_DIVIDER);
  if (a->scene) re_scene_draw(a->scene, draw);
}
bool re_app_event(ReApp *a, const SDL_Event *e, ReDraw *draw) {
  if (e->type == SDL_MOUSEMOTION) { a->mouse_x = e->motion.x; a->mouse_y = e->motion.y; }
  if (e->type == SDL_MOUSEBUTTONDOWN || e->type == SDL_MOUSEBUTTONUP) { a->mouse_x = e->button.x; a->mouse_y = e->button.y; }
  /* The overlay is the top surface: Escape closes it, and so does a press outside it. A press on the
   * control that opened it falls through, so that control's own toggle closes it instead of reopening
   * it on the next frame (spec 080 decision 5). */
  if (a->overlay) {
    if (e->type == SDL_KEYDOWN && e->key.keysym.sym == SDLK_ESCAPE) { overlay_close(a); return true; }
    /* The surface is drawn above every pane, so it owns the pointer over its own rectangle. Without
     * this a terminal beneath it takes the press first and the rows over that terminal look dead,
     * which is exactly how the owner found it: the top rows answered and the lower ones did not. */
    bool pointer = e->type == SDL_MOUSEMOTION || e->type == SDL_MOUSEBUTTONDOWN ||
                   e->type == SDL_MOUSEBUTTONUP || e->type == SDL_MOUSEWHEEL;
    if (pointer && re_inside(a->overlay_rect, a->mouse_x, a->mouse_y)) return false;
    /* An outside press closes the surface and then goes on to whatever it landed on, so choosing
     * another toolbar control takes one click. The opener is excluded, because its own toggle
     * closes the surface and would otherwise reopen it on the same press. */
    if ((e->type == SDL_MOUSEBUTTONDOWN) &&
        !re_inside(a->overlay_rect, e->button.x, e->button.y) && !re_inside(a->overlay_anchor, e->button.x, e->button.y)) {
      overlay_close(a);
    }
  }
  /* A press with the platform modifier runs a workspace command before any pane sees the key, so the
   * hints the menu prints are the keys that work. */
  if (e->type == SDL_KEYDOWN && (e->key.keysym.mod & (KMOD_GUI | KMOD_CTRL)) && !a->quitting) {
    bool shift = (e->key.keysym.mod & KMOD_SHIFT) != 0;
    switch (e->key.keysym.sym) {
      case SDLK_BACKSLASH: run_command(a, shift ? RE_COMMAND_SPLIT_HORIZONTAL : RE_COMMAND_SPLIT_VERTICAL); return true;
      case SDLK_BACKSPACE: run_command(a, RE_COMMAND_MERGE); return true;
      case SDLK_t: run_command(a, RE_COMMAND_SHELL); return true;
      case SDLK_w: run_command(a, RE_COMMAND_CLOSE_VIEW); return true;
      default: break;
    }
  }
  /* A right press on a pane's tab strip opens the context menu of the menus card. */
  if (e->type == SDL_MOUSEBUTTONDOWN && e->button.button == SDL_BUTTON_RIGHT && !a->quitting) {
    for (int n = 0; n < RE_PANES; n++) {
      RePane *p = &a->layout.panes[n];
      if (!p->used || p->axis) continue;
      mu_Rect strip = mu_rect(p->rect.x, p->rect.y, p->rect.w, RE_METRIC_DESIGN_TABS_HEIGHT);
      if (!re_inside(strip, e->button.x, e->button.y)) continue;
      a->layout.active = n;
      a->overlay = RE_OVERLAY_PANE;
      a->overlay_anchor = mu_rect(e->button.x, e->button.y, 0, 0);
      a->overlay_opener = 0;
      return true;
    }
  }
  if (e->type == SDL_MOUSEWHEEL && !a->quitting) {
    for (int i = 0; i < RE_TABS; i++) if ((a->tabs[i].terminal || a->tabs[i].editor || a->tabs[i].format) && re_inside(a->tabs[i].rect, a->mouse_x, a->mouse_y)) {
      ReTab *t = &a->tabs[i];
      if (t->terminal) { if (!re_terminal_mouse(t->terminal, e, a->mouse_x, a->mouse_y)) re_terminal_event(t->terminal, e); }
      else if (t->editor) re_editor_event(t->editor, e, t->rect, re_draw_cell_width(draw), re_draw_line_height(draw));
      else re_format_event(t->format, e, t->rect, re_draw_cell_width(draw), re_draw_line_height(draw));
      return true;
    }
    if (a->focus >= 0 && a->tabs[a->focus].game && re_inside(a->tabs[a->focus].rect, a->mouse_x, a->mouse_y)) {
      re_game_event(a->tabs[a->focus].game, e); return true;
    }
    return false;
  }
  int previous_focus = a->focus;
  if (e->type == SDL_MOUSEBUTTONDOWN && e->button.button == SDL_BUTTON_LEFT) {
    a->resize_pane = re_layout_hit(&a->layout, e->button.x, e->button.y, true);
    int pane = re_layout_hit(&a->layout, e->button.x, e->button.y, false);
    if (pane >= 0) a->layout.active = pane;
    a->focus = -1;
    for (int i = 0; i < RE_TABS; i++) if (a->tabs[i].used) {
      if (re_inside(a->tabs[i].header, e->button.x, e->button.y)) { a->drag_tab = i; a->drag_x = e->button.x; a->drag_y = e->button.y; }
      if (re_inside(a->tabs[i].rect, e->button.x, e->button.y)) a->focus = i;
    }
  }
  if (e->type == SDL_MOUSEMOTION && a->resize_pane >= 0) {
    RePane *p = &a->layout.panes[a->resize_pane];
    float v = p->axis == 1 ? (float)(e->motion.x - p->rect.x) / re_max(1, p->rect.w) : (float)(e->motion.y - p->rect.y) / re_max(1, p->rect.h);
    p->ratio = v < 0.1f ? 0.1f : v > 0.9f ? 0.9f : v; re_app_layout_changed(a);
  }
  if (e->type == SDL_MOUSEBUTTONUP && e->button.button == SDL_BUTTON_LEFT) {
    if (a->drag_tab >= 0 && abs(e->button.x - a->drag_x) + abs(e->button.y - a->drag_y) > 8) {
      int pane = re_layout_hit(&a->layout, e->button.x, e->button.y, false);
      if (pane >= 0) {
        RePane *target = &a->layout.panes[pane]; int index = target->count;
        if (e->button.y < target->rect.y + RE_METRIC_PANE_HEADER_HEIGHT) {
          for (int i = 0; i < target->count; i++) {
            mu_Rect r = a->tabs[target->tabs[i]].header; if (r.w <= 0) continue;
            index = i; if (e->button.x < r.x + r.w / 2) break; index = i + 1;
          }
        }
        if (re_layout_find(&a->layout, a->drag_tab) == pane)
          for (int i = 0; i < target->count; i++) if (target->tabs[i] == a->drag_tab) { if (i < index) index--; break; }
        re_layout_move(&a->layout, a->drag_tab, pane, index); re_app_layout_changed(a);
      }
    }
    a->drag_tab = a->resize_pane = -1;
  }
  if (e->type == SDL_WINDOWEVENT && e->window.event == SDL_WINDOWEVENT_FOCUS_LOST) {
    for (int i = 0; i < RE_TABS; i++) if (a->tabs[i].terminal) re_terminal_release(a->tabs[i].terminal);
    if (a->focus >= 0) {
      ReTab *t = &a->tabs[a->focus];
      if (t->terminal) re_terminal_event(t->terminal, e);
      if (t->editor) re_editor_event(t->editor, e, t->rect, re_draw_cell_width(draw), re_draw_line_height(draw));
      else if (t->format) re_format_event(t->format, e, t->rect, re_draw_cell_width(draw), re_draw_line_height(draw));
    }
    a->focus = -1;
  }
  if (previous_focus >= 0 && previous_focus != a->focus && a->tabs[previous_focus].game) re_game_release(a->tabs[previous_focus].game);
  if (previous_focus >= 0 && previous_focus != a->focus && a->tabs[previous_focus].terminal) re_terminal_release(a->tabs[previous_focus].terminal);
  if (!a->quitting && a->drag_tab < 0 && a->resize_pane < 0 && (e->type == SDL_MOUSEMOTION || e->type == SDL_MOUSEBUTTONDOWN || e->type == SDL_MOUSEBUTTONUP)) {
    for (int pass = 0; pass < 2; pass++) for (int i = 0; i < RE_TABS; i++) {
      ReTab *t = &a->tabs[i];
      if (t->terminal && (pass == 0 ? re_terminal_mouse_held(t->terminal) : re_inside(t->rect, a->mouse_x, a->mouse_y))) {
        if (re_terminal_mouse(t->terminal, e, a->mouse_x, a->mouse_y)) return e->type != SDL_MOUSEMOTION;
      }
    }
  }
  if (a->focus < 0 || a->quitting) return false;
  ReTab *t = &a->tabs[a->focus];
  if (t->discarding) return true;
  if (e->type == SDL_KEYDOWN && e->key.keysym.sym == SDLK_s && (e->key.keysym.mod & (KMOD_CTRL | KMOD_GUI)) && t->editor) re_app_save(a, a->focus);
  else if (t->editor) {
    int before = re_editor_revision(t->editor);
    re_editor_event(t->editor, e, t->rect, re_draw_cell_width(draw), re_draw_line_height(draw));
    if (before != re_editor_revision(t->editor)) { t->edited = SDL_GetTicks64(); t->dirty = true; }
  } else if (t->format) re_format_event(t->format, e, t->rect, re_draw_cell_width(draw), re_draw_line_height(draw));
  else if (t->terminal) re_terminal_event(t->terminal, e);
  else if (t->game) re_game_event(t->game, e);
  return (t->editor || t->terminal || t->game || t->format) && (e->type == SDL_KEYDOWN || e->type == SDL_KEYUP || e->type == SDL_TEXTINPUT);
}
