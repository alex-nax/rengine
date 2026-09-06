#include "app.h"

static void inspect_rect(ReApp *a, const char *role, const char *key, int tab, mu_Rect r) {
  if (!a->controls || cJSON_GetArraySize(a->controls) >= 512) return;
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "role", role); cJSON_AddStringToObject(j, "key", key);
  cJSON_AddNumberToObject(j, "tab", tab); cJSON_AddItemToObject(j, "rect", cJSON_CreateIntArray((int[]){r.x, r.y, r.w, r.h}, 4));
  cJSON_AddItemToArray(a->controls, j);
}
static void inspect_control(ReApp *a, mu_Context *ui, const char *role, const char *key, int tab) {
  if (!a->controls) return;
  mu_Rect r = ui->last_rect, clip = mu_get_clip_rect(ui);
  int x = re_max(r.x, clip.x), y = re_max(r.y, clip.y);
  int right = re_min(r.x + r.w, clip.x + clip.w), bottom = re_min(r.y + r.h, clip.y + clip.h);
  if (right <= x || bottom <= y) return;
  inspect_rect(a, role, key, tab, mu_rect(x, y, right - x, bottom - y));
}
static int button(ReApp *a, mu_Context *ui, const char *label, const char *role, const char *key, int tab) {
  int result = mu_button(ui, label); inspect_control(a, ui, role, key, tab); return result;
}
static const char *root_name(ReApp *a, const char *id) {
  const cJSON *root = NULL;
  cJSON_ArrayForEach(root, cJSON_GetObjectItemCaseSensitive(a->state, "roots"))
    if (!strcmp(re_string(root, "id"), id)) return re_string(root, "name");
  return "Missing root";
}
static void launch_terminal(ReApp *a, bool agent, bool menu) {
  if (!*a->root) { re_copy(a->status, sizeof(a->status), "Add or select a project first."); return; }
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "rootId", a->root);
  if (agent) { cJSON_AddStringToObject(j, "type", "agent"); cJSON_AddStringToObject(j, "agent", a->agent); cJSON_AddStringToObject(j, "action", menu || !*a->agent ? "menu" : "launch"); }
  re_app_action(a, "terminal", j); cJSON_Delete(j);
}
static void tree_ui(ReApp *a, mu_Context *ui, int index) {
  ReTab *t = &a->tabs[index];
  mu_layout_row(ui, 2, (int[]){55, -1}, 24);
  if (mu_button(ui, "Up")) {
    char *slash = strrchr(t->path, '/'); if (slash) *slash = 0; else t->path[0] = 0;
    re_app_load(a, index); re_app_layout_changed(a);
  }
  mu_label(ui, *t->path ? t->path : root_name(a, t->root));
  if (!t->data) { mu_text(ui, *t->error ? t->error : "Loading files…"); return; }
  const cJSON *entry = NULL;
  cJSON_ArrayForEach(entry, cJSON_GetObjectItemCaseSensitive(t->data, "entries")) {
    mu_layout_row(ui, 1, (int[]){-1}, 24);
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
    mu_layout_row(ui, 3, (int[]){-155, 80, -1}, 26);
    char label[1024]; snprintf(label, sizeof(label), "%s · %s · %s · PID %d", re_string(session, "title"), root_name(a, root), re_string(session, "state"), re_number(session, "pid"));
    mu_label(ui, label);
    if (button(a, ui, "Attach", "attach", id, -1)) re_app_tab(a, !strcmp(re_string(session, "type"), "game") ? RE_GAME : RE_TERMINAL, root, "", id, re_string(session, "title"));
    if (button(a, ui, "Stop", "stop", id, -1)) { cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "id", id); re_app_action(a, "stop", j); cJSON_Delete(j); }
    mu_pop_id(ui);
  }
  mu_layout_row(ui, 1, (int[]){-1}, 24); mu_label(ui, "Recovery drafts");
  const cJSON *draft = NULL;
  cJSON_ArrayForEach(draft, cJSON_GetObjectItemCaseSensitive(a->state, "drafts")) {
    char label[2300]; snprintf(label, sizeof(label), "%s · %s", root_name(a, re_string(draft, "rootId")), re_string(draft, "path"));
    if (mu_button_ex(ui, label, 0, 0)) re_app_tab(a, RE_EDITOR, re_string(draft, "rootId"), re_string(draft, "path"), "", re_string(draft, "path"));
  }
}
static void pane_header(ReApp *a, mu_Context *ui, int n) {
  RePane *p = &a->layout.panes[n]; ReTabStrip *strip = &a->strips[n];
  if (!p->count) { mu_layout_row(ui, 1, (int[]){-1}, 24); mu_label(ui, "Empty pane · choose a view above"); return; }
  int available = re_max(0, p->rect.w - 10), nav = p->count * 158 > available ? re_min(24, available / 4) : 0;
  available -= 2 * nav;
  int slots = re_max(1, available / 158), cell = re_min(158, available), selected_tab = p->tabs[p->selected];
  strip->first = re_max(0, re_min(strip->first, p->count - slots));
  if (strip->width != p->rect.w || strip->count != p->count || strip->selected != p->selected || strip->tab != selected_tab) {
    if (p->selected < strip->first) strip->first = p->selected;
    if (p->selected >= strip->first + slots) strip->first = p->selected - slots + 1;
  }
  strip->width = p->rect.w; strip->count = p->count; strip->selected = p->selected; strip->tab = selected_tab;
  if (nav) {
    mu_layout_set_next(ui, mu_rect(p->rect.x + 5, p->rect.y + 4, re_max(0, nav - 2), 26), 0);
    if (button(a, ui, "<", "tab-scroll", "previous", n)) strip->first = re_max(0, strip->first - slots);
    mu_layout_set_next(ui, mu_rect(p->rect.x + p->rect.w - 5 - nav, p->rect.y + 4, re_max(0, nav - 2), 26), 0);
    if (button(a, ui, ">", "tab-scroll", "next", n)) strip->first = re_min(re_max(0, p->count - slots), strip->first + slots);
  }
  for (int i = strip->first; i < re_min(p->count, strip->first + slots); i++) {
    int tab = p->tabs[i]; ReTab *t = &a->tabs[tab]; char label[280];
    const char *end = t->title; int characters = 0;
    while (*end && characters++ < 11) re_utf8(&end);
    snprintf(label, sizeof(label), "%s%.*s%s%s", i == p->selected ? "• " : "", (int)(end - t->title), t->title, *end ? "…" : "", t->dirty ? " *" : "");
    int close_width = re_min(22, re_max(0, cell - 6));
    mu_Rect r = mu_rect(p->rect.x + 5 + nav + (i - strip->first) * cell, p->rect.y + 4, re_max(0, cell - close_width - 6), 26);
    t->header = r; mu_layout_set_next(ui, r, 0); mu_push_id(ui, &tab, sizeof(tab));
    if (button(a, ui, label, "tab", "", tab)) { p->selected = i; a->layout.active = n; a->focus = -1; re_app_layout_changed(a); }
    mu_layout_set_next(ui, mu_rect(r.x + r.w + 2, r.y, close_width, 26), 0);
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
  mu_get_container(ui, "Toolbar")->rect = mu_rect(0, 0, width, 78);
  if (mu_begin_window_ex(ui, "Toolbar", mu_rect(0, 0, width, 78), opts)) {
    mu_layout_row(ui, 11, (int[]){78, 75, 75, 75, 80, 95, 120, 125, 95, 85, -1}, 26);
    mu_label(ui, "rEngine");
    if (button(a, ui, "Tree", "toolbar", "Tree", -1)) { if (*a->root) re_app_tab(a, RE_TREE, a->root, "", "", "Project"); }
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
    if (button(a, ui, "NOLF", "toolbar", "NOLF", -1)) {
      cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "rootId", a->root); re_app_action(a, "game", j); cJSON_Delete(j);
    }
    int vim = a->vim;
    if (mu_checkbox(ui, "Vim", &vim)) {
      a->vim = vim != 0;
      for (int i = 0; i < RE_TABS; i++) if (a->tabs[i].editor) re_editor_vim(a->tabs[i].editor, a->vim);
      cJSON *j = cJSON_CreateObject(); cJSON_AddBoolToObject(j, "vim", a->vim); re_app_action(a, "preferences", j); cJSON_Delete(j);
    }
    mu_layout_row(ui, 5, (int[]){170, -475, 95, 70, -1}, 26);
    if (mu_button(ui, root_name(a, a->root))) {
      cJSON *roots = cJSON_GetObjectItemCaseSensitive(a->state, "roots"); int count = cJSON_GetArraySize(roots);
      for (int i = 0; i < count; i++) if (!strcmp(re_string(cJSON_GetArrayItem(roots, i), "id"), a->root)) {
        re_copy(a->root, sizeof(a->root), re_string(cJSON_GetArrayItem(roots, (i + 1) % count), "id")); break;
      }
    }
    mu_textbox(ui, a->project_input, sizeof(a->project_input));
    inspect_control(a, ui, "textbox", "project", -1);
    if (button(a, ui, "Add project", "toolbar", "Add project", -1)) { cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "path", a->project_input); re_app_action(a, "roots", j); cJSON_Delete(j); }
    mu_label(ui, "Agent CLI"); mu_textbox(ui, a->agent, sizeof(a->agent));
    mu_end_window(ui);
  }
  re_layout_measure(&a->layout, mu_rect(0, 80, width, height - 106));
  for (int i = 0; i < RE_TABS; i++) { a->tabs[i].rect = mu_rect(0, 0, 0, 0); a->tabs[i].header = mu_rect(0, 0, 0, 0); }
  for (int n = 0; n < RE_PANES; n++) {
    RePane *p = &a->layout.panes[n]; if (!p->used || p->axis) continue;
    char title[40]; snprintf(title, sizeof(title), "Pane header %d", n); mu_Rect header = p->rect; header.h = 34;
    mu_get_container(ui, title)->rect = header;
    if (mu_begin_window_ex(ui, title, header, opts)) {
      pane_header(a, ui, n);
      mu_end_window(ui);
    }
    snprintf(title, sizeof(title), "Pane content %d", n);
    mu_Rect content = mu_rect(p->rect.x, p->rect.y + 35, p->rect.w, re_max(0, p->rect.h - 35));
    mu_get_container(ui, title)->rect = content;
    if (!p->count) continue;
    int index = p->tabs[p->selected]; ReTab *t = &a->tabs[index];
    int content_opts = t->type == RE_TREE || t->type == RE_SESSIONS ? opts & ~MU_OPT_NOSCROLL : opts;
    if (mu_begin_window_ex(ui, title, content, content_opts)) {
      mu_layout_row(ui, 1, (int[]){-1}, 22); mu_label(ui, root_name(a, t->root));
      if (t->type == RE_TREE) tree_ui(a, ui, index);
      else if (t->type == RE_SESSIONS) sessions_ui(a, ui);
      else if (t->type == RE_EDITOR) {
        mu_layout_row(ui, 4, (int[]){65, 80, 130, -1}, 26);
        if (button(a, ui, "Save", "save", "", index)) re_app_save(a, index);
        if (button(a, ui, "Discard", "discard", "", index)) re_app_discard(a, index);
        mu_label(ui, t->editor ? re_editor_mode(t->editor) : "Loading…");
        mu_label(ui, t->conflict ? "Conflict: draft preserved" : t->dirty ? "Unsaved · local draft" : "Saved");
        t->rect = mu_rect(content.x + 6, content.y + 59, re_max(0, content.w - 12), re_max(0, content.h - 85));
        if (*t->error) {
          mu_layout_set_next(ui, mu_rect(content.x + 6, content.y + content.h - 25, content.w - 12, 23), 0); mu_label(ui, t->error);
        }
      } else if (t->type == RE_TERMINAL) {
        t->rect = mu_rect(content.x + 6, content.y + 28, re_max(0, content.w - 12), re_max(0, content.h - 34));
      } else if (t->game) {
        mu_layout_row(ui, 2, (int[]){210, -1}, 26);
        if (mu_button(ui, t->game->captured ? "Captured · Esc releases" : "Capture mouse")) { re_game_capture(t->game); a->focus = index; }
        mu_label(ui, t->game->status);
        t->rect = mu_rect(content.x + 6, content.y + 59, re_max(0, content.w - 12), re_max(0, content.h - 65));
      }
      mu_end_window(ui);
      if (a->controls && (t->type == RE_TREE || t->type == RE_SESSIONS)) {
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
    if (t->rect.w <= 0 || t->rect.h <= 0) continue;
    if (t->terminal) re_terminal_draw(t->terminal, draw, t->rect, a->focus == i);
    if (t->editor) re_editor_draw(t->editor, draw, t->rect, a->focus == i);
    if (t->game) re_game_draw(t->game, draw, t->rect);
  }
  for (int n = 0; n < RE_PANES; n++) if (a->layout.panes[n].used && a->layout.panes[n].axis)
    re_draw_rect(draw, a->layout.panes[n].divider, RE_COLOR_DIVIDER);
}
bool re_app_event(ReApp *a, const SDL_Event *e, ReDraw *draw) {
  if (e->type == SDL_MOUSEMOTION) { a->mouse_x = e->motion.x; a->mouse_y = e->motion.y; }
  if (e->type == SDL_MOUSEBUTTONDOWN || e->type == SDL_MOUSEBUTTONUP) { a->mouse_x = e->button.x; a->mouse_y = e->button.y; }
  if (e->type == SDL_MOUSEWHEEL && !a->quitting) {
    for (int i = 0; i < RE_TABS; i++) if ((a->tabs[i].terminal || a->tabs[i].editor) && re_inside(a->tabs[i].rect, a->mouse_x, a->mouse_y)) {
      ReTab *t = &a->tabs[i];
      if (t->terminal) re_terminal_event(t->terminal, e);
      else re_editor_event(t->editor, e, t->rect, re_draw_cell_width(draw), re_draw_line_height(draw));
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
        if (e->button.y < target->rect.y + 34) {
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
    if (a->focus >= 0) {
      ReTab *t = &a->tabs[a->focus];
      if (t->terminal) re_terminal_event(t->terminal, e);
      if (t->editor) re_editor_event(t->editor, e, t->rect, re_draw_cell_width(draw), re_draw_line_height(draw));
    }
    a->focus = -1;
  }
  if (previous_focus >= 0 && previous_focus != a->focus && a->tabs[previous_focus].game) re_game_release(a->tabs[previous_focus].game);
  if (a->focus < 0 || a->quitting) return false;
  ReTab *t = &a->tabs[a->focus];
  if (t->discarding) return true;
  if (e->type == SDL_KEYDOWN && e->key.keysym.sym == SDLK_s && (e->key.keysym.mod & (KMOD_CTRL | KMOD_GUI)) && t->editor) re_app_save(a, a->focus);
  else if (t->editor) {
    int before = re_editor_revision(t->editor);
    re_editor_event(t->editor, e, t->rect, re_draw_cell_width(draw), re_draw_line_height(draw));
    if (before != re_editor_revision(t->editor)) { t->edited = SDL_GetTicks64(); t->dirty = true; }
  } else if (t->terminal) re_terminal_event(t->terminal, e);
  else if (t->game) re_game_event(t->game, e);
  return (t->editor || t->terminal || t->game) && (e->type == SDL_KEYDOWN || e->type == SDL_KEYUP || e->type == SDL_TEXTINPUT);
}
