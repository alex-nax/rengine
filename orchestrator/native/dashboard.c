#include "dashboard.h"

static void action_row(ReApp *a, mu_Context *ui, int tab, const cJSON *action) {
  ReTab *t = &a->tabs[tab]; const char *id = re_string(action, "id"), *kind = re_string(action, "kind"), *description = re_string(action, "description");
  bool available = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(action, "available")), capture = !strcmp(kind, "capture");
  char label[1400]; mu_push_id(ui, id, (int)strlen(id));
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DASHBOARD_ROW_HEIGHT);
  if (available) {
    if (mu_button_ex(ui, re_string(action, "title"), 0, 0)) re_app_dashboard_run(a, tab, id, capture);
    re_app_control(a, ui, "dashboard-action", id, tab);
  } else {
    const cJSON *missing = cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(action, "missing"), 0);
    snprintf(label, sizeof(label), "%s — unavailable: missing %s %s", re_string(action, "title"), re_string(missing, "type"), re_string(missing, "name"));
    mu_label(ui, label); re_app_control(a, ui, "dashboard-unavailable", id, tab);
  }
  snprintf(label, sizeof(label), "%s%s%s", kind, *description ? " · " : "", description);
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DASHBOARD_DESCRIPTION_HEIGHT); mu_label(ui, label);
  const cJSON *artifact = NULL;
  cJSON_ArrayForEach(artifact, cJSON_GetObjectItemCaseSensitive(action, "artifacts")) {
    if (!cJSON_IsString(artifact)) continue;
    snprintf(label, sizeof(label), "Reveal %s", artifact->valuestring);
    mu_layout_row(ui, 2, (int[]){RE_METRIC_DASHBOARD_ARTIFACT_WIDTH, -1}, RE_METRIC_DASHBOARD_ROW_HEIGHT); mu_push_id(ui, artifact->valuestring, (int)strlen(artifact->valuestring));
    if (mu_button_ex(ui, label, 0, 0)) re_app_reveal(a, t->root, artifact->valuestring);
    re_app_control(a, ui, "dashboard-artifact", artifact->valuestring, tab); mu_label(ui, "artifact"); mu_pop_id(ui);
  }
  mu_pop_id(ui);
}
void re_dashboard_ui(ReApp *a, mu_Context *ui, int tab) {
  ReTab *t = &a->tabs[tab]; char label[600];
  mu_layout_row(ui, 2, (int[]){RE_METRIC_DASHBOARD_REFRESH_WIDTH, -1}, RE_METRIC_DASHBOARD_HEADING_HEIGHT);
  if (mu_button(ui, "Refresh")) { t->error[0] = 0; re_app_load(a, tab); }
  re_app_control(a, ui, "dashboard-refresh", "", tab);
  const char *title = t->data ? re_string(t->data, "title") : "";
  snprintf(label, sizeof(label), "%s%s", *title ? title : "Dashboard", *t->error ? " · " : ""); mu_label(ui, label);
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DASHBOARD_NOTE_HEIGHT);
  if (*t->error) { mu_label(ui, t->error); return; }
  if (!t->data) { mu_label(ui, "Loading dashboard…"); return; }
  if (*re_string(t->data, "error")) { mu_label(ui, re_string(t->data, "error")); return; }
  if (!cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(t->data, "declared"))) { mu_label(ui, "This project declares no dashboard (.rengine/project.json, contract 2)."); return; }
  const cJSON *groups = cJSON_GetObjectItemCaseSensitive(t->data, "groups");
  if (!cJSON_GetArraySize(groups)) { mu_label(ui, "This project declares no dashboard groups."); return; }
  mu_label(ui, "Actions run only when clicked; unavailable actions name what is missing.");
  const cJSON *group = NULL, *action = NULL;
  cJSON_ArrayForEach(group, groups) {
    const char *gid = re_string(group, "id"); mu_push_id(ui, gid, (int)strlen(gid));
    mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DASHBOARD_HEADING_HEIGHT); mu_label(ui, re_string(group, "title"));
    cJSON_ArrayForEach(action, cJSON_GetObjectItemCaseSensitive(group, "actions")) action_row(a, ui, tab, action);
    mu_pop_id(ui);
  }
}
