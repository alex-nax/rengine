/* Spec 106 — the plugin loader against REAL modules built from tests/plugins/, not a table of
 * fakes: a wrong-ABI refusal that never reached dlopen would still pass a mocked loader. The
 * refusal fixtures are the same source declaring itself differently, and the ones that must be
 * refused abort() in start, so "start is never called" is the process surviving. */
#include "plugin.h"
#include <stddef.h>   /* offsetof: the grant is counted, not described */
#include "theme.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static int measure(void *context, uint8_t face, int size, const char *text, int length) {
  (void)context; (void)face; (void)size;
  return 7 * (length < 0 ? (int)strlen(text) : length);   /* a fake monospace: 7px per byte */
}
static bool has(const char *text, const char *part) { return text && part && strstr(text, part) != NULL; }
static bool same_rect(ReRect a, ReRect b) { return a.x == b.x && a.y == b.y && a.w == b.w && a.h == b.h; }
static bool same_color(ReColor a, ReColor b) { return a.r == b.r && a.g == b.g && a.b == b.b && a.a == b.a; }

int main(int argc, char **argv) {
  if (argc < 9) { fprintf(stderr, "usage: %s fixture abi-old abi-new list-new list-old blank decline text-file\n", argv[0]); return 2; }
  const char *fixture = argv[1], *abi_old = argv[2], *abi_new = argv[3], *list_new = argv[4], *list_old = argv[5], *blank = argv[6], *decline = argv[7], *text_file = argv[8];
  char error[512], expect[160];
  RePlugins *plugins = re_plugins_open(); assert(plugins);
  const RePluginHost *host = re_plugins_host();
  assert(host->size == sizeof(RePluginHost) && host->abi_version == RE_PLUGIN_ABI_VERSION && host->draw_list_version == RE_DRAW_LIST_VERSION);
  /* What the grant still refuses (charter D38, and D55's "keyboard, shortcuts, controls, unloading
     and any reach into store, session or host state stay refused"). The table is the whole grant,
     so counting it is the check: three members arrived with ABI 2 and nothing else did. A member
     added without a decision behind it fails here rather than shipping. */
  assert(sizeof(RePluginHost) == offsetof(RePluginHost, register_tab) + 16 * sizeof(void *));

  /* A declaration claiming another ABI is refused before the file is touched: the path does not
   * exist, so a loader that opened first would have reported dlopen's message instead. */
  assert(re_plugins_load(plugins, "claim", "/nonexistent/claim.so", "re-plugin/7", error, sizeof(error)) == -1);
  assert(has(error, "claim") && has(error, "re-plugin/7") && has(error, RE_PLUGIN_ABI_STRING) && has(error, "not opened") && !has(error, "cannot open"));

  /* A path that will not open, a file that is not a module, a relative path: refused by name, and
   * the registry stays usable afterwards. */
  assert(re_plugins_load(plugins, "missing", "/nonexistent/missing.so", RE_PLUGIN_ABI_STRING, error, sizeof(error)) == -1);
  assert(has(error, "plugin missing") && has(error, "/nonexistent/missing.so") && has(error, "cannot open"));
  assert(re_plugins_load(plugins, "textfile", text_file, RE_PLUGIN_ABI_STRING, error, sizeof(error)) == -1);
  assert(has(error, "plugin textfile") && has(error, text_file) && has(error, "cannot open"));
  assert(re_plugins_load(plugins, "relative", "plugins/fixture.so", RE_PLUGIN_ABI_STRING, error, sizeof(error)) == -1 && has(error, "not absolute"));

  /* A module without the entry point. */
  assert(re_plugins_load(plugins, "blank", blank, RE_PLUGIN_ABI_STRING, error, sizeof(error)) == -1);
  assert(has(error, "plugin blank") && has(error, blank) && has(error, RE_PLUGIN_ENTRY_NAME));

  /* The wrong ABI, older and newer: refused naming the module and both versions. */
  assert(re_plugins_load(plugins, "fixture-abi-old", abi_old, RE_PLUGIN_ABI_STRING, error, sizeof(error)) == -1);
  snprintf(expect, sizeof(expect), "was built against plugin ABI 0; this desktop is ABI %u", (unsigned)RE_PLUGIN_ABI_VERSION);
  assert(has(error, abi_old) && has(error, expect));
  assert(re_plugins_load(plugins, "fixture-abi-new", abi_new, RE_PLUGIN_ABI_STRING, error, sizeof(error)) == -1);
  snprintf(expect, sizeof(expect), "was built against plugin ABI %u; this desktop is ABI %u", (unsigned)RE_PLUGIN_ABI_VERSION + 1, (unsigned)RE_PLUGIN_ABI_VERSION);
  assert(has(error, abi_new) && has(error, expect));

  /* A newer draw list is refused; an older one is accepted, because the list is additive (spec 067). */
  assert(re_plugins_load(plugins, "fixture-list-new", list_new, RE_PLUGIN_ABI_STRING, error, sizeof(error)) == -1);
  snprintf(expect, sizeof(expect), "was built against draw list %u; this desktop is draw list %u", (unsigned)RE_DRAW_LIST_VERSION + 1, (unsigned)RE_DRAW_LIST_VERSION);
  assert(has(error, list_new) && has(error, expect));
  int old = re_plugins_load(plugins, "fixture-list-old", list_old, RE_PLUGIN_ABI_STRING, error, sizeof(error));
  assert(old >= 0 && re_plugins_loaded(plugins, old) && re_plugins_tab_count(plugins, old) == 1);
  assert(!strcmp(re_plugins_tab_identity(plugins, old, 0), "fixture-list-old/hello"));

  /* The module's own name must agree with the declaration. */
  assert(re_plugins_load(plugins, "wrong-name", list_old, RE_PLUGIN_ABI_STRING, error, sizeof(error)) == -1);
  assert(has(error, "plugin wrong-name") && has(error, "calls itself 'fixture-list-old'"));

  /* A start that declines is reported, keeps no tabs, and is not drawn. */
  int declined = re_plugins_load(plugins, "fixture-decline", decline, RE_PLUGIN_ABI_STRING, error, sizeof(error));
  assert(declined == -1 && has(error, decline) && has(error, "declined to start"));
  int rows = re_plugins_count(plugins);
  for (int i = 0; i < rows; i++) if (!strcmp(re_plugins_tab_identity(plugins, i, 0), "fixture-decline/hello")) assert(!"a declined plugin keeps no tab");

  /* The fixture loads and registers its tab. */
  int index = re_plugins_load(plugins, "fixture", fixture, RE_PLUGIN_ABI_STRING, error, sizeof(error));
  assert(index >= 0 && re_plugins_loaded(plugins, index) && !*error);
  assert(re_plugins_tab_count(plugins, index) == 1);
  assert(!strcmp(re_plugins_tab_identity(plugins, index, 0), "fixture/hello") && !strcmp(re_plugins_tab_title(plugins, index, 0), "Fixture"));
  rows = re_plugins_count(plugins);

  /* Idempotent by name, loaded or refused: the workspace state that carries declarations arrives repeatedly. */
  assert(re_plugins_load(plugins, "fixture", fixture, RE_PLUGIN_ABI_STRING, error, sizeof(error)) == index);
  assert(re_plugins_tab_count(plugins, index) == 1 && re_plugins_count(plugins) == rows);
  assert(re_plugins_load(plugins, "missing", "/nonexistent/missing.so", RE_PLUGIN_ABI_STRING, error, sizeof(error)) == -1);
  assert(has(error, "/nonexistent/missing.so") && re_plugins_count(plugins) == rows);

  /* The frame: the tab's area on entry, every command in order, no widening, a reset on exit. */
  ReDrawList list; re_draw_list_init(&list);
  re_draw_list_reset(&list, 800, 600, 1.0f, re_color(0, 0, 0, 255));
  ReRect area = re_rect(100, 50, 300, 200);
  assert(!re_plugins_draw(plugins, "fixture/nope", &(RePluginFrameSpec){.list = &list, .area = area, .measure = measure}) && list.count == 0);
  assert(!re_plugins_draw(plugins, "fixture-decline/hello", &(RePluginFrameSpec){.list = &list, .area = area, .measure = measure}) && list.count == 0);
  assert(re_plugins_draw(plugins, "fixture/hello", &(RePluginFrameSpec){.list = &list, .area = area, .measure = measure}));
  if (list.count != 10) fprintf(stderr, "the frame holds %d commands, not 10\n", (int)list.count);
  assert(list.count == 10);
  const ReCommand *c = list.commands;
  assert(c[0].type == RE_CMD_CLIP && !(c[0].flags & RE_CLIP_RESET) && same_rect(c[0].rect, area));
  assert(c[1].type == RE_CMD_RECT && same_rect(c[1].rect, re_rect(108, 58, 40, 40)) && same_color(c[1].color, re_color(255, 0, 255, 255)));
  assert(c[2].type == RE_CMD_TEXT && c[2].face == RE_FACE_UI && c[2].size == 12 && c[2].rect.x == 100 + 300 - 7 * 14 - 8 && c[2].rect.y == 58);
  assert(!strcmp(re_draw_list_string(&list, &c[2]), "plugin fixture") && same_color(c[2].color, re_color(0, 255, 255, 255)));
  assert(c[3].type == RE_CMD_RECT && same_rect(c[3].rect, re_rect(404, 50, 40, 40)));
  assert(c[4].type == RE_CMD_CLIP && !(c[4].flags & RE_CLIP_RESET) && same_rect(c[4].rect, area));   /* asked for wider, got its area */
  assert(c[5].type == RE_CMD_RECT && same_color(c[5].color, re_color(RE_COLOR_TEXT.r, RE_COLOR_TEXT.g, RE_COLOR_TEXT.b, RE_COLOR_TEXT.a)));
  assert(c[6].type == RE_CMD_RECT && same_color(c[6].color, re_color(1, 2, 3, 4)));                   /* an unknown token answered false */
  assert(c[7].type == RE_CMD_RECT && same_color(c[7].color, re_color(0, 0, 0, 255)));                 /* late registration refused */
  assert(c[8].type == RE_CMD_CLIP && !(c[8].flags & RE_CLIP_RESET) && same_rect(c[8].rect, area));   /* NULL restores the area */
  assert(c[9].type == RE_CMD_CLIP && (c[9].flags & RE_CLIP_RESET));
  assert(re_plugins_tab_count(plugins, index) == 1);

  /* A theme colour is the live table's, so a preset switch reaches the plugin on the next frame. */
  ReColor before = c[5].color;
  int preset = re_theme_select("light"); assert(preset >= 0);
  re_draw_list_reset(&list, 800, 600, 1.0f, re_color(0, 0, 0, 255));
  assert(re_plugins_draw(plugins, "fixture/hello", &(RePluginFrameSpec){.list = &list, .area = area, .measure = measure}) && list.count == 10);
  assert(!same_color(list.commands[5].color, before) && same_color(list.commands[5].color, re_color(RE_COLOR_TEXT.r, RE_COLOR_TEXT.g, RE_COLOR_TEXT.b, RE_COLOR_TEXT.a)));

  /* What the window reports. */
  cJSON *report = re_plugins_inspect(plugins);
  assert(cJSON_GetArraySize(report) == rows);
  const cJSON *entry = NULL; int loaded = 0, refused = 0;
  cJSON_ArrayForEach(entry, report) {
    const cJSON *name = cJSON_GetObjectItemCaseSensitive(entry, "name"), *state = cJSON_GetObjectItemCaseSensitive(entry, "state");
    if (!strcmp(state->valuestring, "loaded")) loaded++; else refused++;
    if (!strcmp(name->valuestring, "fixture")) {
      assert(!strcmp(state->valuestring, "loaded") && !strcmp(cJSON_GetObjectItemCaseSensitive(entry, "version")->valuestring, "1.0.0"));
      assert(!strcmp(cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(entry, "tabs"), 0)->valuestring, "fixture/hello"));
    }
    if (!strcmp(name->valuestring, "missing")) {
      assert(!strcmp(state->valuestring, "refused") && has(cJSON_GetObjectItemCaseSensitive(entry, "error")->valuestring, "/nonexistent/missing.so"));
      assert(cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(entry, "tabs")) == 0);
    }
  }
  assert(loaded == 2 && refused == rows - 2);
  cJSON_Delete(report);
  re_draw_list_free(&list);
  re_plugins_close(plugins);
  printf("plugin ABI v%d: %d rows, %d loaded, %d refused by name; the fixture's frame is 10 commands inside its area\n", RE_PLUGIN_ABI_VERSION, rows, loaded, refused);
  return 0;
}
