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
/* One row per device and one reason for it, not one reason per bound target: an unattached headset
   is a single unreachable device, not four separately disabled actions each restating it. */
static void device_row(ReApp *a, mu_Context *ui, int tab, const cJSON *device) {
  const char *id = re_string(device, "id"), *kind = re_string(device, "kind"), *title = re_string(device, "title");
  bool reachable = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(device, "reachable"));
  bool probed = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(device, "probed"));
  char label[1400]; mu_push_id(ui, id, (int)strlen(id));

  mu_layout_row(ui, 2, (int[]){-1, RE_METRIC_DEVICES_STATUS_WIDTH}, RE_METRIC_DEVICES_ROW_HEIGHT);
  snprintf(label, sizeof(label), "%s · %s", title, kind);
  re_ui_label_ex(ui, label, RE_UI_STRONG);
  re_app_control(a, ui, reachable ? "devices-reachable" : "devices-unreachable", id, tab);
  re_ui_pill(ui, reachable ? (probed ? "Reachable" : "Here") : "Unreachable", reachable ? RE_UI_PILL_OK : RE_UI_PILL_ERR);

  const cJSON *reason = cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(device, "issues"), 0);
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DEVICES_REASON_HEIGHT);
  if (cJSON_IsString(reason)) re_ui_label_ex(ui, reason->valuestring, RE_UI_MUTED);
  else re_ui_label_ex(ui, probed ? "Answered its declared probe; reachable is not launchable." : "Targets without a device run here.", RE_UI_MUTED);

  names_into(label, sizeof(label), device);
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DEVICES_REASON_HEIGHT);
  if (*label) {
    char bound[1500]; snprintf(bound, sizeof(bound), "Targets: %s", label);
    re_ui_label_ex(ui, bound, RE_UI_MUTED | RE_UI_SMALL);
  } else re_ui_label_ex(ui, "No target is bound to this device.", RE_UI_MUTED | RE_UI_SMALL);
  mu_pop_id(ui);
}
void re_devices_ui(ReApp *a, mu_Context *ui, int tab) {
  ReTab *t = &a->tabs[tab]; char label[600];
  mu_layout_row(ui, 2, (int[]){RE_METRIC_DEVICES_REFRESH_WIDTH, -1}, RE_METRIC_DEVICES_HEADING_HEIGHT);
  /* Probes run here and only here: opening this tab or pressing Refresh, never on a timer. */
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
  re_ui_label_ex(ui, "Reachability is measured by each device's own declared probe, only when this view is opened or refreshed.", RE_UI_MUTED);
  const cJSON *device = NULL;
  cJSON_ArrayForEach(device, devices) { re_ui_separator(ui); device_row(a, ui, tab, device); }
}
