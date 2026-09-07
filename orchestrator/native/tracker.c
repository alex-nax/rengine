#include "tracker.h"
#include <string.h>

/* The state category decides the pill, not the state's name: a provider names its own states, and
   only the category is shared vocabulary (spec 083). */
static int state_pill(const char *category) {
  if (!strcmp(category, "completed")) return RE_UI_PILL_OK;
  if (!strcmp(category, "started")) return RE_UI_PILL_INFO;
  if (!strcmp(category, "blocked")) return RE_UI_PILL_WARN;
  if (!strcmp(category, "canceled")) return RE_UI_PILL_NEUTRAL;
  return RE_UI_PILL_NEUTRAL;
}

/* ---- the agent menu and the open chooser (spec 103 decision 5) ---------------------------------
 * One window draws one Tasks pane at a time and one row has a chooser open at a time, so both live
 * here rather than on ReApp: nothing outside this file reads them, the arrays are fixed, and the
 * menu is dropped by being overwritten rather than freed. The menu carries the root it answered
 * for, because a second Tasks tab on another project must not inherit this one's agent list. */
typedef struct {
  char cli[64];
  bool installed;
  char models[RE_TRACKER_MODELS][64];
  int model_count;
  char preferred[64];                /* the menu's declared default for this CLI */
} ReAgentEntry;
typedef struct { char session[65], label[128], agent[65], task[80]; } ReLiveEntry;
enum { RE_CHOOSER_NONE = 0, RE_CHOOSER_SPAWN, RE_CHOOSER_HOLD };
static struct {
  bool known;
  char root[65], error[256];
  ReAgentEntry agents[RE_TRACKER_AGENTS]; int agent_count;
  ReLiveEntry live[RE_TRACKER_LIVE]; int live_count;
  int kind;                          /* which chooser is open, RE_CHOOSER_NONE when none */
  char task[80], agent[64], model[64];
} menu;

static void chooser_close(void) { menu.kind = RE_CHOOSER_NONE; menu.task[0] = menu.agent[0] = menu.model[0] = 0; }
static bool menu_answers(const char *root) { return menu.known && !strcmp(menu.root, root); }
static const ReAgentEntry *agent_named(const char *cli) {
  for (int i = 0; i < menu.agent_count; i++) if (!strcmp(menu.agents[i].cli, cli)) return &menu.agents[i];
  return NULL;
}
/* A model the menu declares as this CLI's default, else its first; an agent that declares none is
   spawned with no model flag rather than with a model this desktop invented. */
static const char *preferred_model(const ReAgentEntry *e) {
  if (!e) return "";
  if (*e->preferred) return e->preferred;
  return e->model_count ? e->models[0] : "";
}
/* Decompose does not open a chooser, so it needs the menu's own answer to "which agent": the first
   installed one, in the order the menu lists them. */
static const ReAgentEntry *default_agent(void) {
  for (int i = 0; i < menu.agent_count; i++) if (menu.agents[i].installed) return &menu.agents[i];
  return NULL;
}

static void menu_reset(ReApp *a, int tab) {
  const char *root = a->tabs[tab].root;
  if (strcmp(menu.root, root)) chooser_close();   /* another project's chooser is not this one's */
  re_copy(menu.root, sizeof(menu.root), root);
  menu.agent_count = menu.live_count = 0; menu.error[0] = 0;
}

void re_tracker_menu(ReApp *a, int tab, const cJSON *j) {
  menu_reset(a, tab);
  menu.known = true;
  const cJSON *item = NULL;
  cJSON_ArrayForEach(item, cJSON_GetObjectItemCaseSensitive(j, "agents")) {
    if (menu.agent_count >= RE_TRACKER_AGENTS || !*re_string(item, "cli")) continue;
    ReAgentEntry *e = &menu.agents[menu.agent_count];
    memset(e, 0, sizeof(*e));
    re_copy(e->cli, sizeof(e->cli), re_string(item, "cli"));
    re_copy(e->preferred, sizeof(e->preferred), re_string(item, "default"));
    e->installed = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(item, "installed"));
    const cJSON *model = NULL;
    cJSON_ArrayForEach(model, cJSON_GetObjectItemCaseSensitive(item, "models"))
      if (cJSON_IsString(model) && e->model_count < RE_TRACKER_MODELS)
        re_copy(e->models[e->model_count++], sizeof(e->models[0]), model->valuestring);
    menu.agent_count++;
  }
  /* Identity is the agent's own session id (spec 095): the conversation a pane holds is that id, so
     it is what an assign names. An `agentId` the worker states outright still wins. */
  cJSON_ArrayForEach(item, cJSON_GetObjectItemCaseSensitive(j, "live")) {
    if (menu.live_count >= RE_TRACKER_LIVE) break;
    ReLiveEntry *e = &menu.live[menu.live_count];
    memset(e, 0, sizeof(*e));
    re_copy(e->session, sizeof(e->session), re_string(item, "sessionId"));
    re_copy(e->label, sizeof(e->label), re_string(item, "label"));
    re_copy(e->task, sizeof(e->task), re_string(item, "task"));
    const char *identity = re_string(item, "agentId");
    re_copy(e->agent, sizeof(e->agent), *identity ? identity : re_string(item, "conversation"));
    if (*e->agent || *e->session) menu.live_count++;
  }
  if (*menu.agent && !agent_named(menu.agent)) { menu.agent[0] = 0; menu.model[0] = 0; }
}

void re_tracker_menu_failed(ReApp *a, int tab, const char *error) {
  menu_reset(a, tab);
  menu.known = true;                 /* answered, with nothing to offer, which the chooser says */
  re_copy(menu.error, sizeof(menu.error), error && *error ? error : "The workspace serves no agent menu.");
}

/* ---- what the row does ------------------------------------------------------------------------ */

/* The spawn body is the pinned one, sent through the same generic action route every other write
   uses; `desktopId` is how the worker knows which window to hand the new pane to. */
static void spawn(ReApp *a, int tab, const char *task, const char *cli, const char *model, const char *brief) {
  char note[512];
  if (!cli || !*cli) { re_copy(a->status, sizeof(a->status), "No agent CLI is installed for this project."); return; }
  cJSON *j = cJSON_CreateObject();
  cJSON_AddStringToObject(j, "rootId", a->tabs[tab].root);
  cJSON_AddStringToObject(j, "taskKey", task);
  cJSON_AddStringToObject(j, "agent", cli);
  if (*model) cJSON_AddStringToObject(j, "model", model);
  cJSON_AddStringToObject(j, "brief", brief);
  cJSON_AddStringToObject(j, "desktopId", a->desktop_id);
  re_app_action(a, "agent-spawn", j);
  cJSON_Delete(j);
  snprintf(note, sizeof(note), "Asked the workspace to start %s%s%s on %s with the %s brief.",
           cli, *model ? " · " : "", model, task, brief);
  re_copy(a->status, sizeof(a->status), note);
  chooser_close();
}

/* Hold token is not the popover's Grant: a grant answers a contest that is open, and this asks the
   ledger to give the token to a named identity whether it is free, held or contested. It travels on
   the same `token-action` frame the popover's gestures use, as a new `assign` action. */
static void hold(ReApp *a, int tab, const ReLiveEntry *who) {
  char note[512];
  cJSON *j = cJSON_CreateObject();
  cJSON_AddStringToObject(j, "type", "token-action");
  cJSON_AddStringToObject(j, "action", "assign");
  cJSON_AddStringToObject(j, "rootId", a->tabs[tab].root);
  cJSON_AddStringToObject(j, "agentId", who->agent);
  char *text = cJSON_PrintUnformatted(j);
  bool sent = text && re_socket_send(a->events, text);
  free(text); cJSON_Delete(j);
  if (sent) snprintf(note, sizeof(note), "Asked the workspace to give this project's token to %s; the ledger answers with the next token frame.", who->label);
  else re_copy(note, sizeof(note), "Session connection is down; the token was not assigned.");
  re_copy(a->status, sizeof(a->status), note);
  chooser_close();
}

static void chooser_toggle(const char *task, int kind) {
  bool same = menu.kind == kind && !strcmp(menu.task, task);
  chooser_close();
  if (same) return;
  menu.kind = kind;
  re_copy(menu.task, sizeof(menu.task), task);
}
static void choose_agent(const char *cli) {
  re_copy(menu.agent, sizeof(menu.agent), cli);
  re_copy(menu.model, sizeof(menu.model), preferred_model(agent_named(cli)));
}

/* The labels of the live agents whose conversation records this task (spec 103 decision 6). */
static int working_labels(const char *key, char *out, size_t size) {
  size_t used = 0; int count = 0;
  out[0] = 0;
  for (int i = 0; i < menu.live_count; i++) {
    if (strcmp(menu.live[i].task, key)) continue;
    int written = snprintf(out + used, size - used, "%s%s", used ? " · " : "", menu.live[i].label);
    if (written < 0 || (size_t)written >= size - used) break;
    used += (size_t)written; count++;
  }
  return count;
}

/* ---- the chooser ------------------------------------------------------------------------------
 * Inline rows under the task rather than a popover: the pane is already a scrolled list, an overlay
 * would cost one of the root containers the panes fill, and a chooser that scrolls with its row
 * cannot end up describing a different task than the one under it. */
static void agent_rows(ReApp *a, mu_Context *ui, int tab, const char *key, bool answered) {
  int agents = answered ? menu.agent_count : 0;
  int widths[RE_TRACKER_AGENTS + 2], n = 0;
  widths[n++] = RE_METRIC_TRACKER_KEY_WIDTH;
  for (int i = 0; i < agents; i++) widths[n++] = RE_METRIC_TRACKER_REFRESH_WIDTH;
  widths[n++] = -1;
  mu_layout_row(ui, n, widths, RE_METRIC_TRACKER_ROW_HEIGHT);
  re_ui_label_ex(ui, "Agent", RE_UI_MUTED | RE_UI_SMALL);
  for (int i = 0; i < agents; i++) {
    const ReAgentEntry *e = &menu.agents[i];
    int opt = RE_UI_SMALL | (e->installed ? 0 : RE_UI_DISABLED) | (!strcmp(menu.agent, e->cli) ? RE_UI_ON : 0);
    if (re_ui_button_ex(ui, e->cli, RE_ICON_AGENT, opt) && e->installed) choose_agent(e->cli);
    /* An uninstalled CLI is shown and named rather than hidden, so "why is codex not there" has an
       answer on the surface instead of in a log. */
    re_app_control(a, ui, e->installed ? "tracker-agent" : "tracker-agent-missing", e->cli, tab);
  }
  re_ui_label_ex(ui, agents ? "" : !answered ? "Reading the agent menu…"
                 : *menu.error ? menu.error : "No agent CLI is installed for this project.", RE_UI_MUTED | RE_UI_SMALL);
  const ReAgentEntry *chosen = answered ? agent_named(menu.agent) : NULL;
  if (!chosen) return;
  n = 0;
  widths[n++] = RE_METRIC_TRACKER_KEY_WIDTH;
  for (int i = 0; i < chosen->model_count; i++) widths[n++] = RE_METRIC_TRACKER_STATE_WIDTH;
  if (!chosen->model_count) widths[n++] = RE_METRIC_TRACKER_STATE_WIDTH;
  widths[n++] = -1;
  mu_layout_row(ui, n, widths, RE_METRIC_TRACKER_ROW_HEIGHT);
  re_ui_label_ex(ui, "Model", RE_UI_MUTED | RE_UI_SMALL);
  for (int i = 0; i < chosen->model_count; i++) {
    const char *model = chosen->models[i];
    int opt = RE_UI_SMALL | (!strcmp(menu.model, model) ? RE_UI_ON : 0);
    if (re_ui_button_ex(ui, model, RE_ICON_UNKNOWN, opt)) {
      re_copy(menu.model, sizeof(menu.model), model);
      spawn(a, tab, key, chosen->cli, model, "task");
      return;
    }
    re_app_control(a, ui, "tracker-model", model, tab);
  }
  if (!chosen->model_count) {
    if (re_ui_button_ex(ui, "Default", RE_ICON_UNKNOWN, RE_UI_SMALL)) { spawn(a, tab, key, chosen->cli, "", "task"); return; }
    re_app_control(a, ui, "tracker-model", "default", tab);
  }
  re_ui_label_ex(ui, "The chosen model is sent with the spawn.", RE_UI_MUTED | RE_UI_SMALL);
}

static void live_rows(ReApp *a, mu_Context *ui, int tab, bool answered) {
  int count = answered ? menu.live_count : 0;
  if (!count) {
    mu_layout_row(ui, 2, (int[]){RE_METRIC_TRACKER_KEY_WIDTH, -1}, RE_METRIC_TRACKER_ROW_HEIGHT);
    re_ui_label_ex(ui, "Give to", RE_UI_MUTED | RE_UI_SMALL);
    re_ui_label_ex(ui, answered ? "No agent is live on this project." : "Reading the agent menu…", RE_UI_MUTED | RE_UI_SMALL);
    return;
  }
  for (int i = 0; i < count; i++) {
    const ReLiveEntry *e = &menu.live[i];
    mu_layout_row(ui, 3, (int[]){RE_METRIC_TRACKER_KEY_WIDTH, -RE_METRIC_TRACKER_STATE_WIDTH, -1}, RE_METRIC_TRACKER_ROW_HEIGHT);
    re_ui_label_ex(ui, i ? "" : "Give to", RE_UI_MUTED | RE_UI_SMALL);
    if (re_ui_button_ex(ui, e->label, RE_ICON_AGENT, RE_UI_SMALL | RE_UI_ALIGN_LEFT)) { hold(a, tab, e); return; }
    re_app_control(a, ui, "tracker-live", e->agent, tab);
    re_ui_label_ex(ui, e->task, RE_UI_MUTED | RE_UI_SMALL);
  }
}

static void chooser_rows(ReApp *a, mu_Context *ui, int tab, const char *key, bool answered) {
  if (menu.kind == RE_CHOOSER_NONE || strcmp(menu.task, key)) return;
  mu_push_id(ui, "chooser", 7);
  if (menu.kind == RE_CHOOSER_SPAWN) agent_rows(a, ui, tab, key, answered);
  else live_rows(a, ui, tab, answered);
  mu_pop_id(ui);
}

/* A row whose trailing pill is a fixed column reserves that column in the leading ones, or a
   negative width fills to the right edge and pushes the pill past the pane (5a0bc38). The control
   cluster reserves its own columns the same way, and a remote row reserves only Spawn's. */
static void task_row(ReApp *a, mu_Context *ui, int tab, const cJSON *task, bool local, bool answered) {
  const char *key = re_string(task, "key"), *title = re_string(task, "title");
  const cJSON *state = cJSON_GetObjectItemCaseSensitive(task, "state");
  const char *category = re_string(state, "category"), *name = re_string(state, "name");
  const char *url = re_string(task, "url");
  char working[512];
  working[0] = 0;
  bool worked = answered && working_labels(key, working, sizeof(working)) > 0;
  int cluster = RE_METRIC_TRACKER_REFRESH_WIDTH
              + (local ? RE_METRIC_TRACKER_REFRESH_WIDTH + RE_METRIC_TRACKER_STATE_WIDTH : 0);
  int trailing = cluster + RE_METRIC_TRACKER_STATE_WIDTH;
  int widths[8], n = 0;
  mu_push_id(ui, key, (int)strlen(key));
  widths[n++] = RE_METRIC_TRACKER_KEY_WIDTH;
  widths[n++] = -(trailing + (worked ? RE_METRIC_TRACKER_STATE_WIDTH : 0));
  if (worked) widths[n++] = -trailing;
  widths[n++] = RE_METRIC_TRACKER_REFRESH_WIDTH;
  if (local) { widths[n++] = RE_METRIC_TRACKER_REFRESH_WIDTH; widths[n++] = RE_METRIC_TRACKER_STATE_WIDTH; }
  widths[n++] = -1;
  mu_layout_row(ui, n, widths, RE_METRIC_TRACKER_ROW_HEIGHT);
  re_ui_label_ex(ui, key, RE_UI_MUTED | RE_UI_SMALL);
  /* Reading the list is still all the tracker does, so a row with a link opens its issue. */
  if (*url) {
    if (re_ui_button_ex(ui, title, RE_ICON_FILE, RE_UI_GHOST | RE_UI_ALIGN_LEFT)) re_app_open_url(a, url);
    re_app_control(a, ui, "tracker-open", key, tab);
  } else {
    re_ui_label_ex(ui, title, 0);
    re_app_control(a, ui, "tracker-task", key, tab);
  }
  if (worked) {
    re_ui_label_ex(ui, working, RE_UI_MUTED | RE_UI_SMALL);
    re_app_control(a, ui, "tracker-working", key, tab);
  }
  if (re_ui_button_ex(ui, "Spawn", RE_ICON_AGENT,
                      RE_UI_SMALL | RE_UI_CARET | (menu.kind == RE_CHOOSER_SPAWN && !strcmp(menu.task, key) ? RE_UI_ON : 0)))
    chooser_toggle(key, RE_CHOOSER_SPAWN);
  re_app_control(a, ui, "tracker-spawn", key, tab);
  /* Decompose writes rows into the project's own inventory, and Hold token names this workspace's
     agents on it; neither means anything on a provider whose rows live somewhere else. */
  if (local) {
    if (re_ui_button_ex(ui, "Decompose", RE_ICON_SPLIT_HORIZONTAL, RE_UI_SMALL)) {
      const ReAgentEntry *e = answered ? default_agent() : NULL;
      spawn(a, tab, key, e ? e->cli : "", preferred_model(e), "decompose");
    }
    re_app_control(a, ui, "tracker-decompose", key, tab);
    if (re_ui_button_ex(ui, "Hold token", RE_ICON_HOLLOW,
                        RE_UI_SMALL | RE_UI_CARET | (menu.kind == RE_CHOOSER_HOLD && !strcmp(menu.task, key) ? RE_UI_ON : 0)))
      chooser_toggle(key, RE_CHOOSER_HOLD);
    re_app_control(a, ui, "tracker-hold", key, tab);
  }
  re_ui_pill(ui, *name ? name : category, state_pill(category));
  chooser_rows(a, ui, tab, key, answered);
  mu_pop_id(ui);
}

void re_tracker_ui(ReApp *a, mu_Context *ui, int tab) {
  ReTab *t = &a->tabs[tab];
  char label[600];
  mu_layout_row(ui, 2, (int[]){RE_METRIC_TRACKER_REFRESH_WIDTH, -1}, RE_METRIC_TRACKER_HEADING_HEIGHT);
  /* A remote list is fetched here and only here: opening this tab or pressing Refresh, never on a
     timer. Linear spends one of a few thousand requests an hour on every poll, and GitHub answers
     an unchanged list for free only if we are not polling it needlessly in the first place. */
  if (re_ui_button_ex(ui, "Refresh", RE_ICON_UNKNOWN, RE_UI_GHOST)) { t->error[0] = 0; re_app_tracker_refresh(a, tab); }
  re_app_control(a, ui, "tracker-refresh", "", tab);
  const char *provider = t->data ? re_string(t->data, "provider") : "";
  snprintf(label, sizeof(label), "Tasks%s%s", *provider ? " · " : "", provider);
  re_ui_label_ex(ui, label, RE_UI_STRONG);

  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_TRACKER_NOTE_HEIGHT);
  if (*t->error) { re_ui_label_ex(ui, t->error, RE_UI_MUTED); return; }
  if (!t->data) { re_ui_label_ex(ui, "Reading the project's task list…", RE_UI_MUTED); return; }
  if (*re_string(t->data, "error")) { re_ui_label_ex(ui, re_string(t->data, "error"), RE_UI_MUTED); return; }

  /* The vocabulary is the backend's, not HTTP's: a missing token is denied, an unreachable service
     is unavailable, and a malformed inventory is invalid with its reasons. */
  const char *denied = re_string(t->data, "denied"), *unavailable = re_string(t->data, "unavailable");
  if (*denied) {
    re_ui_label_ex(ui, denied, RE_UI_MUTED);
    /* A provider that can be signed in to offers the button rather than naming a file to create. */
    if (*re_string(t->data, "signIn")) {
      mu_layout_row(ui, 2, (int[]){RE_METRIC_TRACKER_STATE_WIDTH, -1}, RE_METRIC_TRACKER_HEADING_HEIGHT);
      if (re_ui_button_ex(ui, "Sign in", RE_ICON_ARROW_UP, 0)) re_app_tracker_signin(a, tab);
      re_app_control(a, ui, "tracker-signin", re_string(t->data, "signIn"), tab);
      re_ui_label_ex(ui, "The browser opens; the workspace never sees your password.", RE_UI_MUTED | RE_UI_SMALL);
    }
    return;
  }
  const cJSON *invalid = cJSON_GetObjectItemCaseSensitive(t->data, "invalid");
  if (cJSON_GetArraySize(invalid)) {
    const cJSON *reason = NULL;
    cJSON_ArrayForEach(reason, invalid) {
      if (cJSON_IsString(reason)) { re_ui_label_ex(ui, reason->valuestring, RE_UI_MUTED); mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_TRACKER_NOTE_HEIGHT); }
    }
    return;
  }
  const cJSON *tasks = cJSON_GetObjectItemCaseSensitive(t->data, "rows");
  int count = cJSON_GetArraySize(tasks);
  if (*unavailable) {
    /* Cached rows still draw behind the notice: a list that vanishes when the network does is worse
       than a list that says how old it is. */
    snprintf(label, sizeof(label), "%s%s", unavailable, count ? " Showing the last list read." : "");
    re_ui_label_ex(ui, label, RE_UI_MUTED);
  } else if (!count) {
    re_ui_label_ex(ui, "This project's task list is empty.", RE_UI_MUTED);
    return;
  } else {
    bool fresh = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(t->data, "fresh"));
    const char *checked = re_string(t->data, "checkedAt");
    snprintf(label, sizeof(label), "%d task%s%s%s", count, count == 1 ? "" : "s",
             fresh ? "" : " · last read ", fresh ? "" : checked);
    re_ui_label_ex(ui, label, RE_UI_MUTED);
  }
  /* Only the local backend's rows are ours to write, so only they carry Decompose and Hold token
     (spec 103, "Surfaces"). The menu the cluster reads is this tab's root's, or none. */
  bool local = !strcmp(provider, "local");
  bool answered = menu_answers(t->root);
  const cJSON *task = NULL;
  cJSON_ArrayForEach(task, tasks) task_row(a, ui, tab, task, local, answered);
}

void re_tracker_inspect(const ReApp *a, cJSON *out) {
  (void)a;
  cJSON *j = cJSON_AddObjectToObject(out, "tracker");
  cJSON_AddBoolToObject(j, "menu", menu.known);
  cJSON_AddStringToObject(j, "rootId", menu.root);
  cJSON_AddStringToObject(j, "error", menu.error);
  cJSON *agents = cJSON_AddArrayToObject(j, "agents");
  for (int i = 0; i < menu.agent_count; i++) {
    const ReAgentEntry *e = &menu.agents[i];
    cJSON *item = cJSON_CreateObject();
    cJSON_AddStringToObject(item, "cli", e->cli);
    cJSON_AddBoolToObject(item, "installed", e->installed);
    cJSON_AddStringToObject(item, "default", e->preferred);
    cJSON *models = cJSON_AddArrayToObject(item, "models");
    for (int k = 0; k < e->model_count; k++) cJSON_AddItemToArray(models, cJSON_CreateString(e->models[k]));
    cJSON_AddItemToArray(agents, item);
  }
  cJSON *live = cJSON_AddArrayToObject(j, "live");
  for (int i = 0; i < menu.live_count; i++) {
    const ReLiveEntry *e = &menu.live[i];
    cJSON *item = cJSON_CreateObject();
    cJSON_AddStringToObject(item, "sessionId", e->session);
    cJSON_AddStringToObject(item, "label", e->label);
    cJSON_AddStringToObject(item, "agentId", e->agent);
    cJSON_AddStringToObject(item, "task", e->task);
    cJSON_AddItemToArray(live, item);
  }
  cJSON *chooser = cJSON_AddObjectToObject(j, "chooser");
  cJSON_AddStringToObject(chooser, "taskKey", menu.task);
  cJSON_AddStringToObject(chooser, "agent", menu.agent);
  cJSON_AddStringToObject(chooser, "model", menu.model);
  cJSON_AddStringToObject(chooser, "kind", menu.kind == RE_CHOOSER_SPAWN ? "spawn" : menu.kind == RE_CHOOSER_HOLD ? "hold" : "");
}
