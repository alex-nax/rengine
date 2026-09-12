/* rEngine plugin ABI, version 1 (docs/specs/106-plugin-abi.md; charter D38).
 *
 * The one header a plugin compiles against. It includes the draw-list contract for its value types
 * and nothing else: no microui, no SDL, no workspace header. A plugin references no desktop symbol.
 * Its single export is the entry point named below, and everything it may call arrives by pointer
 * in RePluginHost, so a module has no undefined references and the same source loads as a macOS
 * dylib, a Linux .so and a Windows DLL.
 *
 * Versioning (spec 106 decisions 1 and 3): RE_PLUGIN_ABI_VERSION moves when a struct here changes
 * shape; RE_DRAW_LIST_VERSION moves when the draw list gains a primitive. A plugin declares both in
 * its descriptor. The desktop loads it only when the ABI matches exactly and the draw list is not
 * newer than its own. The entry point's signature and the first two descriptor fields are frozen
 * for every future version, so the desktop can read them from any module before deciding. Every
 * struct carries its own `size`: a later ABI that only appends members can keep its number. */
#ifndef RENGINE_PLUGIN_ABI_H
#define RENGINE_PLUGIN_ABI_H
#include "render/draw_list.h"

#define RE_PLUGIN_ABI_VERSION 2
#define RE_PLUGIN_ENTRY_NAME "re_plugin_entry"
#define RE_PLUGIN_NAME_MAX 32   /* bytes in a plugin name or a tab key: [a-z0-9-], never empty */
#define RE_PLUGIN_TABS_MAX 8    /* tabs one plugin may register */

#if defined(_WIN32)
#define RE_PLUGIN_EXPORT __declspec(dllexport)
#else
#define RE_PLUGIN_EXPORT __attribute__((visibility("default")))
#endif

typedef struct RePlugin RePlugin;             /* the loaded instance, owned by the desktop */
/* The render extension (charter D55, spec 126). Opaque here on purpose: its definition needs the
 * pack's seam header, and a plugin that only draws should not have to find that include path. A
 * plugin that renders includes plugin_render.h, which defines this and nothing else. */
typedef struct RePluginRender RePluginRender;
typedef struct RePluginFrame RePluginFrame;   /* one tab during one frame, owned by the desktop */
typedef struct RePluginHost RePluginHost;

/* A tab a plugin registers during start. `key` is stable within the plugin; the tab's identity in
 * the workspace layout is "<plugin name>/<key>". `title` is copied. `draw` runs every frame the
 * tab is visible, on the desktop's thread, with the clip already set to the tab's area. */
/* The pointer, while it is inside this plugin's own tab (charter D55). Coordinates are logical
 * pixels with the origin at the area's top-left, so a plugin never needs to know where its tab is.
 * When `inside` is false nothing else here is meaningful: the pointer is over another tab, and D55
 * grants a plugin nothing about those. Wheel is steps since the plugin's previous frame. */
enum { RE_PLUGIN_BUTTON_LEFT = 1 << 0, RE_PLUGIN_BUTTON_RIGHT = 1 << 1, RE_PLUGIN_BUTTON_MIDDLE = 1 << 2 };
typedef struct RePluginPointer {
  uint32_t size;                                        /* sizeof(RePluginPointer) */
  bool inside;                                          /* the pointer is within this tab's area */
  bool focused;                                         /* this tab has the window's focus */
  int x, y;                                             /* relative to the area's top-left */
  uint8_t buttons;                                      /* RE_PLUGIN_BUTTON_* currently held */
  float wheel_x, wheel_y;
} RePluginPointer;

typedef struct RePluginTab {
  uint32_t size;                                        /* sizeof(RePluginTab) */
  const char *key;
  const char *title;
  void (*draw)(RePluginFrame *frame, void *state);
} RePluginTab;

/* What re_plugin_entry returns: static storage the plugin never frees. The entry point does nothing
 * else. The first two fields are read before anything else and keep their offsets in every version. */
typedef struct RePluginDesc {
  uint32_t size;                                        /* sizeof(RePluginDesc) — frozen */
  uint32_t abi_version;                                 /* RE_PLUGIN_ABI_VERSION — frozen */
  uint32_t draw_list_version;                           /* RE_DRAW_LIST_VERSION compiled against */
  const char *name;                                     /* must equal the declaration's name */
  const char *version;                                  /* the plugin's own; informational */
  bool (*start)(RePlugin *self, const RePluginHost *host, void **state);   /* register tabs; false declines */
  void (*stop)(RePlugin *self, void *state);            /* the window is closing; the module stays mapped */
} RePluginDesc;

/* Everything a plugin may do. The pointer stays valid for the plugin's lifetime. Drawing calls
 * append to the frame's draw list and return false when the list refused the command (overflow).
 * Geometry is logical pixels and colours straight-alpha RGBA8, as in draw_list.h. Nothing here
 * reaches the store, a session or the host connection: that is outside D38's grant. */
struct RePluginHost {
  uint32_t size;                                        /* sizeof(RePluginHost): read members within it only */
  uint32_t abi_version;                                 /* the desktop's RE_PLUGIN_ABI_VERSION */
  uint32_t draw_list_version;                           /* the desktop's RE_DRAW_LIST_VERSION */
  bool (*register_tab)(RePlugin *self, const RePluginTab *tab);   /* accepted only during start */
  ReRect (*area)(const RePluginFrame *frame);           /* the tab's content rectangle this frame */
  bool (*rect)(RePluginFrame *frame, ReRect rect, ReColor color);
  bool (*rrect)(RePluginFrame *frame, ReRect rect, ReColor color, float radius, uint8_t corners);
  bool (*frame)(RePluginFrame *frame, ReRect rect, ReColor border, ReColor highlight, float radius);
  bool (*shadow)(RePluginFrame *frame, ReRect rect, ReColor color, float radius, int width);
  bool (*ring)(RePluginFrame *frame, ReRect rect, ReColor color, float radius, int width);
  bool (*text)(RePluginFrame *frame, uint8_t face, int size, int x, int y, ReColor color, const char *text, int length);
  bool (*icon)(RePluginFrame *frame, uint8_t icon, int size, ReRect rect, ReColor color);
  bool (*gradient)(RePluginFrame *frame, ReRect rect, ReColor from, ReColor to, float radius, uint8_t corners, uint8_t axis);
  bool (*clip)(RePluginFrame *frame, const ReRect *rect);   /* intersected with the area; NULL restores the area */
  int (*text_width)(const RePluginFrame *frame, uint8_t face, int size, const char *text, int length); /* -1 measures to the NUL */
  bool (*colour)(const RePluginFrame *frame, const char *token, ReColor *out);   /* a live theme token by name, e.g. "--ui-fg" */
  /* ABI 2, charter D55. Both are frame-scoped and tab-scoped; see plugin_render.h for the first. */
  const RePluginRender *(*render)(RePluginFrame *frame);  /* NULL in a frame that cannot render */
  bool (*pointer)(const RePluginFrame *frame, RePluginPointer *out);
  /* What the desktop opened this tab FOR: the workspace-relative path of the file, or "" when the
   * tab has no file. A tab's own parameter and nothing more -- it reaches no store and names no
   * other view, so it stays inside D38. F136 needs it because decision 7 opens a Scene tab from an
   * .obj in the explorer, and tabs are registered at start, so the file cannot be one. */
  const char *(*subject)(const RePluginFrame *frame);
};

typedef const RePluginDesc *(*RePluginEntry)(void);
#endif
