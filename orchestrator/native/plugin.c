#include "plugin.h"
#include "theme.h"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif

typedef struct { char identity[RE_PLUGIN_IDENTITY_MAX]; char title[64]; void (*draw)(RePluginFrame *, void *); } ReTabRecord;
struct RePlugin {
  bool used, loaded, starting, called;   /* called: start ran, so the module is never unmapped */
  char name[RE_PLUGIN_NAME_MAX + 1], path[1024], version[64], error[512];
  void *module; const RePluginDesc *desc; void *state;
  ReTabRecord tabs[RE_PLUGIN_TABS_MAX]; int tab_count;
};
struct RePlugins { RePlugin rows[RE_PLUGINS_MAX]; int count; };
struct RePluginFrame { ReDrawList *list; ReRect area; RePluginMeasure measure; void *context; };

/* --- the one platform wrapper (spec 106 decision 14) --- */
static void *module_open(const char *path, char *reason, size_t size) {
#ifdef _WIN32
  HMODULE module = LoadLibraryA(path);
  if (!module) snprintf(reason, size, "LoadLibrary error %lu", (unsigned long)GetLastError());
  return module;
#else
  void *module = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!module) { const char *text = dlerror(); snprintf(reason, size, "%s", text ? text : "dlopen failed"); }
  return module;
#endif
}
static RePluginEntry module_entry(void *module) {
  RePluginEntry entry = NULL;
#ifdef _WIN32
  FARPROC symbol = GetProcAddress((HMODULE)module, RE_PLUGIN_ENTRY_NAME);
#else
  void *symbol = dlsym(module, RE_PLUGIN_ENTRY_NAME);
#endif
  if (symbol) memcpy(&entry, &symbol, sizeof(entry));   /* ISO C has no object-to-function cast */
  return entry;
}
static void module_release(void *module) {
  if (!module) return;
#ifdef _WIN32
  FreeLibrary((HMODULE)module);
#else
  dlclose(module);
#endif
}

static bool valid_name(const char *s) {
  size_t n = s ? strlen(s) : 0;
  if (!n || n > RE_PLUGIN_NAME_MAX) return false;
  for (; *s; s++) if (!((*s >= 'a' && *s <= 'z') || (*s >= '0' && *s <= '9') || *s == '-')) return false;
  return true;
}
static bool absolute(const char *path) {
  if (!path || !*path) return false;
#ifdef _WIN32
  bool drive = ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) && path[1] == ':' && (path[2] == '\\' || path[2] == '/');
  return drive || (path[0] == '\\' && path[1] == '\\');
#else
  return path[0] == '/';
#endif
}

/* --- the host table --- */
static bool host_register_tab(RePlugin *p, const RePluginTab *t) {
  if (!p || !p->starting || !t || t->size < sizeof(RePluginTab) || !t->draw || !valid_name(t->key) || !t->title || !*t->title) return false;
  if (p->tab_count >= RE_PLUGIN_TABS_MAX) return false;
  char identity[RE_PLUGIN_IDENTITY_MAX]; snprintf(identity, sizeof(identity), "%s/%s", p->name, t->key);
  for (int i = 0; i < p->tab_count; i++) if (!strcmp(p->tabs[i].identity, identity)) return false;
  ReTabRecord *r = &p->tabs[p->tab_count++];
  snprintf(r->identity, sizeof(r->identity), "%s", identity); snprintf(r->title, sizeof(r->title), "%s", t->title); r->draw = t->draw;
  return true;
}
static ReRect intersect(ReRect a, ReRect b) {
  int x0 = a.x > b.x ? a.x : b.x, y0 = a.y > b.y ? a.y : b.y;
  int x1 = a.x + a.w < b.x + b.w ? a.x + a.w : b.x + b.w, y1 = a.y + a.h < b.y + b.h ? a.y + a.h : b.y + b.h;
  return re_rect(x0, y0, x1 > x0 ? x1 - x0 : 0, y1 > y0 ? y1 - y0 : 0);
}
static ReRect host_area(const RePluginFrame *f) { return f->area; }
static bool host_rect(RePluginFrame *f, ReRect r, ReColor c) { return re_draw_list_rect(f->list, r, c); }
static bool host_rrect(RePluginFrame *f, ReRect r, ReColor c, float radius, uint8_t corners) { return re_draw_list_rrect(f->list, r, c, radius, corners); }
static bool host_frame(RePluginFrame *f, ReRect r, ReColor border, ReColor highlight, float radius) { return re_draw_list_frame(f->list, r, border, highlight, radius); }
static bool host_shadow(RePluginFrame *f, ReRect r, ReColor c, float radius, int width) { return re_draw_list_shadow(f->list, r, c, radius, width); }
static bool host_ring(RePluginFrame *f, ReRect r, ReColor c, float radius, int width) { return re_draw_list_ring(f->list, r, c, radius, width); }
static bool host_text(RePluginFrame *f, uint8_t face, int size, int x, int y, ReColor c, const char *text, int length) {
  return text && re_draw_list_text(f->list, face, size, x, y, c, text, length);
}
static bool host_icon(RePluginFrame *f, uint8_t icon, int size, ReRect r, ReColor c) { return re_draw_list_icon(f->list, icon, size, r, c); }
static bool host_gradient(RePluginFrame *f, ReRect r, ReColor from, ReColor to, float radius, uint8_t corners, uint8_t axis) {
  return re_draw_list_gradient(f->list, r, from, to, radius, corners, axis);
}
/* A plugin's clip can only narrow its own area (spec 106 decision 11). */
static bool host_clip(RePluginFrame *f, const ReRect *r) { ReRect c = r ? intersect(*r, f->area) : f->area; return re_draw_list_clip(f->list, &c); }
static int host_text_width(const RePluginFrame *f, uint8_t face, int size, const char *text, int length) {
  return f->measure && text ? f->measure(f->context, face, size, text, length) : 0;
}
/* By token name, against the live theme (decision 9): presets, theme files and the accent hue all
 * reach a plugin through the same table the desktop's own colours come from. */
static bool host_colour(const RePluginFrame *f, const char *token, ReColor *out) {
  (void)f; if (!token || !out) return false;
  const mu_Color *colors = (const mu_Color *)&re_theme;
  for (int i = 0; i < RE_THEME_COLOR_COUNT; i++) if (!strcmp(re_theme_field_tokens[i], token)) { *out = re_color(colors[i].r, colors[i].g, colors[i].b, colors[i].a); return true; }
  return false;
}
static const RePluginHost host = {
  (uint32_t)sizeof(RePluginHost), RE_PLUGIN_ABI_VERSION, RE_DRAW_LIST_VERSION,
  host_register_tab, host_area, host_rect, host_rrect, host_frame, host_shadow, host_ring, host_text, host_icon, host_gradient,
  host_clip, host_text_width, host_colour,
};
const RePluginHost *re_plugins_host(void) { return &host; }

/* --- the registry --- */
RePlugins *re_plugins_open(void) { return calloc(1, sizeof(RePlugins)); }
void re_plugins_close(RePlugins *ps) {
  if (!ps) return;
  for (int i = ps->count - 1; i >= 0; i--) {
    RePlugin *p = &ps->rows[i];
    if (p->loaded && p->desc) p->desc->stop(p, p->state);
    p->loaded = false;   /* the module stays mapped: decision 12 */
  }
  free(ps);
}
/* Records the reason on the row and hands it back. A module nothing has called into is unmapped
 * again; one whose start ran stays mapped, because it may have left threads or handlers behind. */
static int refuse(RePlugin *p, char *error, size_t size, const char *format, ...) {
  va_list args; va_start(args, format); vsnprintf(p->error, sizeof(p->error), format, args); va_end(args);
  if (error && size) snprintf(error, size, "%s", p->error);
  if (!p->called) { module_release(p->module); p->module = NULL; }
  p->desc = NULL; p->tab_count = 0; return -1;
}
int re_plugins_load(RePlugins *ps, const char *name, const char *path, const char *abi, char *error, size_t size) {
  if (error && size) error[0] = 0;
  if (!ps) return -1;
  char key[RE_PLUGIN_NAME_MAX + 1]; snprintf(key, sizeof(key), "%.*s", RE_PLUGIN_NAME_MAX, name && *name ? name : "(unnamed)");
  for (int i = 0; i < ps->count; i++) {
    RePlugin *p = &ps->rows[i];
    if (strcmp(p->name, key)) continue;
    if (p->loaded) return i;
    if (error && size) snprintf(error, size, "%s", p->error);
    return -1;
  }
  if (ps->count >= RE_PLUGINS_MAX) { if (error && size) snprintf(error, size, "plugin %s: this window holds at most %d plugins", key, RE_PLUGINS_MAX); return -1; }
  RePlugin *p = &ps->rows[ps->count++]; memset(p, 0, sizeof(*p)); p->used = true;
  snprintf(p->name, sizeof(p->name), "%s", key); snprintf(p->path, sizeof(p->path), "%s", path ? path : "");
  if (!valid_name(name)) return refuse(p, error, size, "plugin '%s': a name is 1-%d characters of [a-z0-9-]", key, RE_PLUGIN_NAME_MAX);
  /* The declaration's claim is checked before the file is touched (decision 4). */
  if (!abi || strcmp(abi, RE_PLUGIN_ABI_STRING))
    return refuse(p, error, size, "plugin %s declares ABI '%s'; this desktop is %s, so %s was not opened", key, abi ? abi : "", RE_PLUGIN_ABI_STRING, p->path);
  if (!absolute(p->path)) return refuse(p, error, size, "plugin %s: module path '%s' is not absolute", key, p->path);
  char reason[256];
  p->module = module_open(p->path, reason, sizeof(reason));
  if (!p->module) return refuse(p, error, size, "plugin %s: cannot open %s: %s", key, p->path, reason);
  RePluginEntry entry = module_entry(p->module);
  if (!entry) return refuse(p, error, size, "plugin %s: %s exports no %s", key, p->path, RE_PLUGIN_ENTRY_NAME);
  const RePluginDesc *d = entry();
  if (!d || d->size < 2 * sizeof(uint32_t)) return refuse(p, error, size, "plugin %s: %s returned no descriptor", key, p->path);
  if (d->abi_version != RE_PLUGIN_ABI_VERSION)
    return refuse(p, error, size, "plugin %s: %s was built against plugin ABI %u; this desktop is ABI %u", key, p->path, (unsigned)d->abi_version, (unsigned)RE_PLUGIN_ABI_VERSION);
  if (d->size < sizeof(RePluginDesc))
    return refuse(p, error, size, "plugin %s: %s carries a %u-byte descriptor; ABI %u needs %u", key, p->path, (unsigned)d->size, (unsigned)RE_PLUGIN_ABI_VERSION, (unsigned)sizeof(RePluginDesc));
  if (d->draw_list_version < 1 || d->draw_list_version > RE_DRAW_LIST_VERSION)
    return refuse(p, error, size, "plugin %s: %s was built against draw list %u; this desktop is draw list %u", key, p->path, (unsigned)d->draw_list_version, (unsigned)RE_DRAW_LIST_VERSION);
  if (!d->name || strcmp(d->name, key)) return refuse(p, error, size, "plugin %s: %s calls itself '%s'", key, p->path, d->name ? d->name : "");
  if (!d->start || !d->stop) return refuse(p, error, size, "plugin %s: %s has no start or stop", key, p->path);
  p->desc = d; snprintf(p->version, sizeof(p->version), "%s", d->version ? d->version : "");
  p->called = p->starting = true;
  bool started = d->start(p, &host, &p->state);
  p->starting = false;
  if (!started) { p->state = NULL; return refuse(p, error, size, "plugin %s: %s declined to start", key, p->path); }
  p->loaded = true;
  return (int)(p - ps->rows);
}
int re_plugins_count(const RePlugins *ps) { return ps ? ps->count : 0; }
static const RePlugin *row(const RePlugins *ps, int i) { return ps && i >= 0 && i < ps->count ? &ps->rows[i] : NULL; }
bool re_plugins_loaded(const RePlugins *ps, int i) { const RePlugin *p = row(ps, i); return p && p->loaded; }
const char *re_plugins_error(const RePlugins *ps, int i) { const RePlugin *p = row(ps, i); return p ? p->error : ""; }
int re_plugins_tab_count(const RePlugins *ps, int i) { const RePlugin *p = row(ps, i); return p && p->loaded ? p->tab_count : 0; }
const char *re_plugins_tab_identity(const RePlugins *ps, int i, int k) { const RePlugin *p = row(ps, i); return p && k >= 0 && k < p->tab_count ? p->tabs[k].identity : ""; }
const char *re_plugins_tab_title(const RePlugins *ps, int i, int k) { const RePlugin *p = row(ps, i); return p && k >= 0 && k < p->tab_count ? p->tabs[k].title : ""; }
bool re_plugins_draw(RePlugins *ps, const char *identity, ReDrawList *list, ReRect area, RePluginMeasure measure, void *context) {
  if (!ps || !identity || !list) return false;
  for (int i = 0; i < ps->count; i++) {
    RePlugin *p = &ps->rows[i]; if (!p->loaded) continue;
    for (int k = 0; k < p->tab_count; k++) {
      if (strcmp(p->tabs[k].identity, identity)) continue;
      RePluginFrame frame = {list, area, measure, context};
      re_draw_list_clip(list, &area);
      p->tabs[k].draw(&frame, p->state);
      re_draw_list_clip(list, NULL);   /* whatever the plugin did, the frame after it starts clean */
      return true;
    }
  }
  return false;
}
cJSON *re_plugins_inspect(const RePlugins *ps) {
  cJSON *rows = cJSON_CreateArray(); if (!ps) return rows;
  for (int i = 0; i < ps->count; i++) {
    const RePlugin *p = &ps->rows[i]; cJSON *j = cJSON_CreateObject(); cJSON_AddItemToArray(rows, j);
    cJSON_AddStringToObject(j, "name", p->name); cJSON_AddStringToObject(j, "path", p->path);
    cJSON_AddStringToObject(j, "state", p->loaded ? "loaded" : "refused");
    if (p->loaded) cJSON_AddStringToObject(j, "version", p->version); else cJSON_AddStringToObject(j, "error", p->error);
    cJSON *tabs = cJSON_AddArrayToObject(j, "tabs");
    for (int k = 0; p->loaded && k < p->tab_count; k++) cJSON_AddItemToArray(tabs, cJSON_CreateString(p->tabs[k].identity));
  }
  return rows;
}
