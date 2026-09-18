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

/* One setting a plugin declared. Core draws the plugin's own label and hint, hands what a person
 * typed to the plugin's `configure`, and never reads a value back (spec 152 decision 11) — so a
 * field is CLOSED until it is opened, and opens EMPTY. That is not a shortcut: for a secret there is
 * nothing to prefill with, because nothing here ever knew the value. Replacing a key, never editing
 * one, is the only gesture the page can honestly offer.
 *
 * `set` is the plugin's own yes-or-no about whether it already has one, which is the whole of what
 * it ever says about a setting. */
static void setting(ReApp *a, mu_Context *ui, int tab, const char *plugin, const cJSON *field) {
  const char *name = re_string(field, "name");
  if (!*name) return;
  const char *label = re_string(field, "label");
  bool secret = !strcmp(re_string(field, "kind"), "secret");
  const cJSON *set = cJSON_GetObjectItemCaseSensitive(field, "set");
  char key[160];
  snprintf(key, sizeof(key), "%s/%s", plugin, name);
  bool editing = !strcmp(a->extension_field, key);

  /* The plugin's name is part of the id, not just the field's: two plugins are each allowed a
     setting called "key" without sharing one control between them. */
  mu_push_id(ui, key, (int)strlen(key));
  if (!editing) {
    char line[320];
    /* Absent is not the same as no: a plugin is asked about its settings only while it is on, so a
       switched-off plugin's field says what it is and nothing it does not know. */
    if (cJSON_IsBool(set)) {
      snprintf(line, sizeof(line), "%s · %s", *label ? label : name,
               cJSON_IsTrue(set) ? "set" : "not set");
    } else {
      re_copy(line, sizeof(line), *label ? label : name);
    }
    mu_layout_row(ui, 2, (int[]){-RE_METRIC_DEVICES_REFRESH_WIDTH, -1}, RE_METRIC_DESIGN_ROW);
    re_ui_label_ex(ui, line, RE_UI_SMALL);
    if (re_ui_button_ex(ui, cJSON_IsTrue(set) ? "Replace" : "Set", RE_ICON_UNKNOWN, RE_UI_SMALL | RE_UI_GHOST)) {
      re_copy(a->extension_field, sizeof(a->extension_field), key);
      memset(a->extension_value, 0, sizeof(a->extension_value));
    }
    re_app_control(a, ui, "extension-setting", key, tab);
    mu_pop_id(ui);
    return;
  }

  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DESIGN_ROW);
  re_ui_label_ex(ui, *label ? label : name, RE_UI_SMALL | RE_UI_STRONG);
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DEVICES_HEADING_HEIGHT);
  /* A secret draws as dots while it is typed. The buffer under it is the real one — this is what is
     sent — but nothing readable reaches the screen, a screenshot, or a spec's snapshot. */
  re_ui_textbox_ex(ui, a->extension_value, sizeof(a->extension_value), RE_ICON_FILE,
                   *label ? label : name, RE_UI_SMALL | (secret ? RE_UI_SECRET : 0));
  re_app_control(a, ui, "extension-setting-field", key, tab);
  if (cJSON_IsString(cJSON_GetObjectItemCaseSensitive(field, "detail"))) {
    mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DESIGN_ROW);
    re_ui_paragraph(ui, re_string(field, "detail"), RE_UI_MUTED | RE_UI_SMALL);
  }
  mu_layout_row(ui, 3, (int[]){RE_METRIC_DEVICES_REFRESH_WIDTH, RE_METRIC_DEVICES_REFRESH_WIDTH, -1}, RE_METRIC_DESIGN_ROW);
  /* Nothing typed is nothing to send: the button reads unavailable rather than making a round trip
     for the service to refuse. */
  bool empty = !*a->extension_value;
  if (re_ui_button_ex(ui, "Save", RE_ICON_CHECK, RE_UI_SMALL | RE_UI_PRIMARY | (empty ? RE_UI_DISABLED : 0)) && !empty) {
    re_app_extension_configure(a, tab, plugin, name, a->extension_value);
  }
  re_app_control_disabled(a, ui, "extension-setting-save", key, tab, empty);
  if (re_ui_button_ex(ui, "Cancel", RE_ICON_CLOSE, RE_UI_SMALL | RE_UI_GHOST)) {
    memset(a->extension_value, 0, sizeof(a->extension_value));
    a->extension_field[0] = 0;
  }
  re_app_control(a, ui, "extension-setting-cancel", key, tab);
  mu_pop_id(ui);
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

  /* What the plugin needs from a person, drawn whether or not it is switched on: pasting a key
     before turning something on is as reasonable as turning it on to find out one is missing. */
  const cJSON *config = cJSON_GetObjectItemCaseSensitive(extension, "config"), *field = NULL;
  cJSON_ArrayForEach(field, config) setting(a, ui, tab, name, field);

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
