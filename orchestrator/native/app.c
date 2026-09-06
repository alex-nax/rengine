#include "app.h"

enum { OP_STATE = 1, OP_LOAD, OP_SAVE, OP_DRAFT, OP_DISCARD, OP_CREATE, OP_ROOT, OP_GENERIC, OP_LAYOUT };
static int request(ReApp *a, int operation, int tab, const char *route, const cJSON *body) {
  for (int i = 0; i < RE_ARRAY_SIZE(a->pending); i++) if (!a->pending[i].id) {
    int id = re_net_request(a->net, route, body);
    if (!id) break;
    a->pending[i] = (RePending){id, operation, tab, tab >= 0 ? a->tabs[tab].generation : 0,
      tab >= 0 && a->tabs[tab].editor ? re_editor_revision(a->tabs[tab].editor) : 0};
    return id;
  }
  re_copy(a->status, sizeof(a->status), "Workspace request queue is full; retry when pending work completes."); return 0;
}
static cJSON *file_body(ReTab *t, bool draft) {
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "rootId", t->root); cJSON_AddStringToObject(j, "path", t->path);
  char *text = re_editor_text(t->editor); cJSON_AddStringToObject(j, "text", text ? text : ""); free(text);
  cJSON_AddStringToObject(j, draft ? "baseVersion" : "version", t->version); return j;
}
void re_app_layout_changed(ReApp *a) {
  a->desktop_registered = false;
  a->layout_dirty = true; a->layout_changed = SDL_GetTicks64();
  for (int n = 0; n < RE_PANES; n++) a->strips[n].width = -1;
}
static void checkpoint(ReApp *a, int tab) {
  ReTab *t = &a->tabs[tab];
  if (!t->editor || t->discarding || !t->dirty || t->checkpoint_flight || t->checkpoint == re_editor_revision(t->editor)) return;
  for (int i = 0; i < RE_ARRAY_SIZE(a->pending); i++) if (a->pending[i].id && a->pending[i].tab == tab && a->pending[i].operation == OP_SAVE) return;
  cJSON *body = file_body(t, true); t->checkpoint_flight = request(a, OP_DRAFT, tab, "draft", body); cJSON_Delete(body);
}
void re_app_save(ReApp *a, int tab) {
  ReTab *t = &a->tabs[tab]; if (!t->editor) return;
  for (int i = 0; i < RE_ARRAY_SIZE(a->pending); i++) if (a->pending[i].id && a->pending[i].tab == tab && a->pending[i].operation == OP_SAVE) return;
  checkpoint(a, tab); cJSON *body = file_body(t, false); request(a, OP_SAVE, tab, "save", body); cJSON_Delete(body);
}
void re_app_discard(ReApp *a, int tab) {
  ReTab *t = &a->tabs[tab];
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "rootId", t->root); cJSON_AddStringToObject(j, "path", t->path);
  t->discarding = request(a, OP_DISCARD, tab, "discard", j) != 0; cJSON_Delete(j);
}
void re_app_load(ReApp *a, int tab) {
  ReTab *t = &a->tabs[tab];
  if (t->type != RE_TREE && t->type != RE_EDITOR) return;
  char *route = re_net_query(t->type == RE_TREE ? "tree" : "file", t->root, t->path);
  if (route) request(a, OP_LOAD, tab, route, NULL); free(route);
}
void re_app_action(ReApp *a, const char *route, const cJSON *body) {
  int operation = !strcmp(route, "terminal") || !strcmp(route, "game") ? OP_CREATE : !strcmp(route, "roots") ? OP_ROOT : OP_GENERIC;
  request(a, operation, -1, route, body);
}
int re_app_tab(ReApp *a, int type, const char *root, const char *path, const char *session, const char *title) {
  if (strlen(root) >= sizeof(a->tabs[0].root) || strlen(path) >= sizeof(a->tabs[0].path) || strlen(session) >= sizeof(a->tabs[0].session)) {
    re_copy(a->status, sizeof(a->status), "View identity exceeds the supported length."); return -1;
  }
  for (int i = 0; i < RE_TABS; i++) {
    ReTab *t = &a->tabs[i];
    if (t->used && t->type == type && !strcmp(t->root, root) && !strcmp(t->path, path) && !strcmp(t->session, session)) {
      if (type == RE_TERMINAL && !t->terminal) t->terminal = re_terminal_open(a->events, session, 80, 24);
      if (type == RE_GAME && !t->game) t->game = re_game_open(a->net, session);
      int pane = re_layout_find(&a->layout, i);
      if (pane < 0) re_layout_add(&a->layout, a->layout.active, i);
      else { a->layout.active = pane; for (int k = 0; k < a->layout.panes[pane].count; k++) if (a->layout.panes[pane].tabs[k] == i) a->layout.panes[pane].selected = k; }
      a->focus = i; re_app_layout_changed(a); return i;
    }
  }
  for (int i = 0; i < RE_TABS; i++) if (!a->tabs[i].used) {
    ReTab *t = &a->tabs[i]; t->used = true; t->generation++; t->type = type;
    re_copy(t->root, sizeof(t->root), root); re_copy(t->path, sizeof(t->path), path);
    re_copy(t->session, sizeof(t->session), session); re_copy(t->title, sizeof(t->title), title);
    re_layout_add(&a->layout, a->layout.active, i); a->focus = i;
    if (type == RE_TERMINAL) t->terminal = re_terminal_open(a->events, session, 80, 24);
    if (type == RE_GAME) t->game = re_game_open(a->net, session);
    re_app_load(a, i); re_app_layout_changed(a); return i;
  }
  re_copy(a->status, sizeof(a->status), "The workspace supports 64 retained views in this build."); return -1;
}
static void session_tab(ReApp *a, const cJSON *session) {
  re_app_tab(a, !strcmp(re_string(session, "type"), "game") ? RE_GAME : RE_TERMINAL,
    re_string(session, "rootId"), "", re_string(session, "id"), re_string(session, "title"));
}
static void update_session(ReApp *a, const cJSON *session) {
  if (!a->state || !*re_string(session, "id")) return;
  cJSON *sessions = cJSON_GetObjectItemCaseSensitive(a->state, "sessions"), *s = NULL; int index = 0;
  cJSON_ArrayForEach(s, sessions) {
    if (!strcmp(re_string(s, "id"), re_string(session, "id"))) { cJSON_ReplaceItemInArray(sessions, index, cJSON_Duplicate(session, 1)); return; } index++;
  }
  cJSON_AddItemToArray(sessions, cJSON_Duplicate(session, 1));
}
static cJSON *serialize(ReApp *a) {
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "client", "microui");
  cJSON_AddItemToObject(j, "layout", re_layout_json(&a->layout));
  if (a->previous_layout) cJSON_AddItemToObject(j, "previous", cJSON_Duplicate(a->previous_layout, 1));
  cJSON *tabs = cJSON_AddArrayToObject(j, "tabs");
  for (int i = 0; i < RE_TABS; i++) {
    ReTab *t = &a->tabs[i]; if (!t->used) { cJSON_AddItemToArray(tabs, cJSON_CreateNull()); continue; }
    cJSON *tab = cJSON_CreateObject(); cJSON_AddItemToArray(tabs, tab);
    cJSON_AddNumberToObject(tab, "type", t->type); cJSON_AddStringToObject(tab, "root", t->root);
    cJSON_AddStringToObject(tab, "path", t->path); cJSON_AddStringToObject(tab, "session", t->session); cJSON_AddStringToObject(tab, "title", t->title);
  }
  return j;
}
static bool restore(ReApp *a, const cJSON *j) {
  if (strcmp(re_string(j, "client"), "microui")) return false;
  ReLayout layout;
  if (!re_layout_restore(&layout, cJSON_GetObjectItemCaseSensitive(j, "layout"))) return false;
  const cJSON *tabs = cJSON_GetObjectItemCaseSensitive(j, "tabs");
  if (!cJSON_IsArray(tabs) || cJSON_GetArraySize(tabs) != RE_TABS) return false;
  for (int i = 0; i < RE_TABS; i++) {
    const cJSON *tab = cJSON_GetArrayItem(tabs, i);
    if (cJSON_IsNull(tab)) { if (re_layout_find(&layout, i) >= 0) return false; continue; }
    int type = re_number(tab, "type");
    if (type < RE_TREE || type > RE_GAME || strlen(re_string(tab, "root")) > 64 ||
        strlen(re_string(tab, "session")) > 64 || strlen(re_string(tab, "path")) > 2047) return false;
  }
  a->layout = layout;
  for (int i = 0; i < RE_TABS; i++) {
    const cJSON *tab = cJSON_GetArrayItem(tabs, i); if (cJSON_IsNull(tab)) continue;
    ReTab *t = &a->tabs[i]; t->used = true; t->generation++; t->type = re_number(tab, "type");
    re_copy(t->root, sizeof(t->root), re_string(tab, "root")); re_copy(t->path, sizeof(t->path), re_string(tab, "path"));
    re_copy(t->session, sizeof(t->session), re_string(tab, "session")); re_copy(t->title, sizeof(t->title), re_string(tab, "title"));
    if (t->type == RE_TERMINAL && re_layout_find(&a->layout, i) >= 0) t->terminal = re_terminal_open(a->events, t->session, 80, 24);
    if (t->type == RE_GAME && re_layout_find(&a->layout, i) >= 0) t->game = re_game_open(a->net, t->session);
    re_app_load(a, i);
  }
  a->previous_layout = cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(j, "previous"), 1); return true;
}
static void state_loaded(ReApp *a, const cJSON *j) {
  cJSON_Delete(a->state); a->state = cJSON_Duplicate(j, 1);
  if (a->initialized) return;
  a->initialized = true;
  const cJSON *preferences = cJSON_GetObjectItemCaseSensitive(j, "preferences");
  a->vim = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(preferences, "vim")); re_copy(a->agent, sizeof(a->agent), re_string(preferences, "agent"));
  if (!*a->root) re_copy(a->root, sizeof(a->root), re_string(cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(j, "roots"), 0), "id"));
  const cJSON *old = cJSON_GetObjectItemCaseSensitive(j, "layout");
  bool restored = restore(a, old);
  if (!restored) {
    a->previous_layout = cJSON_Duplicate(old, 1);
    if (*a->root) {
      int right = re_layout_split(&a->layout, 0, 1); a->layout.panes[0].ratio = 0.23f;
      a->layout.active = a->layout.panes[0].child[0]; re_app_tab(a, RE_TREE, a->root, "", "", "Project"); a->layout.active = right;
    }
  }
  const cJSON *sessions = cJSON_GetObjectItemCaseSensitive(j, "sessions"), *session;
  cJSON_ArrayForEach(session, sessions) {
    const char *id = re_string(session, "id");
    if ((!strcmp(id, a->initial_terminal) || !strcmp(id, a->initial_agent) || !strcmp(id, a->initial_game)) && !strcmp(re_string(session, "state"), "running")) session_tab(a, session);
  }
  if (getenv("RENGINE_RESUME_AGENT")) cJSON_ArrayForEach(session, sessions) {
    if (!strcmp(re_string(session, "id"), a->initial_agent) && !strcmp(re_string(session, "state"), "running")) session_tab(a, session);
  }
  re_copy(a->status, sizeof(a->status), "Workspace connected. Closing a view detaches; sessions stop explicitly.");
}
static void response(ReApp *a, ReMessage *m) {
  RePending p = {0};
  for (int i = 0; i < RE_ARRAY_SIZE(a->pending); i++) if (a->pending[i].id == m->id) { p = a->pending[i]; a->pending[i].id = 0; break; }
  if (!p.id || (p.tab >= 0 && p.generation != a->tabs[p.tab].generation)) return;
  ReTab *t = p.tab >= 0 ? &a->tabs[p.tab] : NULL;
  if (p.operation == OP_DRAFT && t) t->checkpoint_flight = 0;
  cJSON *j = cJSON_ParseWithLength(m->data, m->size);
  if (m->status != 200 || !j) {
    const char *error = j ? re_string(j, "error") : m->data;
    re_copy(a->status, sizeof(a->status), error);
    if (t) { t->discarding = false; re_copy(t->error, sizeof(t->error), error); if (m->status == 409) t->conflict = true; }
    if (a->quitting) a->quitting = false;
    cJSON_Delete(j); return;
  }
  switch (p.operation) {
    case OP_STATE: state_loaded(a, j); break;
    case OP_LOAD:
      t->discarding = false;
      cJSON_Delete(t->data); t->data = cJSON_Duplicate(j, 1); t->error[0] = 0;
      if (t->type == RE_EDITOR) {
        const cJSON *draft = cJSON_GetObjectItemCaseSensitive(j, "draft"); bool dirty = cJSON_IsObject(draft);
        ReEditor *editor = re_editor_open(re_string(dirty ? draft : j, "text"));
        if (!editor) { re_copy(t->error, sizeof(t->error), "Cannot allocate editor buffer."); break; }
        re_editor_close(t->editor); t->editor = editor; re_editor_vim(editor, a->vim);
        t->saved = dirty ? -1 : 0; t->dirty = dirty; t->checkpoint = 0; t->conflict = dirty && strcmp(re_string(draft, "baseVersion"), re_string(j, "version"));
        re_copy(t->version, sizeof(t->version), re_string(dirty ? draft : j, dirty ? "baseVersion" : "version"));
      }
      break;
    case OP_SAVE:
      re_copy(t->version, sizeof(t->version), re_string(j, "version")); t->saved = p.revision;
      t->dirty = t->editor && re_editor_revision(t->editor) != p.revision; t->conflict = false; t->error[0] = 0;
      if (t->dirty) t->checkpoint = -1; break;
    case OP_DRAFT: t->checkpoint = p.revision; t->error[0] = 0; break;
    case OP_DISCARD: t->dirty = false; re_app_load(a, p.tab); break;
    case OP_ROOT: re_copy(a->root, sizeof(a->root), re_string(j, "id")); request(a, OP_STATE, -1, "state", NULL); re_app_tab(a, RE_TREE, a->root, "", "", "Project"); break;
    case OP_CREATE: update_session(a, j); session_tab(a, j); break;
    case OP_GENERIC: if (*re_string(j, "id")) update_session(a, j); break;
  }
  cJSON_Delete(j);
}
ReApp *re_app_open(const char *url, const char *token) {
  ReApp *a = calloc(1, sizeof(*a)); if (!a) return NULL;
  re_layout_init(&a->layout); a->focus = a->drag_tab = a->resize_pane = -1;
  a->net = re_net_open(url, token);
  if (a->net) { a->events = re_socket_open(a->net, "events"); request(a, OP_STATE, -1, "state", NULL); }
  re_copy(a->root, sizeof(a->root), getenv("RENGINE_INITIAL_ROOT"));
  re_copy(a->initial_terminal, sizeof(a->initial_terminal), getenv("RENGINE_INITIAL_TERMINAL"));
  re_copy(a->initial_agent, sizeof(a->initial_agent), getenv("RENGINE_INITIAL_AGENT"));
  re_copy(a->initial_game, sizeof(a->initial_game), getenv("RENGINE_INITIAL_GAME"));
  re_copy(a->status, sizeof(a->status), a->net ? "Connecting to workspace…" : "No service connection. Launch with the workspace launcher or --connection FILE."); return a;
}
static void register_desktop(ReApp *a) {
  if (!a->initialized || !a->connected || a->desktop_registered) return;
  if (re_number(cJSON_GetObjectItemCaseSensitive(a->state, "capabilities"), "desktopActions") != 1) return;
  cJSON *j = cJSON_CreateObject(), *roots = cJSON_AddArrayToObject(j, "rootIds"), *sessions = cJSON_AddArrayToObject(j, "sessionIds");
  cJSON_AddStringToObject(j, "type", "desktop-register"); cJSON_AddBoolToObject(j, "canReload", getenv("RENGINE_CAN_RELOAD") != NULL);
  if (*a->root) cJSON_AddItemToArray(roots, cJSON_CreateString(a->root));
  for (int i = 0; i < RE_TABS; i++) if (a->tabs[i].used) {
    ReTab *t = &a->tabs[i];
    if (*t->root) cJSON_AddItemToArray(roots, cJSON_CreateString(t->root));
    if (*t->session) cJSON_AddItemToArray(sessions, cJSON_CreateString(t->session));
  }
  char *text = cJSON_PrintUnformatted(j); a->desktop_registered = text && re_socket_send(a->events, text); free(text); cJSON_Delete(j);
}
void re_app_tick(ReApp *a) {
  ReMessage *m;
  while ((m = re_net_poll(a->net))) { response(a, m); re_message_free(m); }
  for (int messages = 0; messages < 128 && (m = re_socket_poll(a->events)); messages++) {
    cJSON *j = cJSON_ParseWithLength(m->data, m->size); const char *type = re_string(j, "type");
    if (!strcmp(type, "connected")) {
      a->connected = true;
      if (a->initialized) {
        request(a, OP_STATE, -1, "state", NULL);
        re_copy(a->status, sizeof(a->status), "Session connection restored. Reattaching retained processes.");
      }
      for (int i = 0; i < RE_TABS; i++) if (a->tabs[i].terminal) re_terminal_attach(a->tabs[i].terminal);
    }
    else if (!strcmp(type, "disconnected")) { a->connected = a->desktop_registered = false; a->desktop_id[0] = 0; re_copy(a->status, sizeof(a->status), "Session connection lost. Reconnecting to retained processes…"); }
    else if (!strcmp(type, "desktop-registered")) re_copy(a->desktop_id, sizeof(a->desktop_id), re_string(j, "id"));
    else if (!strcmp(type, "desktop-action")) {
      bool accepted = !strcmp(re_string(j, "action"), "reload") && !strcmp(re_string(j, "desktopId"), a->desktop_id) && getenv("RENGINE_CAN_RELOAD") && !a->quitting && !a->reload_requested;
      cJSON *reply = cJSON_CreateObject(); cJSON_AddStringToObject(reply, "type", "desktop-action-result");
      cJSON_AddStringToObject(reply, "requestId", re_string(j, "requestId")); cJSON_AddBoolToObject(reply, "accepted", accepted);
      char *text = cJSON_PrintUnformatted(reply); bool sent = text && re_socket_send(a->events, text); free(text); cJSON_Delete(reply);
      if (accepted && sent) a->reload_requested = true;
    }
    else if (!strcmp(type, "session")) update_session(a, cJSON_GetObjectItemCaseSensitive(j, "session"));
    else if (!strcmp(type, "error")) re_copy(a->status, sizeof(a->status), re_string(j, "error"));
    for (int i = 0; i < RE_TABS; i++) if (a->tabs[i].terminal) re_terminal_message(a->tabs[i].terminal, j);
    cJSON_Delete(j); re_message_free(m);
  }
  register_desktop(a);
  Uint64 now = SDL_GetTicks64();
  for (int i = 0; i < RE_TABS; i++) if (a->tabs[i].editor) {
    ReTab *t = &a->tabs[i]; t->dirty = t->saved != re_editor_revision(t->editor);
    if (now >= t->edited + 250 || a->quitting) checkpoint(a, i);
  }
  if (a->layout_dirty && (now >= a->layout_changed + 250 || a->quitting) && a->net) {
    cJSON *body = cJSON_CreateObject(); cJSON_AddItemToObject(body, "layout", serialize(a));
    if (request(a, OP_LAYOUT, -1, "layout", body)) a->layout_dirty = false; cJSON_Delete(body);
  }
}
bool re_app_quit(ReApp *a) {
  a->quitting = true; re_app_tick(a);
  for (int i = 0; i < RE_ARRAY_SIZE(a->pending); i++) if (a->pending[i].id) return false;
  for (int i = 0; i < RE_TABS; i++) {
    ReTab *t = &a->tabs[i];
    if (t->editor && t->dirty && t->checkpoint != re_editor_revision(t->editor)) { a->quitting = false; return false; }
  }
  return a->quitting;
}
void re_app_close(ReApp *a) {
  if (!a) return;
  for (int i = 0; i < RE_TABS; i++) { cJSON_Delete(a->tabs[i].data); re_terminal_close(a->tabs[i].terminal); re_editor_close(a->tabs[i].editor); re_game_close(a->tabs[i].game); }
  re_socket_close(a->events); re_net_close(a->net); cJSON_Delete(a->state); cJSON_Delete(a->previous_layout); cJSON_Delete(a->controls); free(a);
}
cJSON *re_app_inspect(ReApp *a) {
  cJSON *j = serialize(a); cJSON_AddStringToObject(j, "status", a->status); cJSON_AddBoolToObject(j, "connected", a->connected);
  if (a->controls) cJSON_AddItemToObject(j, "controls", cJSON_Duplicate(a->controls, 1));
  cJSON_AddItemToObject(j, "state", cJSON_Duplicate(a->state, 1)); cJSON_AddNumberToObject(j, "focus", a->focus);
  cJSON *tabs = cJSON_GetObjectItemCaseSensitive(j, "tabs");
  for (int i = 0; i < RE_TABS; i++) if (a->tabs[i].used) {
    cJSON *tab = cJSON_GetArrayItem(tabs, i); ReTab *t = &a->tabs[i];
    int r[] = {t->rect.x, t->rect.y, t->rect.w, t->rect.h}; cJSON_AddItemToObject(tab, "rect", cJSON_CreateIntArray(r, 4));
    int h[] = {t->header.x, t->header.y, t->header.w, t->header.h}; cJSON_AddItemToObject(tab, "header", cJSON_CreateIntArray(h, 4));
    cJSON_AddBoolToObject(tab, "dirty", t->dirty); cJSON_AddBoolToObject(tab, "conflict", t->conflict); cJSON_AddStringToObject(tab, "error", t->error);
    char *text = t->terminal ? re_terminal_text(t->terminal) : t->editor ? re_editor_text(t->editor) : NULL;
    if (text) { cJSON_AddStringToObject(tab, "text", text); free(text); }
    if (t->terminal) {
      cJSON_AddBoolToObject(tab, "attached", re_terminal_ready(t->terminal));
      ReTerminalScroll scroll = re_terminal_scroll_state(t->terminal);
      cJSON_AddNumberToObject(tab, "historyLines", scroll.lines); cJSON_AddNumberToObject(tab, "scrollOffset", scroll.offset);
    }
    if (t->editor) cJSON_AddStringToObject(tab, "mode", re_editor_mode(t->editor));
    if (t->terminal || t->editor) {
      cJSON *bars = cJSON_AddArrayToObject(tab, "scrollbars");
      if (t->terminal) re_terminal_scrollbars(t->terminal, bars); else re_editor_scrollbars(t->editor, bars);
    }
    if (t->game) { cJSON_AddNumberToObject(tab, "sequence", t->game->sequence); cJSON_AddBoolToObject(tab, "captured", t->game->captured); }
    if (t->data && t->type == RE_TREE) cJSON_AddItemToObject(tab, "tree", cJSON_Duplicate(t->data, 1));
  }
  return j;
}
