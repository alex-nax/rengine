/* The fixture plugin of spec 106: a real loadable module that draws something identifiable and
 * registers one tab. The refusal fixtures are built from this same source with the knobs below,
 * so what the loader refuses is a module that would otherwise have loaded, not a hand-made fake. */
#include "plugin_abi.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef RE_FIXTURE_ABI
#define RE_FIXTURE_ABI RE_PLUGIN_ABI_VERSION
#endif
#ifndef RE_FIXTURE_DRAW_LIST
#define RE_FIXTURE_DRAW_LIST RE_DRAW_LIST_VERSION
#endif
#ifndef RE_FIXTURE_NAME
#define RE_FIXTURE_NAME "fixture"
#endif
#ifndef RE_FIXTURE_DECLINE
#define RE_FIXTURE_DECLINE 0
#endif

#define LABEL "plugin fixture"
#define MAGENTA re_color(255, 0, 255, 255)
#define CYAN re_color(0, 255, 255, 255)

typedef struct { const RePluginHost *host; RePlugin *self; int frames, stopped; } Fixture;
static Fixture fixture;   /* one instance per mapped module */

/* Ten commands the CTest asserts one by one; the desktop spec reads the same drawing off the screen. */
static void draw(RePluginFrame *frame, void *state) {
  Fixture *f = state; const RePluginHost *h = f->host; ReRect a = h->area(frame);
  f->frames++;
  h->rect(frame, re_rect(a.x + 8, a.y + 8, 40, 40), MAGENTA);
  int w = h->text_width(frame, RE_FACE_UI, 12, LABEL, -1);
  h->text(frame, RE_FACE_UI, 12, a.x + a.w - w - 8, a.y + 8, CYAN, LABEL, -1);
  h->rect(frame, re_rect(a.x + a.w + 4, a.y, 40, 40), MAGENTA);          /* past the area: the frame's clip must hide it */
  ReRect wide = re_rect(a.x - 100, a.y - 100, a.w + 200, a.h + 200);
  h->clip(frame, &wide);                                                 /* asks to widen; may only narrow */
  ReColor fg; bool known = h->colour(frame, "--ui-fg", &fg);
  h->rect(frame, re_rect(a.x, a.y + 56, 16, 16), known ? fg : MAGENTA);
  ReColor none; bool unknown = h->colour(frame, "--no-such-token", &none);
  h->rect(frame, re_rect(a.x + 20, a.y + 56, 16, 16), unknown ? CYAN : re_color(1, 2, 3, 4));
  RePluginTab late = {(uint32_t)sizeof(RePluginTab), "late", "Late", draw};
  bool accepted = h->register_tab(f->self, &late);                       /* registration is a start-time act */
  h->rect(frame, re_rect(a.x + 40, a.y + 56, 16, 16), accepted ? re_color(9, 9, 9, 9) : re_color(0, 0, 0, 255));
  h->clip(frame, NULL);
}
static bool start(RePlugin *self, const RePluginHost *host, void **state) {
#if RE_FIXTURE_ABI != RE_PLUGIN_ABI_VERSION || RE_FIXTURE_DRAW_LIST > RE_DRAW_LIST_VERSION
  /* A module the desktop must refuse. Reaching this line is the defect the loader exists to prevent. */
  (void)self; (void)host; (void)state; (void)fixture; (void)draw;
  fprintf(stderr, "%s: start of a module the desktop must refuse ran\n", RE_FIXTURE_NAME); abort();
#else
  fixture.host = host; fixture.self = self; *state = &fixture;
  RePluginTab tab = {(uint32_t)sizeof(RePluginTab), "hello", "Fixture", draw};
  if (!host->register_tab(self, &tab)) return false;
  return !RE_FIXTURE_DECLINE;
#endif
}
static void stop(RePlugin *self, void *state) { (void)self; Fixture *f = state; f->stopped++; f->host = NULL; }

static const RePluginDesc desc = {(uint32_t)sizeof(RePluginDesc), RE_FIXTURE_ABI, RE_FIXTURE_DRAW_LIST, RE_FIXTURE_NAME, "1.0.0", start, stop};
RE_PLUGIN_EXPORT const RePluginDesc *re_plugin_entry(void) { return &desc; }
