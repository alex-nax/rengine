/* A module that is not a plugin: it exports a symbol, just not the entry point (spec 106). */
#include "plugin_abi.h"
RE_PLUGIN_EXPORT int re_not_a_plugin(void) { return RE_PLUGIN_ABI_VERSION; }
