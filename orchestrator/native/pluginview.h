/* Plugin tabs as workspace views (spec 106): the glue between the registry in plugin.h and the
 * tab model in app.h. A plugin view is a tab of type RE_PLUGIN whose path is the tab identity
 * "<plugin>/<key>"; it is persisted like any other view and drawn by the plugin when one is loaded. */
#ifndef RENGINE_PLUGINVIEW_H
#define RENGINE_PLUGINVIEW_H
#include "app.h"
/* What the declaring lane calls for each plugin a project declares: loads it, then opens every tab
 * it registered. The registry's index, or -1 with the refusal in the status line. */
int re_app_plugin_load(ReApp *app, const char *name, const char *path, const char *abi);
void re_plugin_view_draw(ReApp *app, ReTab *tab, ReDraw *draw);
/* Every render pass a plugin tab was given, given back. Called when the window closes or changes
   renderer, because the handles belong to the device that is going away (charter D55). */
void re_app_plugin_passes_release(ReApp *app);
/* Point the Scene tab at a model and bring it forward, loading rEngine's own scene plugin if this
   window has not yet (spec 126 decision 7). `path` is relative to `root`; false with the reason in
   the status line. An empty `path` opens the built-in procedural scene, which has no file. */
bool re_app_scene_open(ReApp *app, const char *root, const char *path);
#endif
