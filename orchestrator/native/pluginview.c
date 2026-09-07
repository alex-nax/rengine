#include "pluginview.h"

static int measure(void *context, uint8_t face, int size, const char *text, int length) {
  return re_draw_text_width(context, face, size, text, length);
}
int re_app_plugin_load(ReApp *a, const char *name, const char *path, const char *abi) {
  char error[512];
  int index = re_plugins_load(a->plugins, name, path, abi, error, sizeof(error));
  if (index < 0) { snprintf(a->status, sizeof(a->status), "Plugin refused: %s", error); return -1; }
  for (int k = 0; k < re_plugins_tab_count(a->plugins, index); k++)
    re_app_tab(a, RE_PLUGIN, "", re_plugins_tab_identity(a->plugins, index, k), "", re_plugins_tab_title(a->plugins, index, k));
  return index;
}
/* A restored tab whose plugin is not loaded in this window says so rather than drawing nothing:
 * the layout keeps the view, the module arrives when the declaration does (spec 106 decision 10). */
void re_plugin_view_draw(ReApp *a, ReTab *t, ReDraw *draw) {
  ReRect area = re_rect(t->rect.x, t->rect.y, t->rect.w, t->rect.h);
  if (re_plugins_draw(a->plugins, t->path, re_draw_list(draw), area, measure, draw)) return;
  char text[192]; snprintf(text, sizeof(text), "Plugin view %s is not loaded in this window.", t->path);
  re_draw_text_face(draw, RE_FACE_UI, RE_METRIC_DESIGN_SIZE, text, -1, t->rect.x + RE_METRIC_DESIGN_PAD, t->rect.y + RE_METRIC_DESIGN_PAD, RE_COLOR_TEXT_MUTED);
}
