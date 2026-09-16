/* The render fixture of F135: a real module that exercises the two grants charter D55 adds, in the
 * two ways the criteria name — a target used inside its frame and a target kept past it, a pointer
 * inside this tab and one that belongs to another.
 *
 * A plugin can only draw, so what it SAW is reported the only way it can be: as colour. Each tab
 * paints a marker in one of two colours depending on what the pointer told it, and the tab that
 * keeps a stale target paints a colour that can only appear if the host let it present one.
 */
#include "plugin_render.h"
#include <string.h>

/* Distinctive and unlike any theme colour, so finding them in a snapshot is unambiguous. */
#define PAINTED   re_color(0, 255, 64, 255)    /* cleared into a target THIS frame and composited */
#define STALE     re_color(255, 0, 128, 255)   /* cleared into a target kept from an earlier frame */
#define GROUND    re_color(8, 8, 60, 255)      /* the stale tab's own ground, always drawn */
#define POINTER_IN  re_color(255, 200, 0, 255)
#define POINTER_OUT re_color(60, 60, 60, 255)

typedef struct {
  const RePluginHost *host;
  ReSeamTarget kept;        /* saved on the first frame and deliberately reused afterwards */
  bool have_kept;
} Fixture;
static Fixture fixture;

/* The marker every tab paints, bottom-left of its own area: what the pointer said. */
static void marker(RePluginFrame *frame, ReRect area, bool inside) {
  fixture.host->rect(frame, re_rect(area.x + 4, area.y + area.h - 14, 10, 10), inside ? POINTER_IN : POINTER_OUT);
}

/* Asks for a target every frame and presents it: the ordinary case, and the one criterion 1 names. */
static void draw_paint(RePluginFrame *frame, void *state) {
  (void)state;
  const RePluginHost *host = fixture.host;
  ReRect area = host->area(frame);
  const RePluginRender *render = host->render(frame);
  RePluginPointer pointer = {0};
  host->pointer(frame, &pointer);
  if (render) {
    ReSeamTarget target;
    if (render->target(frame, area.w > 0 ? area.w : 1, area.h > 0 ? area.h : 1, &target)) {
      render->frame_begin(render->seam, target);
      render->clear(render->seam, 0.0f, 1.0f, 0.25f, 1.0f, true);
      render->frame_end(render->seam);
      render->draw_target(frame, area, 0);
    }
  }
  marker(frame, area, pointer.inside);
}

/* Asks once, keeps the handle, and presents it on every later frame. The host must refuse, so STALE
 * can never reach the screen — that is criterion 2, and it is a colour rather than an argument. */
static void draw_stale(RePluginFrame *frame, void *state) {
  (void)state;
  const RePluginHost *host = fixture.host;
  ReRect area = host->area(frame);
  const RePluginRender *render = host->render(frame);
  RePluginPointer pointer = {0};
  host->pointer(frame, &pointer);
  host->rect(frame, area, GROUND);
  if (render) {
    if (!fixture.have_kept) {
      /* The first frame asks and saves, and presents nothing: so every STALE pixel after this is
         the host having accepted a handle from a frame that is over. */
      if (render->target(frame, area.w > 0 ? area.w : 1, area.h > 0 ? area.h : 1, &fixture.kept))
        fixture.have_kept = true;
    } else {
      render->frame_begin(render->seam, fixture.kept);
      render->clear(render->seam, 1.0f, 0.0f, 0.5f, 1.0f, true);
      render->frame_end(render->seam);
      render->draw_target(frame, area, 0);        /* no ask this frame: must be refused */
    }
  }
  marker(frame, area, pointer.inside);
}

static bool start(RePlugin *self, const RePluginHost *host, void **state) {
  fixture.host = host; *state = &fixture;
  RePluginTab paint = {(uint32_t)sizeof(RePluginTab), "paint", "Paint", draw_paint};
  RePluginTab stale = {(uint32_t)sizeof(RePluginTab), "stale", "Stale", draw_stale};
  return host->register_tab(self, &paint) && host->register_tab(self, &stale);
}
static void stop(RePlugin *self, void *state) { (void)self; (void)state; memset(&fixture, 0, sizeof(fixture)); }

static const RePluginDesc desc = {
  (uint32_t)sizeof(RePluginDesc), RE_PLUGIN_ABI_VERSION, RE_DRAW_LIST_VERSION,
  "render-fixture", "1.0.0", start, stop,
};
RE_PLUGIN_EXPORT const RePluginDesc *re_plugin_entry(void) { return &desc; }
