#include "app.h"
#include "editor.h"

/* Operations at or above OP_BYTES belong to a format view and carry its mode in `revision`;
 * everything else must sort below it, or the request path reads a format that is not there. */
enum { OP_STATE = 1, OP_LOAD, OP_SAVE, OP_DRAFT, OP_DISCARD, OP_CREATE, OP_ROOT, OP_GENERIC, OP_LAYOUT, OP_EXPAND,
       OP_FORMATS, OP_DASHBOARD, OP_CAPTURE, OP_BYTES, OP_PREVIEW, OP_ENTRY };
static int request_within(ReApp *a, int operation, int tab, const char *route, const cJSON *body, long timeout) {
  char scoped[160]; const char *window = getenv("RENGINE_WINDOW_ID");
  if (window && *window && (!strcmp(route, "state") || !strcmp(route, "layout"))) {
    snprintf(scoped, sizeof(scoped), "%s?windowId=%s", route, window); route = scoped;
  }
  for (int i = 0; i < RE_ARRAY_SIZE(a->pending); i++) if (!a->pending[i].id) {
    int id = re_net_request_within(a->net, route, body, timeout);
    if (!id) break;
    a->pending[i] = (RePending){id, operation, tab, tab >= 0 ? a->tabs[tab].generation : 0,
      tab >= 0 && a->tabs[tab].editor ? re_editor_revision(a->tabs[tab].editor) : 0, -1, "", timeout};
    if (operation >= OP_BYTES && tab >= 0) a->pending[i].revision = re_format_mode(a->tabs[tab].format);
    if (tab >= 0) re_copy(a->pending[i].root, sizeof(a->pending[i].root), a->tabs[tab].root);
    return id;
  }
  re_copy(a->status, sizeof(a->status), "Workspace request queue is full; retry when pending work completes."); return 0;
}
static int request(ReApp *a, int operation, int tab, const char *route, const cJSON *body) { return request_within(a, operation, tab, route, body, 0); }
/* Expansion loads name the slot their listing belongs to, so two folders opened at once land right. */
static int request_slot(ReApp *a, int operation, int tab, const char *route, int slot) {
  int id = request_within(a, operation, tab, route, NULL, 0);
  if (id) for (int i = 0; i < RE_ARRAY_SIZE(a->pending); i++) if (a->pending[i].id == id) { a->pending[i].slot = slot; break; }
  return id;
}
/* Declared producer budget plus transport overhead; the service enforces the declared bound itself. */
static long command_deadline(const cJSON *spec) { int declared = re_number(spec, "timeoutMs"); return declared > 0 ? declared + 2000L : 0; }
static cJSON *file_body(ReTab *t, bool draft) {
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "rootId", t->root); cJSON_AddStringToObject(j, "path", t->path);
  char *text = re_editor_text(t->editor); cJSON_AddStringToObject(j, "text", text ? text : ""); free(text);
  cJSON_AddStringToObject(j, draft ? "baseVersion" : "version", t->version); return j;
}
/* ---- nested explorer -------------------------------------------------------------------------
 * The pool is flat and searched linearly: it holds at most RE_TREE_EXPANSIONS entries, a person
 * cannot open more branches than that by hand, and a flat scan keeps the collapse rules readable. */
/* An empty ancestor names no directory, so nothing is under it. Returning true here once made a
 * collapse take every open branch, because the caller's path had already been cleared. */
static bool under(const char *path, const char *ancestor) {
  size_t n = strlen(ancestor);
  if (!n) return false;
  return !strncmp(path, ancestor, n) && path[n] == '/';
}
/* A slot is free when it names no directory; the pool starts zeroed, so an empty path is the marker
 * rather than the tab index, which would make tab 0 indistinguishable from an unused slot. */
static bool taken(const ReExpansion *e) { return e->path[0] != 0; }
int re_app_expanded(ReApp *a, int tab, const char *path) {
  if (!*path) return -1;
  for (int i = 0; i < RE_TREE_EXPANSIONS; i++) {
    ReExpansion *e = &a->expansions[i];
    if (taken(e) && e->tab == tab && e->generation == a->tabs[tab].generation && !strcmp(e->path, path)) return i;
  }
  return -1;
}
static void release(ReApp *a, int slot) {
  cJSON_Delete(a->expansions[slot].data);
  memset(&a->expansions[slot], 0, sizeof(a->expansions[slot]));
}
void re_app_expansions_clear(ReApp *a, int tab) {
  for (int i = 0; i < RE_TREE_EXPANSIONS; i++) if (taken(&a->expansions[i]) && a->expansions[i].tab == tab) release(a, i);
}
void re_app_collapse(ReApp *a, int tab, const char *path) {
  for (int i = 0; i < RE_TREE_EXPANSIONS; i++) {
    ReExpansion *e = &a->expansions[i];
    if (!taken(e) || e->tab != tab) continue;
    if (!strcmp(e->path, path) || under(e->path, path)) release(a, i);   /* a branch closes whole */
  }
}
int re_app_tree_rows(ReApp *a, int tab) {
  ReTab *t = &a->tabs[tab];
  int rows = cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(t->data, "entries"));
  for (int i = 0; i < RE_TREE_EXPANSIONS; i++) {
    ReExpansion *e = &a->expansions[i];
    if (taken(e) && e->tab == tab && e->generation == t->generation)
      rows += cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(e->data, "entries"));
  }
  return rows;
}
/* The cap is on rows, not on branches, because rows are what a person scrolls and what the desktop
 * lays out. Reaching it collapses the least-recently-expanded branch rather than refusing to open
 * (decision 7), and never one the opened directory or the selected row sits under (decision 8). */
static bool protected_branch(ReApp *a, int tab, int slot, const char *opening) {
  ReExpansion *e = &a->expansions[slot];
  ReTab *t = &a->tabs[tab];
  if (!strcmp(e->path, opening) || under(opening, e->path)) return true;
  return *t->selected && (!strcmp(e->path, t->selected) || under(t->selected, e->path));
}
static void enforce_row_cap(ReApp *a, int tab, const char *opening) {
  while (re_app_tree_rows(a, tab) > RE_METRIC_TREE_ROW_CAP) {
    int oldest = -1;
    for (int i = 0; i < RE_TREE_EXPANSIONS; i++) {
      ReExpansion *e = &a->expansions[i];
      if (!taken(e) || e->tab != tab || e->generation != a->tabs[tab].generation || !e->data) continue;
      if (protected_branch(a, tab, i, opening)) continue;
      if (oldest < 0 || e->opened < a->expansions[oldest].opened) oldest = i;
    }
    if (oldest < 0) {
      int self = re_app_expanded(a, tab, opening);
      if (self >= 0) release(a, self);
      snprintf(a->status, sizeof(a->status),
               "The explorer is at its row limit and every open folder is on the path you are using; close one to open %s.",
               *opening ? opening : "another folder");
      return;
    }
    /* Copy first: collapsing frees the slot this path lives in, and the branch test would then be
     * comparing against a cleared buffer. */
    char closing[sizeof(a->expansions[0].path)];
    re_copy(closing, sizeof(closing), a->expansions[oldest].path);
    snprintf(a->status, sizeof(a->status), "Collapsed %s to stay within the explorer's row limit.", closing);
    re_app_collapse(a, tab, closing);
  }
}
void re_app_expand(ReApp *a, int tab, const char *path) {
  ReTab *t = &a->tabs[tab];
  if (re_app_expanded(a, tab, path) >= 0) { re_app_collapse(a, tab, path); return; }
  if (strlen(path) >= sizeof(a->expansions[0].path)) {
    re_copy(t->error, sizeof(t->error), "Folder path exceeds the view limit."); return;
  }
  int slot = -1;
  for (int i = 0; i < RE_TREE_EXPANSIONS; i++) if (!taken(&a->expansions[i])) { slot = i; break; }
  if (slot < 0) {
    snprintf(a->status, sizeof(a->status), "Close a folder before opening another; the explorer holds %d at once.", RE_TREE_EXPANSIONS);
    return;
  }
  memset(&a->expansions[slot], 0, sizeof(a->expansions[slot]));
  a->expansions[slot].tab = tab; a->expansions[slot].generation = t->generation; a->expansions[slot].opened = SDL_GetTicks64();
  re_copy(a->expansions[slot].path, sizeof(a->expansions[slot].path), path);
  char *route = re_net_query("tree", t->root, path);
  if (route) { request_slot(a, OP_EXPAND, tab, route, slot); free(route); }
  else release(a, slot);
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
static const cJSON *formats_for(ReApp *a, const char *root) {
  const cJSON *known = cJSON_GetObjectItemCaseSensitive(a->formats, root); return cJSON_IsObject(known) ? known : NULL;
}
/* Identity comes from the primary root and is read from its declaration, which the desktop already
 * fetches for formats. Falling back to the defaults costs nothing when a project declares neither. */
const char *re_app_title(ReApp *a) {
  const cJSON *declared = formats_for(a, *a->primary_root ? a->primary_root : a->root);
  const char *title = re_string(declared, "title");
  return *title ? title : RE_DEFAULT_TITLE;
}
const char *re_app_mark(ReApp *a) {
  const cJSON *declared = formats_for(a, *a->primary_root ? a->primary_root : a->root);
  const char *glyph = re_string(cJSON_GetObjectItemCaseSensitive(declared, "icon"), "glyph");
  return *glyph ? glyph : "r";
}
mu_Color re_app_mark_color(ReApp *a) {
  const cJSON *declared = formats_for(a, *a->primary_root ? a->primary_root : a->root);
  const char *token = re_string(cJSON_GetObjectItemCaseSensitive(declared, "icon"), "token");
  if (!strcmp(token, "ok")) return RE_COLOR_OK;
  if (!strcmp(token, "warn")) return RE_COLOR_WARN;
  if (!strcmp(token, "err")) return RE_COLOR_ERR;
  if (!strcmp(token, "info")) return RE_COLOR_INFO;
  return RE_COLOR_ACCENT;   /* the declared accent, and the default when nothing is declared */
}
static void fetch_formats(ReApp *a, const char *root) {
  if (!*root || cJSON_IsNull(cJSON_GetObjectItemCaseSensitive(a->formats, root))) return;
  char *route = re_net_query("formats", root, ""); int id = route ? request(a, OP_FORMATS, -1, route, NULL) : 0;
  if (id) {
    for (int i = 0; i < RE_ARRAY_SIZE(a->pending); i++) if (a->pending[i].id == id) re_copy(a->pending[i].root, sizeof(a->pending[i].root), root);
    cJSON_DeleteItemFromObject(a->formats, root); cJSON_AddItemToObject(a->formats, root, cJSON_CreateNull());
  }
  free(route);
}
static bool listed(const cJSON *array, const char *value) {
  const cJSON *item = NULL; cJSON_ArrayForEach(item, array) if (cJSON_IsString(item) && !strcmp(item->valuestring, value)) return true; return false;
}
static void probe_dashboard(ReApp *a, const char *root) {
  if (!*root || cJSON_HasObjectItem(a->dashboards, root)) return;
  char *route = re_net_query("dashboard", root, ""); int id = route ? request(a, OP_DASHBOARD, -1, route, NULL) : 0;
  if (id) {
    for (int i = 0; i < RE_ARRAY_SIZE(a->pending); i++) if (a->pending[i].id == id) re_copy(a->pending[i].root, sizeof(a->pending[i].root), root);
    cJSON_AddItemToObject(a->dashboards, root, cJSON_CreateNull());
  }
  free(route);
}
/* A devices load runs every declared probe, so it gets its own deadline rather than the 5 s one a
   filesystem answer needs; refresh asks the service to bypass its brief cache. See sidecar: devices-route. */
static void devices_request(ReApp *a, int tab, bool refresh) {
  ReTab *t = &a->tabs[tab];
  char *base = re_net_query("devices", t->root, "");
  if (!base) return;
  char route[2300]; snprintf(route, sizeof(route), "%s%s", base, refresh ? "&refresh=1" : "");
  free(base);
  request_within(a, OP_LOAD, tab, route, NULL, RE_DEVICES_TIMEOUT_MS);
}
void re_app_devices_refresh(ReApp *a, int tab) { devices_request(a, tab, true); }
int re_app_devices(ReApp *a, const char *root) {
  if (!*root) return -1;
  return re_app_tab(a, RE_DEVICES, root, "", "", "Devices");
}
int re_app_dashboard(ReApp *a, const char *root) {
  if (!*root) return -1;
  if (!listed(a->dashboards_opened, root)) cJSON_AddItemToArray(a->dashboards_opened, cJSON_CreateString(root));
  return re_app_tab(a, RE_DASHBOARD, root, "", "", "Dashboard");
}
void re_app_dashboard_run(ReApp *a, int tab, const char *action, bool capture) {
  ReTab *t = &a->tabs[tab];
  cJSON *body = cJSON_CreateObject(); cJSON_AddStringToObject(body, "rootId", t->root); cJSON_AddStringToObject(body, "actionId", action);
  if (capture) request(a, OP_CAPTURE, tab, "dashboard-capture", body); else request(a, OP_CREATE, -1, "dashboard-run", body);
  cJSON_Delete(body);
}
void re_app_reveal(ReApp *a, const char *root, const char *artifact) {
  char directory[2048]; re_copy(directory, sizeof(directory), artifact);
  char *slash = strrchr(directory, '/'); if (slash) *slash = 0; else directory[0] = 0;
  int tab = -1;
  for (int i = 0; i < RE_TABS && tab < 0; i++) if (a->tabs[i].used && a->tabs[i].type == RE_TREE && !strcmp(a->tabs[i].root, root)) tab = i;
  if (tab < 0) tab = re_app_tab(a, RE_TREE, root, "", "", "Project");
  if (tab < 0) return;
  ReTab *t = &a->tabs[tab]; re_copy(t->path, sizeof(t->path), directory); re_app_load(a, tab);
  int pane = re_layout_find(&a->layout, tab);
  if (pane < 0) re_layout_add(&a->layout, a->layout.active, tab);
  else { a->layout.active = pane; for (int k = 0; k < a->layout.panes[pane].count; k++) if (a->layout.panes[pane].tabs[k] == tab) a->layout.panes[pane].selected = k; }
  snprintf(a->status, sizeof(a->status), "Revealed %s in the project tree.", artifact); re_app_layout_changed(a);
}
/* The surface a game session declares, or "" for anything that is not a game session carrying one. */
static const char *game_session_surface(ReApp *a, const char *id) {
  const cJSON *session = NULL;
  cJSON_ArrayForEach(session, cJSON_GetObjectItemCaseSensitive(a->state, "sessions"))
    if (!strcmp(re_string(session, "id"), id)) return strcmp(re_string(session, "type"), "game") ? "" : re_string(session, "surface");
  return "";
}
bool re_app_external_session(ReApp *a, const char *id) { return !strcmp(game_session_surface(a, id), "external"); }
/* A game whose surface is external has no frame stream; its view is the retained PTY output. Every
   other surface streams, so embedded and cooperative both open the live view without naming it. */
static void open_view(ReApp *a, ReTab *t) {
  if (t->type == RE_TERMINAL || (t->type == RE_GAME && re_app_external_session(a, t->session))) { if (!t->terminal) t->terminal = re_terminal_open(a->events, t->session, 80, 24); }
  else if (t->type == RE_GAME && !t->game) t->game = re_game_open(a->net, t->session);
}
const cJSON *re_app_format_record(ReApp *a, ReTab *t) {
  const cJSON *known = formats_for(a, t->root); if (!known) return NULL;
  const char *name = strrchr(t->path, '/'); name = name ? name + 1 : t->path;
  const cJSON *record = re_format_match(cJSON_GetObjectItemCaseSensitive(known, "formats"), name);
  if (record && t->format && !*re_format_id(t->format)) re_format_assign(t->format, re_string(record, "id"), re_string(record, "title"));
  return record;
}
void re_app_load(ReApp *a, int tab) {
  ReTab *t = &a->tabs[tab];
  if (t->type == RE_TREE) { char *route = re_net_query("tree", t->root, t->path); if (route) request(a, OP_LOAD, tab, route, NULL); free(route); return; }
  if (t->type == RE_DASHBOARD) { char *route = re_net_query("dashboard", t->root, ""); if (route) request(a, OP_LOAD, tab, route, NULL); free(route); return; }
  if (t->type == RE_DEVICES) { devices_request(a, tab, false); return; }
  if (t->type != RE_EDITOR) return;
  if (!t->format || re_format_mode(t->format) == RE_MODE_PENDING) {
    if (!t->format) t->format = re_format_open(RE_MODE_PENDING, false);
    if (!formats_for(a, t->root)) { fetch_formats(a, t->root); return; }
    const cJSON *record = t->format ? re_app_format_record(a, t) : NULL; int chosen = record ? re_format_mode_from(re_string(record, "default")) : -1;
    if (record) re_format_set_mode(t->format, chosen < 0 ? RE_MODE_TEXT : chosen, false);
    else { re_format_close(t->format); t->format = NULL; }
  }
  int mode = t->format ? re_format_mode(t->format) : RE_MODE_TEXT;
  if (mode == RE_MODE_TEXT) { char *route = re_net_query("file", t->root, t->path); if (route) request(a, OP_LOAD, tab, route, NULL); free(route); return; }
  if (!formats_for(a, t->root)) { re_format_await(t->format, true); fetch_formats(a, t->root); return; } /* restored tabs need the declared budget and modes */
  re_format_await(t->format, false);
  const cJSON *record = re_app_format_record(a, t);
  if (mode == RE_MODE_RAW) {
    char *query = re_net_query("bytes", t->root, t->path), route[3600];
    if (query) { snprintf(route, sizeof(route), "%s&offset=%lld&length=%d", query, re_format_offset(t->format, false), RE_HEX_WINDOW); request(a, OP_BYTES, tab, route, NULL); }
    free(query); return;
  }
  const cJSON *spec = cJSON_GetObjectItemCaseSensitive(record, "preview"); re_format_name_command(t->format, spec, false);
  cJSON *body = cJSON_CreateObject(); cJSON_AddStringToObject(body, "rootId", t->root); cJSON_AddStringToObject(body, "path", t->path);
  request_within(a, OP_PREVIEW, tab, "format-preview", body, command_deadline(spec)); cJSON_Delete(body);
}
void re_app_load_entry(ReApp *a, int tab) {
  ReTab *t = &a->tabs[tab]; if (!t->format || !*re_format_entry(t->format)) return;
  const cJSON *spec = cJSON_GetObjectItemCaseSensitive(re_app_format_record(a, t), "entry"); re_format_name_command(t->format, spec, true);
  cJSON *body = cJSON_CreateObject(); cJSON_AddStringToObject(body, "rootId", t->root); cJSON_AddStringToObject(body, "path", t->path);
  cJSON_AddStringToObject(body, "entry", re_format_entry(t->format)); cJSON_AddNumberToObject(body, "offset", (double)re_format_offset(t->format, true));
  cJSON_AddNumberToObject(body, "length", RE_HEX_WINDOW); request_within(a, OP_ENTRY, tab, "format-preview", body, command_deadline(spec)); cJSON_Delete(body);
}
void re_app_mode(ReApp *a, int tab, int mode) {
  ReTab *t = &a->tabs[tab]; if (!t->format || mode < RE_MODE_TEXT || mode > RE_MODE_PREVIEW) return;
  if (t->editor && t->dirty) { re_copy(a->status, sizeof(a->status), "Save or discard the text edits before switching modes."); return; }
  if (mode != RE_MODE_TEXT) { re_editor_close(t->editor); t->editor = NULL; t->saved = t->checkpoint = t->checkpoint_flight = 0; t->conflict = false; }
  t->generation++; t->error[0] = 0; re_format_set_mode(t->format, mode, true); re_app_load(a, tab); re_app_layout_changed(a);
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
      open_view(a, t);
      /* Choosing the view a person already has open is the refresh gesture for a directory. The
       * expansions are keyed by path and survive it, as spec 080 decision 10 requires. */
      if (type == RE_TREE) re_app_load(a, i);
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
    open_view(a, t);
    re_app_load(a, i); re_app_layout_changed(a); return i;
  }
  re_copy(a->status, sizeof(a->status), "The workspace supports 64 retained views in this build."); return -1;
}
static bool session_tab(ReApp *a, const cJSON *session) {
  return re_app_tab(a, !strcmp(re_string(session, "type"), "game") ? RE_GAME : RE_TERMINAL,
    re_string(session, "rootId"), "", re_string(session, "id"), re_string(session, "title")) >= 0;
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
    if (t->format && re_format_mode(t->format) != RE_MODE_PENDING) cJSON_AddStringToObject(tab, "mode", re_format_mode_name(re_format_mode(t->format)));
  }
  cJSON_AddItemToObject(j, "dashboards", cJSON_Duplicate(a->dashboards_opened, 1));
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
    if (type < RE_TREE || type > RE_DEVICES || strlen(re_string(tab, "root")) > 64 ||
        strlen(re_string(tab, "session")) > 64 || strlen(re_string(tab, "path")) > 2047) return false;
    if (cJSON_HasObjectItem(tab, "mode") && (type != RE_EDITOR || re_format_mode_from(re_string(tab, "mode")) < 0)) return false;
  }
  a->layout = layout;
  for (int i = 0; i < RE_TABS; i++) {
    const cJSON *tab = cJSON_GetArrayItem(tabs, i); if (cJSON_IsNull(tab)) continue;
    ReTab *t = &a->tabs[i]; t->used = true; t->generation++; t->type = re_number(tab, "type");
    re_copy(t->root, sizeof(t->root), re_string(tab, "root")); re_copy(t->path, sizeof(t->path), re_string(tab, "path"));
    re_copy(t->session, sizeof(t->session), re_string(tab, "session")); re_copy(t->title, sizeof(t->title), re_string(tab, "title"));
    if ((t->type == RE_TERMINAL || t->type == RE_GAME) && re_layout_find(&a->layout, i) >= 0) open_view(a, t);
    if (cJSON_HasObjectItem(tab, "mode")) t->format = re_format_open(re_format_mode_from(re_string(tab, "mode")), true);
    re_app_load(a, i);
  }
  const cJSON *opened = cJSON_GetObjectItemCaseSensitive(j, "dashboards"), *root = NULL;
  cJSON_ArrayForEach(root, opened) if (cJSON_IsString(root) && strlen(root->valuestring) <= 64 && !listed(a->dashboards_opened, root->valuestring)) cJSON_AddItemToArray(a->dashboards_opened, cJSON_CreateString(root->valuestring));
  a->previous_layout = cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(j, "previous"), 1); return true;
}
static void state_loaded(ReApp *a, const cJSON *j) {
  cJSON_Delete(a->state); a->state = cJSON_Duplicate(j, 1);
  const cJSON *root = NULL;
  cJSON_ArrayForEach(root, cJSON_GetObjectItemCaseSensitive(j, "roots")) fetch_formats(a, re_string(root, "id"));
  if (a->initialized) return;
  a->initialized = true;
  const cJSON *preferences = cJSON_GetObjectItemCaseSensitive(j, "preferences");
  a->vim = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(preferences, "vim")); re_copy(a->agent, sizeof(a->agent), re_string(preferences, "agent"));
  /* Settings follow the workspace, so a second window and a restart agree (spec 080 decision 6). */
  a->explorer_nested = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(preferences, "explorer"))
    || !strcmp(re_string(preferences, "explorer"), "nested");
  if (*re_string(preferences, "syntax")) { re_copy(a->scheme, sizeof(a->scheme), re_string(preferences, "syntax")); re_editor_scheme(a->scheme); }
  if (*re_string(preferences, "theme")) { int index = re_draw_theme(re_draw_active(), re_string(preferences, "theme")); if (index >= 0) a->preset = index; }
  /* The hue rides on top of the preset, so it is applied after the preset has been selected. */
  const cJSON *hue = cJSON_GetObjectItemCaseSensitive(preferences, "accentHue");
  a->accent_hue = cJSON_IsNumber(hue) ? (float)hue->valuedouble : re_theme_accent_hues[a->preset];
  re_theme_hue_set(a->accent_hue);
  if (!*a->root) re_copy(a->root, sizeof(a->root), re_string(cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(j, "roots"), 0), "id"));
  /* The window's primary root is fixed here and never follows focus afterwards (spec 084). */
  if (!*a->primary_root) { re_copy(a->primary_root, sizeof(a->primary_root), a->root); fetch_formats(a, a->primary_root); }
  re_app_project_theme(a);
  if (!*a->root) re_copy(a->root, sizeof(a->root), re_string(cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(j, "roots"), 0), "id"));
  const cJSON *old = cJSON_GetObjectItemCaseSensitive(j, "layout");
  bool restored = restore(a, old);
  if (!restored) {
    a->previous_layout = cJSON_Duplicate(old, 1);
    if (*a->root) {
      int right = re_layout_split(&a->layout, 0, 1); a->layout.panes[0].ratio = RE_METRIC_WORKSPACE_TREE_PERCENT / 100.0f;
      a->layout.active = a->layout.panes[0].child[0]; re_app_tab(a, RE_TREE, a->root, "", "", "Project"); a->layout.active = right;
    }
  }
  const cJSON *sessions = cJSON_GetObjectItemCaseSensitive(j, "sessions"), *session;
  cJSON_ArrayForEach(session, sessions) {
    const char *id = re_string(session, "id");
    if ((!strcmp(id, a->initial_terminal) || !strcmp(id, a->initial_agent) || !strcmp(id, a->initial_game)) && !strcmp(re_string(session, "state"), "running")) {
      bool visible = false;
      if (restored) for (int i = 0; i < RE_TABS; i++) if (a->tabs[i].used && !strcmp(a->tabs[i].session, id) && re_layout_find(&a->layout, i) >= 0) visible = true;
      if (!visible) session_tab(a, session);
    }
  }
  if (getenv("RENGINE_RESUME_AGENT")) cJSON_ArrayForEach(session, sessions) {
    if (!strcmp(re_string(session, "id"), a->initial_agent) && !strcmp(re_string(session, "state"), "running")) session_tab(a, session);
  }
  re_copy(a->status, sizeof(a->status), "Workspace connected. Closing a view detaches; sessions stop explicitly.");
}
static void formats_loaded(ReApp *a, const cJSON *j) {
  const char *root = re_string(j, "rootId"); if (!*root) return;
  cJSON_DeleteItemFromObject(a->formats, root); cJSON_AddItemToObject(a->formats, root, cJSON_Duplicate(j, 1));
  if (*re_string(j, "error")) re_copy(a->status, sizeof(a->status), re_string(j, "error"));
  else if (*re_string(j, "gamesError")) re_copy(a->status, sizeof(a->status), re_string(j, "gamesError"));
  for (int i = 0; i < RE_TABS; i++) {
    ReTab *t = &a->tabs[i];
    if (t->used && t->type == RE_EDITOR && t->format && (re_format_mode(t->format) == RE_MODE_PENDING || re_format_awaiting(t->format)) && !strcmp(t->root, root)) re_app_load(a, i);
  }
  probe_dashboard(a, root);
}
static void dashboard_probed(ReApp *a, const cJSON *j) {
  const char *root = re_string(j, "rootId"); if (!*root) return;
  cJSON_DeleteItemFromObject(a->dashboards, root); cJSON_AddItemToObject(a->dashboards, root, cJSON_Duplicate(j, 1));
  if (*re_string(j, "error")) re_copy(a->status, sizeof(a->status), re_string(j, "error"));
  if (!cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(j, "groups")) || listed(a->dashboards_opened, root)) return;
  for (int i = 0; i < RE_TABS; i++) if (a->tabs[i].used && a->tabs[i].type == RE_DASHBOARD && !strcmp(a->tabs[i].root, root) && re_layout_find(&a->layout, i) >= 0) return;
  int active = a->layout.active; re_app_dashboard(a, root); a->layout.active = active; /* auto-open never steals the active pane */
}
static bool raw_fallback(ReApp *a, RePending *p, ReTab *t, int status) {
  if (p->operation != OP_LOAD || !t || t->type != RE_EDITOR || status != 400) return false;
  if (t->format && (re_format_mode(t->format) != RE_MODE_TEXT || re_format_chosen(t->format))) return false;
  if (!t->format) t->format = re_format_open(RE_MODE_RAW, false); else re_format_set_mode(t->format, RE_MODE_RAW, false);
  if (!t->format) return false;
  re_editor_close(t->editor); t->editor = NULL; t->dirty = false; t->generation++; re_app_load(a, p->tab); re_app_layout_changed(a); return true;
}
static void response(ReApp *a, ReMessage *m) {
  RePending p = {0};
  for (int i = 0; i < RE_ARRAY_SIZE(a->pending); i++) if (a->pending[i].id == m->id) { p = a->pending[i]; a->pending[i].id = 0; break; }
  if (!p.id || (p.tab >= 0 && p.generation != a->tabs[p.tab].generation)) return;
  ReTab *t = p.tab >= 0 ? &a->tabs[p.tab] : NULL;
  if (p.operation == OP_DRAFT && t) t->checkpoint_flight = 0;
  cJSON *j = cJSON_ParseWithLength(m->data, m->size);
  if (m->status != 200 || !j) {
    const char *error = j ? re_string(j, "error") : m->data; char budget[640];
    if (raw_fallback(a, &p, t, m->status)) { cJSON_Delete(j); return; }
    if (p.operation == OP_DASHBOARD && *p.root) {
      cJSON *settled = cJSON_CreateObject(); cJSON_AddStringToObject(settled, "rootId", p.root); cJSON_AddBoolToObject(settled, "declared", true);
      cJSON_AddStringToObject(settled, "error", error); cJSON_AddArrayToObject(settled, "groups"); dashboard_probed(a, settled); cJSON_Delete(settled); cJSON_Delete(j); return;
    }
    if (p.operation == OP_FORMATS && *p.root) {
      cJSON *settled = cJSON_CreateObject(); cJSON_AddStringToObject(settled, "rootId", p.root); cJSON_AddBoolToObject(settled, "declared", true);
      cJSON_AddStringToObject(settled, "error", error); cJSON_AddArrayToObject(settled, "formats"); formats_loaded(a, settled); cJSON_Delete(settled); cJSON_Delete(j); return;
    }
    if (!m->status && p.timeout > 0) { snprintf(budget, sizeof(budget), "%s · no reply within %ld ms (declared timeoutMs %ld plus transport)", error, p.timeout, p.timeout - 2000L); error = budget; }
    re_copy(a->status, sizeof(a->status), error);
    if (p.operation == OP_ENTRY && t && t->format) re_format_entry_failed(t->format, error);
    else if (t) { t->discarding = false; re_copy(t->error, sizeof(t->error), error); if (m->status == 409) t->conflict = true; }
    if (a->quitting) a->quitting = false;
    cJSON_Delete(j); return;
  }
  bool stale = p.operation >= OP_BYTES && t && (!t->format || re_format_mode(t->format) != p.revision);
  switch (stale ? 0 : p.operation) {
    case OP_STATE: state_loaded(a, j); break;
    case OP_FORMATS: formats_loaded(a, j); break;
    case OP_DASHBOARD: dashboard_probed(a, j); break;
    case OP_CAPTURE: snprintf(a->status, sizeof(a->status), "Captured %s (%d bytes, sha256 %.12s…)", re_string(j, "path"), re_number(j, "size"), re_string(j, "sha256")); t->error[0] = 0; break;
    case OP_EXPAND: {
      ReExpansion *e = p.slot >= 0 && p.slot < RE_TREE_EXPANSIONS ? &a->expansions[p.slot] : NULL;
      if (!e || e->tab != p.tab || e->generation != p.generation) break;   /* collapsed while in flight */
      cJSON_Delete(e->data); e->data = cJSON_Duplicate(j, 1);
      enforce_row_cap(a, p.tab, e->path);
      break;
    }
    case OP_LOAD:
      t->discarding = false;
      cJSON_Delete(t->data); t->data = cJSON_Duplicate(j, 1); t->error[0] = 0;
      if (t->type == RE_EDITOR) {
        const cJSON *draft = cJSON_GetObjectItemCaseSensitive(j, "draft"); bool dirty = cJSON_IsObject(draft);
        ReEditor *editor = re_editor_open(re_string(dirty ? draft : j, "text"));
        if (!editor) { re_copy(t->error, sizeof(t->error), "Cannot allocate editor buffer."); break; }
        re_editor_close(t->editor); t->editor = editor; re_editor_vim(editor, a->vim); re_editor_language(editor, t->path);
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
    case OP_BYTES: if (re_format_bytes(t->format, j)) t->error[0] = 0; else re_copy(t->error, sizeof(t->error), "Byte window has an unexpected shape."); break;
    case OP_PREVIEW: case OP_ENTRY:
      if (re_format_result(t->format, j)) { if (p.operation == OP_PREVIEW) t->error[0] = 0; }
      else re_copy(t->error, sizeof(t->error), "Preview result has an unexpected shape.");
      break;
  }
  cJSON_Delete(j);
}
ReApp *re_app_open(const char *url, const char *token) {
  ReApp *a = calloc(1, sizeof(*a)); if (!a) return NULL;
  re_layout_init(&a->layout); a->focus = a->drag_tab = a->resize_pane = -1; a->formats = cJSON_CreateObject(); a->dashboards = cJSON_CreateObject(); a->dashboards_opened = cJSON_CreateArray();
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
  cJSON_AddBoolToObject(j, "canAttach", true);
  cJSON_AddStringToObject(j, "type", "desktop-register"); cJSON_AddBoolToObject(j, "canReload", getenv("RENGINE_CAN_RELOAD") != NULL);
  if (getenv("RENGINE_DESKTOP_OWNER") && getenv("RENGINE_DESKTOP_VIEW")) {
    cJSON_AddStringToObject(j, "owner", getenv("RENGINE_DESKTOP_OWNER")); cJSON_AddStringToObject(j, "view", getenv("RENGINE_DESKTOP_VIEW"));
  }
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
    else if (!strcmp(type, "disconnected")) {
      a->connected = a->desktop_registered = false; a->desktop_id[0] = 0; cJSON_Delete(a->formats); a->formats = cJSON_CreateObject(); cJSON_Delete(a->dashboards); a->dashboards = cJSON_CreateObject();
      re_copy(a->status, sizeof(a->status), "Session connection lost. Reconnecting to retained processes…");
    }
    else if (!strcmp(type, "desktop-registered")) re_copy(a->desktop_id, sizeof(a->desktop_id), re_string(j, "id"));
    else if (!strcmp(type, "desktop-action")) {
      bool reload = !strcmp(re_string(j, "action"), "reload"), accepted = false;
      if (!strcmp(re_string(j, "desktopId"), a->desktop_id) && !a->quitting && !a->reload_requested) {
        if (reload) accepted = getenv("RENGINE_CAN_RELOAD") != NULL;
        else if (!strcmp(re_string(j, "action"), "attach-session")) {
          const cJSON *session = cJSON_GetObjectItemCaseSensitive(j, "session");
          if (*re_string(session, "id") && *re_string(session, "rootId")) { update_session(a, session); accepted = session_tab(a, session); }
        }
      }
      cJSON *reply = cJSON_CreateObject(); cJSON_AddStringToObject(reply, "type", "desktop-action-result");
      cJSON_AddStringToObject(reply, "requestId", re_string(j, "requestId")); cJSON_AddBoolToObject(reply, "accepted", accepted);
      char *text = cJSON_PrintUnformatted(reply); bool sent = text && re_socket_send(a->events, text); free(text); cJSON_Delete(reply);
      if (reload && accepted && sent) a->reload_requested = true;
    }
    else if (!strcmp(type, "session")) update_session(a, cJSON_GetObjectItemCaseSensitive(j, "session"));
    else if (!strcmp(type, "output")) re_recording_output_event(a, j);
    else if (!strcmp(type, "error")) re_copy(a->status, sizeof(a->status), re_string(j, "error"));
    for (int i = 0; i < RE_TABS; i++) if (a->tabs[i].terminal) re_terminal_message(a->tabs[i].terminal, j);
    cJSON_Delete(j); re_message_free(m);
  }
  register_desktop(a);
  re_recording_sync(a);
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
  if (!a->quitting) {
    a->quit_started = SDL_GetTicks64();
    for (int i = 0; i < RE_TABS; i++) if (a->tabs[i].terminal) re_terminal_release(a->tabs[i].terminal);
  }
  a->quitting = true; re_app_tick(a);
  if (re_socket_pending(a->events)) {
    if (SDL_GetTicks64() - a->quit_started >= 2000) {
      a->quitting = false; re_copy(a->status, sizeof(a->status), "Terminal input is still sending. Retry close or reload after it settles.");
    }
    return false;
  }
  for (int i = 0; i < RE_ARRAY_SIZE(a->pending); i++) if (a->pending[i].id) return false;
  for (int i = 0; i < RE_TABS; i++) {
    ReTab *t = &a->tabs[i];
    if (t->editor && t->dirty && t->checkpoint != re_editor_revision(t->editor)) { a->quitting = false; return false; }
  }
  return a->quitting;
}
void re_app_close(ReApp *a) {
  if (!a) return;
  for (int i = 0; i < RE_TABS; i++) {
    cJSON_Delete(a->tabs[i].data); re_recording_close(a->tabs[i].recorder); re_terminal_close(a->tabs[i].terminal);
    re_editor_close(a->tabs[i].editor); re_game_close(a->tabs[i].game); re_format_close(a->tabs[i].format);
  }
  re_socket_close(a->events); re_net_close(a->net); cJSON_Delete(a->state); cJSON_Delete(a->previous_layout); cJSON_Delete(a->controls); cJSON_Delete(a->formats); cJSON_Delete(a->dashboards); cJSON_Delete(a->dashboards_opened); free(a);
}
cJSON *re_app_inspect(ReApp *a) {
  cJSON *j = serialize(a); cJSON_AddStringToObject(j, "status", a->status); cJSON_AddBoolToObject(j, "connected", a->connected); cJSON_AddStringToObject(j, "root", a->root);
  if (a->controls) cJSON_AddItemToObject(j, "controls", cJSON_Duplicate(a->controls, 1));
  cJSON_AddItemToObject(j, "state", cJSON_Duplicate(a->state, 1)); cJSON_AddNumberToObject(j, "focus", a->focus);
  cJSON_AddNumberToObject(j, "width", a->width); cJSON_AddNumberToObject(j, "height", a->height);
  /* The settings a person can change, so a test and a second window can read what this one holds. */
  cJSON_AddBoolToObject(j, "vim", a->vim); cJSON_AddBoolToObject(j, "explorerNested", a->explorer_nested);
  cJSON_AddStringToObject(j, "scheme", a->scheme); cJSON_AddNumberToObject(j, "accentHue", a->accent_hue);
  cJSON_AddStringToObject(j, "themePath", a->theme_path);
  cJSON_AddStringToObject(j, "title", re_app_title(a)); cJSON_AddStringToObject(j, "mark", re_app_mark(a));
  cJSON_AddStringToObject(j, "primaryRoot", a->primary_root);
  cJSON_AddNumberToObject(j, "overlay", a->overlay);
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
      if (t->terminal) re_terminal_inspect_mouse(t->terminal, tab);
    }
    if (t->game) { cJSON_AddNumberToObject(tab, "sequence", t->game->sequence); cJSON_AddBoolToObject(tab, "captured", t->game->captured); }
    if (t->recorder) re_recording_inspect(t->recorder, tab);
    if (t->type == RE_GAME) {
      /* Report the session's own surface rather than inferring one from the view, which called every
         streaming tab embedded and would now misname a cooperative one. */
      const char *surface = t->terminal ? "external" : game_session_surface(a, t->session);
      cJSON_AddStringToObject(tab, "surface", *surface ? surface : "embedded");
    }
    if (t->data && t->type == RE_TREE) cJSON_AddItemToObject(tab, "tree", cJSON_Duplicate(t->data, 1));
    if (t->data && t->type == RE_DASHBOARD) cJSON_AddItemToObject(tab, "dashboard", cJSON_Duplicate(t->data, 1));
    if (t->data && t->type == RE_DEVICES) cJSON_AddItemToObject(tab, "devices", cJSON_Duplicate(t->data, 1));
    if (t->format) re_format_inspect(t->format, tab);
  }
  return j;
}
