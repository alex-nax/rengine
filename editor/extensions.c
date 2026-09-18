/* The Plugins page (spec 151): what this workspace can switch on, and what state each thing is in.
 *
 * It is a PAGE about extensions, not a tab a plugin registered — those are RE_PLUGIN and they draw
 * themselves (spec 106). This view lists what a person may turn on, shows why a thing cannot be
 * turned on when it cannot, and never shows a credential.
 *
 * The toggle answers with the service's own list rather than flipping the switch locally, because a
 * refusal — no key, for instance — must leave the switch reading off. A switch that shows what the
 * click hoped for is a switch that lies. */
#include "app.h"
#include "ui/ui.h"

#include <stdio.h>
#include <string.h>

/* formatview.c keeps its own copy of this for the same reason: a number read out of a document is
   a two-line helper, not a shared API. */
static long long number_of(const cJSON *j, const char *key) {
  const cJSON *value = cJSON_GetObjectItemCaseSensitive(j, key);
  return cJSON_IsNumber(value) ? (long long)value->valuedouble : 0;
}

static void row(ReApp *a, mu_Context *ui, int tab, const cJSON *extension) {
  const char *name = re_string(extension, "name");
  const char *title = re_string(extension, "title");
  bool on = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(extension, "enabled"));
  /* Switched ON and able to WORK are different answers, and the page shows both: core owns the
     first, the plugin answers the second in its own words (spec 152 decision 6). A switch that hid
     "I have no key" behind "on" would be a switch that lies. */
  bool ready = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(extension, "ready"));
  const cJSON *detail = cJSON_GetObjectItemCaseSensitive(extension, "detail");

  mu_layout_row(ui, 2, (int[]){-RE_METRIC_DEVICES_REFRESH_WIDTH, -1}, RE_METRIC_DESIGN_ROW);
  re_ui_label_ex(ui, *title ? title : name, RE_UI_STRONG);
  mu_push_id(ui, name, (int)strlen(name));
  if (re_ui_button_ex(ui, on ? "Turn off" : "Turn on", RE_ICON_UNKNOWN, RE_UI_SMALL | (on ? RE_UI_ON : 0))) {
    re_app_extension_toggle(a, tab, name, !on);
  }
  re_app_control(a, ui, "extension-toggle", name, tab);
  mu_pop_id(ui);

  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DESIGN_ROW);
  re_ui_label_ex(ui, re_string(extension, "description"), RE_UI_MUTED | RE_UI_SMALL);

  if (on && cJSON_IsString(detail)) {
    /* The plugin's own sentence, whether it is "ready" or "no key at <path>". */
    mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DESIGN_ROW);
    re_ui_label_ex(ui, detail->valuestring, ready ? RE_UI_MUTED | RE_UI_SMALL : RE_UI_SMALL);
  }

  long long tools = number_of(extension, "tools");
  const cJSON *usage = cJSON_GetObjectItemCaseSensitive(extension, "usage");
  char line[320];
  if (on && cJSON_IsObject(usage)) {
    /* What it has cost so far. An experiment nobody can see the size of is one nobody ends. */
    snprintf(line, sizeof(line), "%lld tool%s offered to agents · %lld call%s · %lld input tokens · %s",
             tools, tools == 1 ? "" : "s",
             number_of(usage, "calls"), number_of(usage, "calls") == 1 ? "" : "s",
             number_of(usage, "inputTokens"), re_string(usage, "model"));
  } else {
    snprintf(line, sizeof(line), "%lld tool%s, offered to agents only while this is on",
             tools, tools == 1 ? "" : "s");
  }
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DESIGN_ROW);
  re_ui_label_ex(ui, line, RE_UI_MUTED | RE_UI_SMALL);
}

void re_extensions_ui(ReApp *a, mu_Context *ui, int tab) {
  ReTab *t = &a->tabs[tab];
  mu_layout_row(ui, 2, (int[]){RE_METRIC_DEVICES_REFRESH_WIDTH, -1}, RE_METRIC_DEVICES_HEADING_HEIGHT);
  if (re_ui_button_ex(ui, "Refresh", RE_ICON_REFRESH, RE_UI_GHOST)) { t->error[0] = 0; re_app_extensions_refresh(a, tab); }
  re_app_control(a, ui, "extensions-refresh", "", tab);
  re_ui_label_ex(ui, "Plugins", RE_UI_STRONG);

  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DEVICES_NOTE_HEIGHT);
  if (*t->error) { re_ui_label_ex(ui, t->error, RE_UI_MUTED); return; }
  if (!t->data) { re_ui_label_ex(ui, "Reading what this workspace can switch on…", RE_UI_MUTED); return; }
  if (*re_string(t->data, "error")) { re_ui_label_ex(ui, re_string(t->data, "error"), RE_UI_MUTED); return; }

  const cJSON *extensions = cJSON_GetObjectItemCaseSensitive(t->data, "extensions");
  if (!cJSON_GetArraySize(extensions)) {
    re_ui_label_ex(ui, "Nothing to switch on in this workspace.", RE_UI_MUTED);
    return;
  }
  re_ui_label_ex(ui, "A plugin is off until you turn it on. Its tools reach an agent only while it is on, "
                     "and what it records stays in this workspace's state directory.", RE_UI_MUTED);
  const cJSON *extension = NULL;
  cJSON_ArrayForEach(extension, extensions) { re_ui_separator(ui); row(a, ui, tab, extension); }
}
