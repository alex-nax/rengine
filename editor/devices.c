#include "devices.h"

static void names_into(char *out, size_t size, const cJSON *device) {
  const char *keys[] = {"games", "actions"}; size_t used = 0; out[0] = 0;
  for (int k = 0; k < 2; k++) {
    const cJSON *item = NULL;
    cJSON_ArrayForEach(item, cJSON_GetObjectItemCaseSensitive(device, keys[k])) {
      if (!cJSON_IsString(item)) continue;
      int written = snprintf(out + used, size - used, "%s%s", used ? ", " : "", item->valuestring);
      if (written < 0 || (size_t)written >= size - used) return;
      used += (size_t)written;
    }
  }
}
/* Every reason the section draws is recorded under one role, so the surface argument for the whole
   feature is checkable: an unreachable device shows its reason once, not once per bound target. */
static void reason_row(ReApp *a, mu_Context *ui, int tab, const char *text, int opt) {
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DEVICES_REASON_HEIGHT);
  re_ui_label_ex(ui, text, opt);
  re_app_control(a, ui, "devices-reason", text, tab);
}
/* A row whose trailing pill is a fixed column reserves that column in the leading one: a negative
   width fills to the right edge, so a leading -1 would push the pill past the pane (5a0bc38). */
static void meta_row(mu_Context *ui) {
  mu_layout_row(ui, 2, (int[]){-RE_METRIC_DEVICES_KIND_WIDTH, -1}, RE_METRIC_DEVICES_ROW_HEIGHT);
}
/* One bound dashboard action, run through the dashboard's own route: a script opened here lands in
   a script tab exactly as it does from the Dashboard, and no availability is decided locally. */
static void action_row(ReApp *a, mu_Context *ui, int tab, const cJSON *action) {
  const char *id = re_string(action, "id"), *kind = re_string(action, "kind");
  bool available = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(action, "available"));
  const cJSON *missing = cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(action, "missing"), 0);
  const char *type = re_string(missing, "type"), *name = re_string(missing, "name");
  char key[600], label[1400];
  snprintf(key, sizeof(key), "action:%s", id); mu_push_id(ui, key, (int)strlen(key));
  meta_row(ui);
  if (available) {
    if (re_ui_button_ex(ui, re_string(action, "title"), RE_ICON_RUN, RE_UI_ALIGN_LEFT))
      re_app_dashboard_run(a, tab, id, !strcmp(kind, "capture"));
    re_app_control(a, ui, "devices-action", id, tab);
  } else {
    re_ui_button_ex(ui, re_string(action, "title"), RE_ICON_RUN, RE_UI_ALIGN_LEFT | RE_UI_DISABLED);
    re_app_control(a, ui, "devices-unavailable", id, tab);
  }
  re_ui_pill(ui, kind, available ? RE_UI_PILL_INFO : RE_UI_PILL_NEUTRAL);
  re_app_control(a, ui, "devices-meta", id, tab);
  /* The device's reason is on the row above, once. A control blocked only by the device restates
     nothing; one blocked by its own prerequisite names it, as the dashboard tab does. */
  if (!available && strcmp(type, "device")) {
    if (!strcmp(type, "game")) snprintf(label, sizeof(label), "Unavailable: %s", name);
    else snprintf(label, sizeof(label), "Unavailable: missing %s %s", type, name);
    reason_row(a, ui, tab, label, RE_UI_MUTED | RE_UI_SMALL);
  }
  mu_pop_id(ui);
}
/* A bound game reports the preflight the launch itself uses. It carries no launch control: rEngine
   launches a game only through a declared dashboard action of kind game, which is one of the
   controls above when the declaration binds one here (spec 082, "Controls on the device"). */
static void target_row(ReApp *a, mu_Context *ui, int tab, const cJSON *target) {
  const char *id = re_string(target, "id"), *issue = re_string(target, "issue"), *location = re_string(target, "location");
  bool ready = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(target, "ready"));
  bool remote = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(target, "remote"));
  char key[600], label[1400];
  snprintf(key, sizeof(key), "game:%s", id); mu_push_id(ui, key, (int)strlen(key));
  meta_row(ui);
  snprintf(label, sizeof(label), "%s · game", re_string(target, "title"));
  re_ui_label_ex(ui, label, 0);
  re_app_control(a, ui, "devices-game", id, tab);
  re_ui_pill(ui, !ready ? "Blocked" : remote ? "Runs there" : "Ready",
             !ready ? RE_UI_PILL_ERR : remote ? RE_UI_PILL_INFO : RE_UI_PILL_OK);
  re_app_control(a, ui, "devices-meta", id, tab);
  if (!ready && *issue) reason_row(a, ui, tab, issue, RE_UI_MUTED | RE_UI_SMALL);
  else if (remote && *location) reason_row(a, ui, tab, location, RE_UI_MUTED | RE_UI_SMALL);
  mu_pop_id(ui);
}
/* One row per device and one reason for it, not one reason per bound target: an unattached headset
   is a single unreachable device, not four separately disabled actions each restating it. */
static void device_row(ReApp *a, mu_Context *ui, int tab, const cJSON *device) {
  const char *id = re_string(device, "id"), *kind = re_string(device, "kind"), *title = re_string(device, "title");
  bool reachable = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(device, "reachable"));
  bool probed = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(device, "probed"));
  char label[1400]; mu_push_id(ui, id, (int)strlen(id));

  mu_layout_row(ui, 2, (int[]){-RE_METRIC_DEVICES_STATUS_WIDTH, -1}, RE_METRIC_DEVICES_ROW_HEIGHT);
  snprintf(label, sizeof(label), "%s · %s", title, kind);
  re_ui_label_ex(ui, label, RE_UI_STRONG);
  re_app_control(a, ui, reachable ? "devices-reachable" : "devices-unreachable", id, tab);
  re_ui_pill(ui, reachable ? (probed ? "Reachable" : "Here") : "Unreachable", reachable ? RE_UI_PILL_OK : RE_UI_PILL_ERR);
  re_app_control(a, ui, "devices-status", id, tab);

  const cJSON *reason = cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(device, "issues"), 0);
  if (cJSON_IsString(reason)) reason_row(a, ui, tab, reason->valuestring, RE_UI_MUTED);
  else reason_row(a, ui, tab, probed ? "Answered its declared probe; reachable is not launchable." : "Targets without a device run here.", RE_UI_MUTED);

  const cJSON *controls = cJSON_GetObjectItemCaseSensitive(device, "controls");
  const cJSON *targets = cJSON_GetObjectItemCaseSensitive(device, "targets");
  const cJSON *item = NULL;
  /* A workspace layer that predates the controls still lists what is bound, by name (spec 065). */
  if (!cJSON_IsArray(controls) && !cJSON_IsArray(targets)) {
    names_into(label, sizeof(label), device);
    mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DEVICES_REASON_HEIGHT);
    if (*label) { char bound[1500]; snprintf(bound, sizeof(bound), "Targets: %s", label); re_ui_label_ex(ui, bound, RE_UI_MUTED | RE_UI_SMALL); }
    else re_ui_label_ex(ui, "No target is bound to this device.", RE_UI_MUTED | RE_UI_SMALL);
  } else if (!cJSON_GetArraySize(controls) && !cJSON_GetArraySize(targets)) {
    reason_row(a, ui, tab, "No target is bound to this device.", RE_UI_MUTED | RE_UI_SMALL);
  } else {
    cJSON_ArrayForEach(item, controls) action_row(a, ui, tab, item);
    cJSON_ArrayForEach(item, targets) target_row(a, ui, tab, item);
  }
  mu_pop_id(ui);
}
void re_devices_ui(ReApp *a, mu_Context *ui, int tab) {
  ReTab *t = &a->tabs[tab]; char label[600];
  mu_layout_row(ui, 2, (int[]){RE_METRIC_DEVICES_REFRESH_WIDTH, -1}, RE_METRIC_DEVICES_HEADING_HEIGHT);
  /* Probes run here and only here: opening this tab or pressing Refresh, never on a timer and
     never as a side effect of drawing a control. */
  if (re_ui_button_ex(ui, "Refresh", RE_ICON_UNKNOWN, RE_UI_GHOST)) { t->error[0] = 0; re_app_devices_refresh(a, tab); }
  re_app_control(a, ui, "devices-refresh", "", tab);
  snprintf(label, sizeof(label), "Devices%s", *t->error ? " · " : "");
  re_ui_label_ex(ui, label, RE_UI_STRONG);
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DEVICES_NOTE_HEIGHT);
  if (*t->error) { re_ui_label_ex(ui, t->error, RE_UI_MUTED); return; }
  if (!t->data) { re_ui_label_ex(ui, "Probing declared devices…", RE_UI_MUTED); return; }
  if (*re_string(t->data, "error")) { re_ui_label_ex(ui, re_string(t->data, "error"), RE_UI_MUTED); return; }
  if (!cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(t->data, "declared"))) {
    re_ui_label_ex(ui, "This project declares nothing in .rengine/project.json.", RE_UI_MUTED); return;
  }
  const cJSON *devices = cJSON_GetObjectItemCaseSensitive(t->data, "devices");
  if (!cJSON_GetArraySize(devices)) { re_ui_label_ex(ui, "This project declares no devices (.rengine/project.json, contract 4).", RE_UI_MUTED); return; }
  re_ui_label_ex(ui, "Probed only when this view is opened or refreshed; a bound action runs here exactly as it does on the dashboard.", RE_UI_MUTED);
  const cJSON *device = NULL;
  cJSON_ArrayForEach(device, devices) { re_ui_separator(ui); device_row(a, ui, tab, device); }
}
