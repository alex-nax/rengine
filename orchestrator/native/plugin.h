/* The desktop side of the plugin ABI (spec 106): the registry that loads declared modules, checks
 * their versions, keeps their tabs and frames their drawing. It is independent of the workspace —
 * it takes a draw list and an area, not an ReApp — so the CTest exercises it headlessly against
 * real modules; the view glue is pluginview.h. Nothing else in the tree opens a module. */
#ifndef RENGINE_PLUGIN_H
#define RENGINE_PLUGIN_H
#include "plugin_abi.h"
#include "cJSON.h"
#define RE_PLUGINS_MAX 16
#define RE_PLUGIN_ABI_STRING "re-plugin/1"   /* what a declaration's `abi` must say for this desktop */
#define RE_PLUGIN_IDENTITY_MAX (RE_PLUGIN_NAME_MAX * 2 + 2)
typedef struct RePlugins RePlugins;
/* Text measurement the frame lends to a plugin: the desktop passes its font set, a test passes anything. */
typedef int (*RePluginMeasure)(void *context, uint8_t face, int size, const char *text, int length);

RePlugins *re_plugins_open(void);
void re_plugins_close(RePlugins *plugins);   /* stops every started plugin, newest first; modules stay mapped */
/* Loads one declared plugin. `abi` is the declaration's claim (RE_PLUGIN_ABI_STRING for this
 * desktop), `path` the absolute module path. The row index, or -1 with the reason in `error`.
 * Idempotent by name: a name already loaded returns its index, one already refused returns -1 with
 * the same reason, and the module is not touched again. */
int re_plugins_load(RePlugins *plugins, const char *name, const char *path, const char *abi, char *error, size_t error_size);
int re_plugins_count(const RePlugins *plugins);            /* rows, loaded and refused */
bool re_plugins_loaded(const RePlugins *plugins, int plugin);
const char *re_plugins_error(const RePlugins *plugins, int plugin);
int re_plugins_tab_count(const RePlugins *plugins, int plugin);
const char *re_plugins_tab_identity(const RePlugins *plugins, int plugin, int tab);   /* "<name>/<key>" */
const char *re_plugins_tab_title(const RePlugins *plugins, int plugin, int tab);
/* One frame of the tab named by `identity`: clips to `area`, runs the plugin's draw, resets the
 * clip. False, appending nothing, when no loaded plugin owns that identity. */
bool re_plugins_draw(RePlugins *plugins, const char *identity, ReDrawList *list, ReRect area, RePluginMeasure measure, void *context);
cJSON *re_plugins_inspect(const RePlugins *plugins);       /* the `plugins` rows of the inspected state */
const RePluginHost *re_plugins_host(void);                 /* the table every plugin receives */
#endif
