#include "app.h"
#include "scene.h"

static void inspect_rect(ReApp *a, const char *role, const char *key, int tab, mu_Rect r) {
  if (!a->controls || cJSON_GetArraySize(a->controls) >= 512) return;
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "role", role); cJSON_AddStringToObject(j, "key", key);
  cJSON_AddNumberToObject(j, "tab", tab); cJSON_AddItemToObject(j, "rect", cJSON_CreateIntArray((int[]){r.x, r.y, r.w, r.h}, 4));
  cJSON_AddItemToArray(a->controls, j);
}
void re_app_control(ReApp *a, mu_Context *ui, const char *role, const char *key, int tab) {
  if (!a->controls) return;
  mu_Rect r = ui->last_rect, clip = mu_get_clip_rect(ui);
  int x = re_max(r.x, clip.x), y = re_max(r.y, clip.y);
  int right = re_min(r.x + r.w, clip.x + clip.w), bottom = re_min(r.y + r.h, clip.y + clip.h);
  if (right <= x || bottom <= y) return;
  inspect_rect(a, role, key, tab, mu_rect(x, y, right - x, bottom - y));
}
static int button(ReApp *a, mu_Context *ui, const char *label, const char *role, const char *key, int tab) {
  int result = mu_button(ui, label); re_app_control(a, ui, role, key, tab); return result;
}
static const char *root_name(ReApp *a, const char *id) {
  const cJSON *root = NULL;
  cJSON_ArrayForEach(root, cJSON_GetObjectItemCaseSensitive(a->state, "roots"))
    if (!strcmp(re_string(root, "id"), id)) return re_string(root, "name");
  return "Missing root";
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
static void tree_ui(ReApp *a, mu_Context *ui, int index) {
  ReTab *t = &a->tabs[index];
  mu_layout_row(ui, 2, (int[]){RE_METRIC_TREE_UP_WIDTH, -1}, RE_METRIC_TREE_ROW_HEIGHT);
  if (mu_button(ui, "Up")) {
    char *slash = strrchr(t->path, '/'); if (slash) *slash = 0; else t->path[0] = 0;
    re_app_load(a, index); re_app_layout_changed(a);
  }
  mu_label(ui, *t->path ? t->path : root_name(a, t->root));
  if (!t->data) { mu_text(ui, *t->error ? t->error : "Loading files…"); return; }
  const cJSON *entry = NULL;
  cJSON_ArrayForEach(entry, cJSON_GetObjectItemCaseSensitive(t->data, "entries")) {
    mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_TREE_ROW_HEIGHT);
    const char *name = re_string(entry, "name"), *path = re_string(entry, "path");
    bool directory = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(entry, "directory"));
    char label[1024]; snprintf(label, sizeof(label), "%s %s", directory ? ">" : " ", name);
    if (button(a, ui, label, "tree-entry", path, index)) {
      if (strlen(path) >= sizeof(t->path)) { re_copy(t->error, sizeof(t->error), "File path exceeds the view limit."); continue; }
      if (directory) { re_copy(t->path, sizeof(t->path), path); re_app_load(a, index); re_app_layout_changed(a); }
      else re_app_tab(a, RE_EDITOR, t->root, path, "", name);
    }
  }
  if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(t->data, "truncated"))) mu_text(ui, "Showing the first 2,000 directory entries.");
}
static void sessions_ui(ReApp *a, mu_Context *ui) {
  const cJSON *session = NULL;
  cJSON_ArrayForEach(session, cJSON_GetObjectItemCaseSensitive(a->state, "sessions")) {
    const char *id = re_string(session, "id"), *root = re_string(session, "rootId");
    mu_push_id(ui, id, (int)strlen(id));
    mu_layout_row(ui, 3, (int[]){-RE_METRIC_SESSIONS_ACTIONS_WIDTH, RE_METRIC_SESSIONS_ATTACH_WIDTH, -1}, RE_METRIC_SESSIONS_ROW_HEIGHT);
    char label[1024]; snprintf(label, sizeof(label), "%s · %s · %s · PID %d", re_string(session, "title"), root_name(a, root), re_string(session, "state"), re_number(session, "pid"));
    mu_label(ui, label);
    if (button(a, ui, "Attach", "attach", id, -1)) re_app_tab(a, !strcmp(re_string(session, "type"), "game") ? RE_GAME : RE_TERMINAL, root, "", id, re_string(session, "title"));
    if (button(a, ui, "Stop", "stop", id, -1)) { cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "id", id); re_app_action(a, "stop", j); cJSON_Delete(j); }
    mu_pop_id(ui);
  }
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_SESSIONS_HEADING_HEIGHT); mu_label(ui, "Recovery drafts");
  const cJSON *draft = NULL;
  cJSON_ArrayForEach(draft, cJSON_GetObjectItemCaseSensitive(a->state, "drafts")) {
    char label[2300]; snprintf(label, sizeof(label), "%s · %s", root_name(a, re_string(draft, "rootId")), re_string(draft, "path"));
    if (mu_button_ex(ui, label, 0, 0)) re_app_tab(a, RE_EDITOR, re_string(draft, "rootId"), re_string(draft, "path"), "", re_string(draft, "path"));
  }
}
static void editor_ui(ReApp *a, mu_Context *ui, int index, mu_Rect content, mu_Rect below) {
  ReTab *t = &a->tabs[index]; int mode = t->format ? re_format_mode(t->format) : RE_MODE_TEXT, action = RE_FORMAT_NONE, top = RE_METRIC_EDITOR_TOP;
  if (t->format && mode != RE_MODE_PENDING) { action = re_format_ui(t->format, a, ui, re_app_format_record(a, t), index, t->error); top += RE_METRIC_FORMAT_ROW_ADVANCE; }
  if (mode == RE_MODE_TEXT || mode == RE_MODE_PENDING) {
    mu_layout_row(ui, 4, (int[]){RE_METRIC_EDITOR_SAVE_WIDTH, RE_METRIC_EDITOR_DISCARD_WIDTH, RE_METRIC_EDITOR_MODE_WIDTH, -1}, RE_METRIC_EDITOR_TOOLBAR_HEIGHT);
    if (button(a, ui, "Save", "save", "", index)) re_app_save(a, index);
    if (button(a, ui, "Discard", "discard", "", index)) re_app_discard(a, index);
    mu_label(ui, t->editor ? re_editor_mode(t->editor) : "Loading…");
    mu_label(ui, t->conflict ? "Conflict: draft preserved" : t->dirty ? "Unsaved · local draft" : "Saved");
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
  if (!p->count) { mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_PANE_EMPTY_ROW_HEIGHT); mu_label(ui, "Empty pane · choose a view above"); return; }
  int available = re_max(0, p->rect.w - 2 * RE_METRIC_TAB_INSET), nav = p->count * RE_METRIC_TAB_WIDTH > available ? re_min(RE_METRIC_TAB_NAV_WIDTH, available / 4) : 0;
  available -= 2 * nav;
  int slots = re_max(1, available / RE_METRIC_TAB_WIDTH), cell = re_min(RE_METRIC_TAB_WIDTH, available), selected_tab = p->tabs[p->selected];
  strip->first = re_max(0, re_min(strip->first, p->count - slots));
  if (strip->width != p->rect.w || strip->count != p->count || strip->selected != p->selected || strip->tab != selected_tab) {
    if (p->selected < strip->first) strip->first = p->selected;
    if (p->selected >= strip->first + slots) strip->first = p->selected - slots + 1;
  }
  strip->width = p->rect.w; strip->count = p->count; strip->selected = p->selected; strip->tab = selected_tab;
  if (nav) {
    mu_layout_set_next(ui, mu_rect(p->rect.x + RE_METRIC_TAB_INSET, p->rect.y + RE_METRIC_TAB_TOP, re_max(0, nav - RE_METRIC_TAB_GAP), RE_METRIC_TAB_HEIGHT), 0);
    if (button(a, ui, "<", "tab-scroll", "previous", n)) strip->first = re_max(0, strip->first - slots);
    mu_layout_set_next(ui, mu_rect(p->rect.x + p->rect.w - RE_METRIC_TAB_INSET - nav, p->rect.y + RE_METRIC_TAB_TOP, re_max(0, nav - RE_METRIC_TAB_GAP), RE_METRIC_TAB_HEIGHT), 0);
    if (button(a, ui, ">", "tab-scroll", "next", n)) strip->first = re_min(re_max(0, p->count - slots), strip->first + slots);
  }
  for (int i = strip->first; i < re_min(p->count, strip->first + slots); i++) {
    int tab = p->tabs[i]; ReTab *t = &a->tabs[tab]; char label[280];
    const char *end = t->title; int characters = 0;
    while (*end && characters++ < RE_METRIC_TAB_TITLE_CHARACTERS) re_utf8(&end);
    snprintf(label, sizeof(label), "%s%.*s%s%s", i == p->selected ? "• " : "", (int)(end - t->title), t->title, *end ? "…" : "", t->dirty ? " *" : "");
    int close_width = re_min(RE_METRIC_TAB_CLOSE_WIDTH, re_max(0, cell - RE_METRIC_TAB_GAP - RE_METRIC_MICROUI_SPACING));
    mu_Rect r = mu_rect(p->rect.x + RE_METRIC_TAB_INSET + nav + (i - strip->first) * cell, p->rect.y + RE_METRIC_TAB_TOP, re_max(0, cell - close_width - RE_METRIC_TAB_GAP - RE_METRIC_MICROUI_SPACING), RE_METRIC_TAB_HEIGHT);
    t->header = r; mu_layout_set_next(ui, r, 0); mu_push_id(ui, &tab, sizeof(tab));
    if (button(a, ui, label, "tab", "", tab)) { p->selected = i; a->layout.active = n; a->focus = -1; re_app_layout_changed(a); }
    mu_layout_set_next(ui, mu_rect(r.x + r.w + RE_METRIC_TAB_GAP, r.y, close_width, RE_METRIC_TAB_HEIGHT), 0);
    bool closed = button(a, ui, "x", "detach", "", tab);
    if (closed) {
      re_layout_remove(&a->layout, tab); a->focus = -1;
      re_terminal_close(t->terminal); t->terminal = NULL; re_game_close(t->game); t->game = NULL;
      t->header = mu_rect(0, 0, 0, 0); re_app_layout_changed(a);
    }
    mu_pop_id(ui); if (closed) break;
  }
}
void re_app_ui(ReApp *a, mu_Context *ui, int width, int height) {
  if (a->controls) { cJSON_Delete(a->controls); a->controls = cJSON_CreateArray(); }
  int opts = MU_OPT_NOTITLE | MU_OPT_NORESIZE | MU_OPT_NOCLOSE | MU_OPT_NOSCROLL;
  mu_get_container(ui, "Toolbar")->rect = mu_rect(0, 0, width, RE_METRIC_TOOLBAR_HEIGHT);
  if (mu_begin_window_ex(ui, "Toolbar", mu_rect(0, 0, width, RE_METRIC_TOOLBAR_HEIGHT), opts)) {
    const cJSON *game = re_app_game(a, a->root); /* the game column exists only while the bound root declares a game */
    int widths[] = {RE_METRIC_TOOLBAR_BRAND_WIDTH, RE_METRIC_TOOLBAR_VIEW_WIDTH, RE_METRIC_TOOLBAR_DASHBOARD_WIDTH, RE_METRIC_TOOLBAR_VIEW_WIDTH, RE_METRIC_TOOLBAR_VIEW_WIDTH,
      RE_METRIC_TOOLBAR_MANAGE_WIDTH, RE_METRIC_TOOLBAR_SESSIONS_WIDTH, RE_METRIC_TOOLBAR_SPLIT_VERTICAL_WIDTH, RE_METRIC_TOOLBAR_SPLIT_HORIZONTAL_WIDTH,
      RE_METRIC_TOOLBAR_MERGE_WIDTH, RE_METRIC_TOOLBAR_GAME_WIDTH, -1};
    int columns = RE_ARRAY_SIZE(widths);
    if (!game) { widths[columns - 2] = -1; columns--; }
    mu_layout_row(ui, columns, widths, RE_METRIC_TOOLBAR_ROW_HEIGHT);
    mu_label(ui, "rEngine");
    if (button(a, ui, "Tree", "toolbar", "Tree", -1)) { if (*a->root) re_app_tab(a, RE_TREE, a->root, "", "", "Project"); }
    if (button(a, ui, "Dashboard", "toolbar", "Dashboard", -1)) { if (re_app_dashboard(a, a->root) < 0) re_copy(a->status, sizeof(a->status), "Add or select a project first."); }
    if (button(a, ui, "Shell", "toolbar", "Shell", -1)) launch_terminal(a, false, false);
    if (button(a, ui, "Agent", "toolbar", "Agent", -1)) launch_terminal(a, true, false);
    if (button(a, ui, "Manage", "toolbar", "Manage", -1)) launch_terminal(a, true, true);
    if (button(a, ui, "Sessions", "toolbar", "Sessions", -1)) re_app_tab(a, RE_SESSIONS, "", "", "", "Sessions");
    if (button(a, ui, "Split vertical", "toolbar", "Split vertical", -1)) { re_layout_split(&a->layout, a->layout.active, 1); re_app_layout_changed(a); }
    if (button(a, ui, "Split horizontal", "toolbar", "Split horizontal", -1)) { re_layout_split(&a->layout, a->layout.active, 2); re_app_layout_changed(a); }
    if (button(a, ui, "Merge pane", "toolbar", "Merge pane", -1)) {
      if (re_layout_collapse(&a->layout, a->layout.active) >= 0) { a->focus = -1; re_app_layout_changed(a); }
      else re_copy(a->status, sizeof(a->status), "This is already the only pane.");
    }
    if (game && button(a, ui, re_string(game, "title"), "toolbar", re_string(game, "title"), -1)) {
      cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "rootId", a->root); re_app_action(a, "game", j); cJSON_Delete(j);
    }
    int vim = a->vim;
    if (mu_checkbox(ui, "Vim", &vim)) {
      a->vim = vim != 0;
      for (int i = 0; i < RE_TABS; i++) if (a->tabs[i].editor) re_editor_vim(a->tabs[i].editor, a->vim);
      cJSON *j = cJSON_CreateObject(); cJSON_AddBoolToObject(j, "vim", a->vim); re_app_action(a, "preferences", j); cJSON_Delete(j);
    }
    mu_layout_row(ui, 5, (int[]){RE_METRIC_TOOLBAR_ROOT_WIDTH, -RE_METRIC_TOOLBAR_PATH_RIGHT, RE_METRIC_TOOLBAR_ADD_WIDTH, RE_METRIC_TOOLBAR_AGENT_LABEL_WIDTH, -1}, RE_METRIC_TOOLBAR_ROW_HEIGHT);
    bool cycle = mu_button(ui, root_name(a, a->root)); re_app_control(a, ui, "toolbar", "Root", -1);
    if (cycle) {
      cJSON *roots = cJSON_GetObjectItemCaseSensitive(a->state, "roots"); int count = cJSON_GetArraySize(roots);
      for (int i = 0; i < count; i++) if (!strcmp(re_string(cJSON_GetArrayItem(roots, i), "id"), a->root)) {
        re_copy(a->root, sizeof(a->root), re_string(cJSON_GetArrayItem(roots, (i + 1) % count), "id")); break;
      }
    }
    mu_textbox(ui, a->project_input, sizeof(a->project_input));
    re_app_control(a, ui, "textbox", "project", -1);
    if (button(a, ui, "Add project", "toolbar", "Add project", -1)) { cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "path", a->project_input); re_app_action(a, "roots", j); cJSON_Delete(j); }
    mu_label(ui, "Agent CLI"); mu_textbox(ui, a->agent, sizeof(a->agent));
    mu_end_window(ui);
  }
  re_layout_measure(&a->layout, mu_rect(0, RE_METRIC_WORKSPACE_TOP, width, height - RE_METRIC_WORKSPACE_TOP - RE_METRIC_WORKSPACE_STATUS_HEIGHT));
  for (int i = 0; i < RE_TABS; i++) { a->tabs[i].rect = mu_rect(0, 0, 0, 0); a->tabs[i].header = mu_rect(0, 0, 0, 0); }
  for (int n = 0; n < RE_PANES; n++) {
    RePane *p = &a->layout.panes[n]; if (!p->used || p->axis) continue;
    char title[40]; snprintf(title, sizeof(title), "Pane header %d", n); mu_Rect header = p->rect; header.h = RE_METRIC_PANE_HEADER_HEIGHT;
    mu_get_container(ui, title)->rect = header;
    if (mu_begin_window_ex(ui, title, header, opts)) {
      pane_header(a, ui, n);
      mu_end_window(ui);
    }
    snprintf(title, sizeof(title), "Pane content %d", n);
    mu_Rect content = mu_rect(p->rect.x, p->rect.y + RE_METRIC_PANE_CONTENT_TOP, p->rect.w, re_max(0, p->rect.h - RE_METRIC_PANE_CONTENT_TOP)), below = mu_rect(0, 0, 0, 0);
    if (!p->count) { mu_get_container(ui, title)->rect = content; continue; }
    int index = p->tabs[p->selected]; ReTab *t = &a->tabs[index];
    bool format_view = t->type == RE_EDITOR && t->format && re_format_scrolls(t->format);
    int content_opts = t->type == RE_TREE || t->type == RE_SESSIONS || t->type == RE_DASHBOARD || format_view ? opts & ~MU_OPT_NOSCROLL : opts;
    if (format_view && re_format_split(t->format)) {
      int h = content.h * RE_METRIC_FORMAT_ENTRY_PERCENT / 100;
      below = mu_rect(content.x + RE_METRIC_EDITOR_INSET, content.y + content.h - h, re_max(0, content.w - 2 * RE_METRIC_EDITOR_INSET), re_max(0, h - RE_METRIC_EDITOR_INSET)); content.h -= h;
    }
    mu_get_container(ui, title)->rect = content;
    if (mu_begin_window_ex(ui, title, content, content_opts)) {
      mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_PANE_ROOT_ROW_HEIGHT); mu_label(ui, root_name(a, t->root));
      if (t->type == RE_TREE) tree_ui(a, ui, index);
      else if (t->type == RE_SESSIONS) sessions_ui(a, ui);
      else if (t->type == RE_DASHBOARD) re_dashboard_ui(a, ui, index);
      else if (t->type == RE_EDITOR) editor_ui(a, ui, index, content, below);
      else if (t->type == RE_TERMINAL) {
        t->rect = mu_rect(content.x + RE_METRIC_TERMINAL_INSET, content.y + RE_METRIC_TERMINAL_TOP, re_max(0, content.w - 2 * RE_METRIC_TERMINAL_INSET), re_max(0, content.h - RE_METRIC_TERMINAL_BOTTOM));
      } else if (t->type == RE_GAME && t->terminal) {
        bool running = session_running(a, t->session);
        mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_GAME_ROW_HEIGHT);
        mu_label(ui, running ? "Running in its own window" : "Game exited · reattach or Stop in Sessions"); re_app_control(a, ui, "game-status", running ? "running" : "exited", index);
        t->rect = mu_rect(content.x + RE_METRIC_GAME_INSET, content.y + RE_METRIC_GAME_TOP, re_max(0, content.w - 2 * RE_METRIC_GAME_INSET), re_max(0, content.h - RE_METRIC_GAME_BOTTOM));
      } else if (t->game) {
        mu_layout_row(ui, 2, (int[]){RE_METRIC_GAME_CAPTURE_WIDTH, -1}, RE_METRIC_GAME_ROW_HEIGHT);
        if (mu_button(ui, t->game->captured ? "Captured · Esc releases" : "Capture mouse")) { re_game_capture(t->game); a->focus = index; }
        mu_label(ui, t->game->status);
        t->rect = mu_rect(content.x + RE_METRIC_GAME_INSET, content.y + RE_METRIC_GAME_TOP, re_max(0, content.w - 2 * RE_METRIC_GAME_INSET), re_max(0, content.h - RE_METRIC_GAME_BOTTOM));
      }
      mu_end_window(ui);
      if (a->controls && (t->type == RE_TREE || t->type == RE_SESSIONS || t->type == RE_DASHBOARD || format_view)) {
        mu_Container *container = mu_get_container(ui, title);
        if (container->content_size.y + ui->style->padding * 2 > container->body.h) {
          inspect_rect(a, "scrollbar", "y", index, mu_rect(container->body.x + container->body.w, container->body.y, ui->style->scrollbar_size, container->body.h));
        }
      }
    }
  }
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
