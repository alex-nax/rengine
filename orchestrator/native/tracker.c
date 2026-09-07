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

/* A row whose trailing pill is a fixed column reserves that column in the leading ones, or a
   negative width fills to the right edge and pushes the pill past the pane (5a0bc38). */
static void task_row(ReApp *a, mu_Context *ui, int tab, const cJSON *task) {
  const char *key = re_string(task, "key"), *title = re_string(task, "title");
  const cJSON *state = cJSON_GetObjectItemCaseSensitive(task, "state");
  const char *category = re_string(state, "category"), *name = re_string(state, "name");
  const char *url = re_string(task, "url");
  mu_push_id(ui, key, (int)strlen(key));
  mu_layout_row(ui, 3, (int[]){RE_METRIC_TRACKER_KEY_WIDTH,
                               -RE_METRIC_TRACKER_STATE_WIDTH, -1}, RE_METRIC_TRACKER_ROW_HEIGHT);
  re_ui_label_ex(ui, key, RE_UI_MUTED | RE_UI_SMALL);
  /* Reading is the whole feature, so a row opens its issue and offers nothing that would write. */
  if (*url) {
    if (re_ui_button_ex(ui, title, RE_ICON_FILE, RE_UI_GHOST | RE_UI_ALIGN_LEFT)) re_app_open_url(a, url);
    re_app_control(a, ui, "tracker-open", key, tab);
  } else {
    re_ui_label_ex(ui, title, 0);
    re_app_control(a, ui, "tracker-task", key, tab);
  }
  re_ui_pill(ui, *name ? name : category, state_pill(category));
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
  const cJSON *task = NULL;
  cJSON_ArrayForEach(task, tasks) task_row(a, ui, tab, task);
}
