#include "overlays.h"
#include "ui/ui.h"
#include "editor.h"
#include "render/syntax_theme.h"
#include "theme_file.h"
#include "svg.h"

/* The surfaces that open above the panes: the settings popover, the project and pane menus, the
 * scheme dropdown and the token popover, with the theme import and export the settings row invokes.
 *
 * They live here rather than in workspace.c because they are one concept the app already names —
 * `a->overlay` holds one kind at a time (spec 080 decision 5) — and because workspace.c had grown
 * past the thousand-line rule in AGENTS.md. Four things still belong to the workspace and reach
 * this file through overlays.h: the two root lookups, the command a pane menu runs, and the close
 * every surface ends with.
 */
/* Every overlay is the same surface: a shadow, a raised ground and a frame, placed under its anchor
 * and pulled inside the window. The caller then fills it with rows. */
static bool overlay_begin(ReApp *a, mu_Context *ui, int width, int height) {
  int pad = RE_METRIC_DESIGN_PAD, gap = RE_METRIC_DESIGN_GAP;
  int x = re_min(a->overlay_anchor.x, a->width - width - pad);
  int y = a->overlay_anchor.y + a->overlay_anchor.h + gap;
  if (y + height > a->height - pad) y = re_max(pad, a->overlay_anchor.y - height - gap);
  mu_Rect rect = mu_rect(re_max(pad, x), y, width, height);
  a->overlay_rect = rect;
  mu_Container *container = mu_get_container(ui, "Overlay");
  container->rect = rect;
  /* The overlay is drawn above every pane, and input has to agree: microui routes the mouse to the
   * frontmost container, and clicking a pane brings that pane forward, which would leave the surface
   * visible but deaf. Bringing it to front each frame keeps what is on top the thing you can click. */
  mu_bring_to_front(ui, container);
  if (!mu_begin_window_ex(ui, "Overlay", rect, MU_OPT_NOTITLE | MU_OPT_NORESIZE | MU_OPT_NOCLOSE | MU_OPT_NOSCROLL | MU_OPT_NOFRAME)) return false;
  re_ui_overlay_begin();
  re_ui_popover(rect);
  return true;
}
static void overlay_end(mu_Context *ui) { re_ui_overlay_end(); mu_end_window(ui); }

/* The project menu from the menus card: the roots, the live one marked, then the add action. */
void re_overlay_roots(ReApp *a, mu_Context *ui) {
  cJSON *roots = cJSON_GetObjectItemCaseSensitive(a->state, "roots");
  int count = cJSON_GetArraySize(roots), row = RE_METRIC_DESIGN_ROW;
  int height = RE_METRIC_DESIGN_PAD * 2 + (count + 1) * (row + 2) + RE_METRIC_DESIGN_GAP * 2;
  if (!overlay_begin(a, ui, RE_METRIC_SETTINGS_WIDTH, height)) return;
  for (int i = 0; i < count; i++) {
    const cJSON *entry = cJSON_GetArrayItem(roots, i);
    const char *id = re_string(entry, "id"), *name = re_workspace_root_name(a, id);
    mu_layout_row(ui, 1, (int[]){-1}, row);
    mu_push_id(ui, id, (int)strlen(id));
    if (re_ui_menu_item(ui, name, RE_ICON_PROJECT, "", !strcmp(id, a->root))) {
      re_copy(a->root, sizeof(a->root), id); re_workspace_overlay_close(a);
    }
    re_app_control(a, ui, "menu-root", name, -1);
    mu_pop_id(ui);
  }
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DESIGN_GAP * 2);
  re_ui_menu_separator(ui);
  mu_layout_row(ui, 1, (int[]){-1}, row);
  if (re_ui_menu_item(ui, "Add project\u2026", RE_ICON_ADD, "", false)) {
    if (*a->project_input) { cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "path", a->project_input); re_app_action(a, "roots", j); cJSON_Delete(j); }
    else re_copy(a->status, sizeof(a->status), "Type a project path in the toolbar, then choose Add project.");
    re_workspace_overlay_close(a);
  }
  re_app_control(a, ui, "menu-root", "Add project", -1);
  overlay_end(ui);
}

/* The context menu from the menus card, with the shortcuts the workspace actually serves. */
void re_overlay_pane(ReApp *a, mu_Context *ui) {
  int row = RE_METRIC_DESIGN_ROW, sep = RE_METRIC_DESIGN_GAP * 2;
  int height = RE_METRIC_DESIGN_PAD * 2 + 6 * (row + 2) + 2 * sep;
  if (!overlay_begin(a, ui, RE_METRIC_SETTINGS_WIDTH, height)) return;
  struct { const char *label; int icon; const char *hint; int action; } items[] = {
    {"Split vertical", RE_ICON_SPLIT_VERTICAL, RE_SHORTCUT_SPLIT_VERTICAL, RE_COMMAND_SPLIT_VERTICAL},
    {"Split horizontal", RE_ICON_SPLIT_HORIZONTAL, RE_SHORTCUT_SPLIT_HORIZONTAL, RE_COMMAND_SPLIT_HORIZONTAL},
    {"Merge pane", RE_ICON_MERGE_PANE, RE_SHORTCUT_MERGE, RE_COMMAND_MERGE},
    {"", 0, "", -1},
    {"New shell here", RE_ICON_SHELL, RE_SHORTCUT_SHELL, RE_COMMAND_SHELL},
    {"New agent session", RE_ICON_AGENT, "", RE_COMMAND_AGENT},
    {"", 0, "", -1},
    {"Close view", RE_ICON_CLOSE, RE_SHORTCUT_CLOSE, RE_COMMAND_CLOSE_VIEW},
  };
  for (int i = 0; i < (int)(sizeof(items) / sizeof(items[0])); i++) {
    if (items[i].action < 0) { mu_layout_row(ui, 1, (int[]){-1}, sep); re_ui_menu_separator(ui); continue; }
    mu_layout_row(ui, 1, (int[]){-1}, row);
    if (re_ui_menu_item(ui, items[i].label, items[i].icon, items[i].hint, false)) {
      re_workspace_command(a, items[i].action); re_workspace_overlay_close(a);
    }
    re_app_control(a, ui, "menu-pane", items[i].label, -1);
  }
  overlay_end(ui);
}

/* Theme files: the path field resolves against the active root when it is not absolute, which is the
 * reach spec 080 allows (a project root and the workspace's own directory). */
static void theme_file_path(ReApp *a, const char *given, char *out, size_t size) {
  if (*given == '/' || (given[0] && given[1] == ':')) { snprintf(out, size, "%s", given); return; }
  const char *base = re_workspace_root_path(a, a->root);
  snprintf(out, size, "%s%s%s", base, *base ? "/" : "", given);
}
static bool theme_remembered(ReApp *a, const char *root) {
  const cJSON *themes = cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(a->state, "preferences"), "themes");
  return *re_string(themes, root) != 0;
}
static void theme_remember(ReApp *a, const char *root, const char *name) {
  cJSON *themes = cJSON_CreateObject(); cJSON_AddStringToObject(themes, root, name);
  cJSON *j = cJSON_CreateObject(); cJSON_AddItemToObject(j, "themes", themes);
  re_app_action(a, "preferences", j); cJSON_Delete(j);
}
static void theme_file_import(ReApp *a) {
  char message[256], path[2048];
  if (!*a->theme_path) { re_copy(a->status, sizeof(a->status), "Type a theme file path first."); return; }
  theme_file_path(a, a->theme_path, path, sizeof(path));
  re_theme_file_load(path, message, sizeof(message));
  float hue = re_theme_file_hue();
  if (hue >= 0) a->accent_hue = hue;
  re_copy(a->status, sizeof(a->status), message);
}
static void theme_file_export(ReApp *a) {
  char message[256], path[2048];
  if (!*a->theme_path) { re_copy(a->status, sizeof(a->status), "Type a theme file path to export to."); return; }
  theme_file_path(a, a->theme_path, path, sizeof(path));
  re_theme_file_save(path, re_theme_preset_names[a->preset], message, sizeof(message));
  re_copy(a->status, sizeof(a->status), message);
}
/* A root carries its theme at .rengine/theme.conf. The probe only reads the header, and only when
 * the popover is open, so opening a repository costs nothing. */
static void project_theme_probe(ReApp *a) {
  if (!strcmp(a->project_theme_root, a->root)) return;
  re_copy(a->project_theme_root, sizeof(a->project_theme_root), a->root);
  a->project_theme[0] = 0; a->project_theme_path[0] = 0;
  const char *base = re_workspace_root_path(a, a->root);
  if (!*base) return;
  snprintf(a->project_theme_path, sizeof(a->project_theme_path), "%s/.rengine/theme.conf", base);
  FILE *handle = fopen(a->project_theme_path, "rb");
  if (!handle) { a->project_theme_path[0] = 0; return; }
  char line[256] = {0};
  if (fgets(line, sizeof(line), handle)) {
    const char *quote = strchr(line, '"');
    const char *close = quote ? strchr(quote + 1, '"') : NULL;
    if (close) {
      size_t n = (size_t)(close - quote - 1);
      if (n >= sizeof(a->project_theme)) n = sizeof(a->project_theme) - 1;
      memcpy(a->project_theme, quote + 1, n); a->project_theme[n] = 0;
    }
  }
  fclose(handle);
  if (!*a->project_theme) a->project_theme_path[0] = 0;
}

void re_app_project_theme(ReApp *a) {
  project_theme_probe(a);
  if (!*a->project_theme || !theme_remembered(a, a->root)) return;
  char message[256];
  re_theme_file_load(a->project_theme_path, message, sizeof(message));
  float hue = re_theme_file_hue();
  if (hue >= 0) a->accent_hue = hue;
  re_copy(a->status, sizeof(a->status), message);
}

/* A select opens a list; it does not step to the next value. Cycling was a placeholder from before
 * the overlay layer existed, and it hides the choices from anyone who has not memorised them. */
static bool dropdown_open(const ReApp *a, const char *key) { return !strcmp(a->dropdown, key); }
static void dropdown_toggle(ReApp *a, mu_Context *ui, const char *key) {
  if (dropdown_open(a, key)) { a->dropdown[0] = 0; return; }
  re_copy(a->dropdown, sizeof(a->dropdown), key);
  a->dropdown_anchor = ui->last_rect;
}
static void choose_preset(ReApp *a, int index) {
  if (index < 0 || index >= RE_PRESET_COUNT) return;
  a->preset = index;
  re_draw_theme(re_draw_active(), re_theme_preset_names[index]);
  a->accent_hue = re_theme_hue();
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "theme", re_theme_preset_names[index]);
  re_app_action(a, "preferences", j); cJSON_Delete(j);
}
static void choose_scheme(ReApp *a, int index) {
  if (index < 0 || index >= RE_SCHEME_COUNT) return;
  re_copy(a->scheme, sizeof(a->scheme), re_scheme_names[index]);
  re_editor_scheme(a->scheme);
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "syntax", a->scheme);
  re_app_action(a, "preferences", j); cJSON_Delete(j);
}
static int current_scheme(const ReApp *a) {
  const char *name = *a->scheme ? a->scheme : re_scheme_names[0];
  for (int i = 0; i < RE_SCHEME_COUNT; i++) if (!strcmp(re_scheme_names[i], name)) return i;
  return 0;
}

/* The list a select opens. It is built after the surface that holds the select and recorded into the
 * same overlay buffer, so replay order puts it above; its own container is brought to front so the
 * pointer agrees with what is drawn. */
void re_overlay_dropdown(ReApp *a, mu_Context *ui) {
  bool theme = dropdown_open(a, "theme");
  int count = theme ? RE_PRESET_COUNT : RE_SCHEME_COUNT;
  int current = theme ? a->preset : current_scheme(a);
  int pad = RE_METRIC_DESIGN_PAD, row = RE_METRIC_DESIGN_ROW, gap = RE_METRIC_DESIGN_GAP;
  int height = pad + count * (row + 2);
  int width = re_max(a->dropdown_anchor.w, RE_METRIC_SETTINGS_LABEL_WIDTH);
  int x = re_min(a->dropdown_anchor.x, a->width - width - pad);
  int y = a->dropdown_anchor.y + a->dropdown_anchor.h + 2;
  if (y + height > a->height - pad) y = re_max(pad, a->dropdown_anchor.y - height - 2);
  mu_Rect rect = mu_rect(re_max(pad, x), y, width, height);
  a->dropdown_rect = rect;
  mu_Container *container = mu_get_container(ui, "Dropdown");
  container->rect = rect;
  mu_bring_to_front(ui, container);
  if (!mu_begin_window_ex(ui, "Dropdown", rect, MU_OPT_NOTITLE | MU_OPT_NORESIZE | MU_OPT_NOCLOSE | MU_OPT_NOSCROLL | MU_OPT_NOFRAME)) return;
  re_ui_overlay_resume();
  re_ui_popover(rect);
  for (int i = 0; i < count; i++) {
    const char *name = theme ? re_theme_preset_names[i] : re_scheme_names[i];
    const char *title = theme ? re_theme_preset_names[i] : re_scheme_titles[i];
    mu_layout_row(ui, 1, (int[]){-1}, row);
    mu_push_id(ui, name, (int)strlen(name));
    if (re_ui_menu_item(ui, title, theme ? RE_ICON_THEME : RE_ICON_FILE, "", i == current)) {
      if (theme) choose_preset(a, i); else choose_scheme(a, i);
      a->dropdown[0] = 0;
    }
    re_app_control(a, ui, "dropdown", name, -1);
    mu_pop_id(ui);
  }
  re_ui_overlay_end();
  mu_end_window(ui);
  (void)gap;
}

void re_overlay_settings(ReApp *a, mu_Context *ui) {
  int pad = RE_METRIC_DESIGN_PAD, row = RE_METRIC_DESIGN_CONTROL_HEIGHT, gap = RE_METRIC_DESIGN_GAP;
  int rows = 10 + (*a->project_theme ? 1 : 0);
  int height = pad * 2 + rows * (row + gap) + 4 * RE_METRIC_DESIGN_ROW;
  if (!overlay_begin(a, ui, RE_METRIC_SETTINGS_WIDTH, height)) return;
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DESIGN_ROW);
  re_ui_heading(ui, "Appearance");
  mu_layout_row(ui, 2, (int[]){RE_METRIC_SETTINGS_LABEL_WIDTH, -1}, row);
  re_ui_label_ex(ui, "Theme", RE_UI_MUTED | RE_UI_SMALL);
  if (re_ui_select_ex(ui, re_theme_preset_names[a->preset], RE_ICON_THEME,
                      RE_UI_ALIGN_LEFT | (dropdown_open(a, "theme") ? RE_UI_ON : 0))) {
    dropdown_toggle(a, ui, "theme");
  }
  re_app_control(a, ui, "settings", "theme", -1);
  mu_layout_row(ui, 2, (int[]){RE_METRIC_SETTINGS_LABEL_WIDTH, -1}, row);
  re_ui_label_ex(ui, "Syntax", RE_UI_MUTED | RE_UI_SMALL);
  if (re_ui_select_ex(ui, re_scheme_titles[current_scheme(a)], RE_ICON_FILE,
                      RE_UI_ALIGN_LEFT | (dropdown_open(a, "syntax") ? RE_UI_ON : 0))) {
    dropdown_toggle(a, ui, "syntax");
  }
  re_app_control(a, ui, "settings", "syntax", -1);
  mu_layout_row(ui, 2, (int[]){RE_METRIC_SETTINGS_LABEL_WIDTH, -1}, row);
  re_ui_label_ex(ui, "Accent", RE_UI_MUTED | RE_UI_SMALL);
  if (re_ui_hue_slider(ui, &a->accent_hue)) {
    re_theme_hue_set(a->accent_hue);
    cJSON *j = cJSON_CreateObject(); cJSON_AddNumberToObject(j, "accentHue", a->accent_hue);
    re_app_action(a, "preferences", j); cJSON_Delete(j);
  }
  re_app_control(a, ui, "settings", "accent", -1);
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DESIGN_ROW);
  re_ui_heading(ui, "Editor");
  int vim = a->vim;
  mu_layout_row(ui, 1, (int[]){-1}, row);
  if (re_ui_checkbox(ui, "Vim mode", &vim)) {
    a->vim = vim != 0;
    for (int i = 0; i < RE_TABS; i++) if (a->tabs[i].editor) re_editor_vim(a->tabs[i].editor, a->vim);
    cJSON *j = cJSON_CreateObject(); cJSON_AddBoolToObject(j, "vim", a->vim); re_app_action(a, "preferences", j); cJSON_Delete(j);
  }
  re_app_control(a, ui, "settings", "vim", -1);
  int nested = a->explorer_nested;
  mu_layout_row(ui, 1, (int[]){-1}, row);
  if (re_ui_checkbox(ui, "Expand folders in place", &nested)) {
    a->explorer_nested = nested != 0;
    cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "explorer", a->explorer_nested ? "nested" : "flat");
    re_app_action(a, "preferences", j); cJSON_Delete(j);
  }
  re_app_control(a, ui, "settings", "explorer", -1);
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_DESIGN_ROW);
  re_ui_heading(ui, "Theme file");
  mu_layout_row(ui, 1, (int[]){-1}, row);
  re_ui_textbox_ex(ui, a->theme_path, sizeof(a->theme_path), RE_ICON_FILE, "themes/sunset.conf", 0);
  re_app_control(a, ui, "settings", "theme-path", -1);
  mu_layout_row(ui, 2, (int[]){RE_METRIC_SETTINGS_WIDTH / 2 - RE_METRIC_DESIGN_PAD, -1}, row);
  if (re_ui_button_ex(ui, "Import", RE_ICON_ARROW_UP, 0)) theme_file_import(a);
  re_app_control(a, ui, "settings", "import", -1);
  if (re_ui_button_ex(ui, "Export", RE_ICON_FILE, 0)) theme_file_export(a);
  re_app_control(a, ui, "settings", "export", -1);
  project_theme_probe(a);
  if (*a->project_theme) {
    mu_layout_row(ui, 1, (int[]){-1}, row);
    char offer[128]; snprintf(offer, sizeof(offer), "Use \"%s\" from this project", a->project_theme);
    /* Offered, never applied on its own: a repository never changes the workspace's appearance
     * until someone here asks for it (charter D34). */
    if (re_ui_menu_item(ui, offer, RE_ICON_PROJECT, "", theme_remembered(a, a->root))) {
      char message[256];
      if (re_theme_file_load(a->project_theme_path, message, sizeof(message))) theme_remember(a, a->root, a->project_theme);
      re_copy(a->status, sizeof(a->status), message);
    }
    re_app_control(a, ui, "settings", "project-theme", -1);
  }
  overlay_end(ui);
}

/* The token popover hangs from the status-bar segment. The bar sits at the bottom of the window, so
 * the shared placement puts this surface above its anchor rather than below it; nothing here knows
 * that, which is the point of one overlay_begin (spec 080). */
void re_overlay_token(ReApp *a, mu_Context *ui) {
  ReProjectToken *t = &a->token;
  int pad = RE_METRIC_DESIGN_PAD, gap = RE_METRIC_DESIGN_GAP;
  int height = pad * 2 + RE_METRIC_TOKEN_HEADING_HEIGHT + RE_METRIC_TOKEN_ROW_HEIGHT + 2 * gap;
  if (t->held) height += RE_METRIC_TOKEN_ROW_HEIGHT + RE_METRIC_TOKEN_ACTION_HEIGHT + 2 * gap;
  if (t->contested) height += RE_METRIC_TOKEN_HEADING_HEIGHT + RE_METRIC_TOKEN_ROW_HEIGHT
                            + 2 * RE_METRIC_TOKEN_ACTION_HEIGHT + 4 * gap;
  if (!overlay_begin(a, ui, RE_METRIC_TOKEN_POPOVER_WIDTH, height)) return;
  re_token_ui(a, ui);
  overlay_end(ui);
}
