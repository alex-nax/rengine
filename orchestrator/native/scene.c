#include <string.h>   /* strcmp: reached through common.h until draw.h stopped pulling it */
#include "scene.h"

enum { SCENE_NONE = 0, SCENE_PRIMITIVES = 1 };
#define CHECKER 32

/* Recorded as the scene draws, so the renderer gate's regions are the drawing code's own. A name
   repeats across a row on purpose: `rrect-radius` covers four rectangles, and a divergence in any
   one of them names the primitive rather than the pixel. */
static ReSceneRegion regions[RE_SCENE_REGIONS];
static int region_count;
int re_scene_region_count(void) { return region_count; }
const ReSceneRegion *re_scene_region(int index) {
  return index >= 0 && index < region_count ? &regions[index] : NULL;
}
/* Every region is grown by the blur or stroke it carries, because a shadow paints outside the rect
   it is given and a comparison that stopped at the rect would miss exactly the pixels that differ. */
static void mark(const char *name, mu_Rect r, int bleed) {
  if (region_count >= RE_SCENE_REGIONS) return;
  regions[region_count].name = name;
  regions[region_count].rect = mu_rect(r.x - bleed, r.y - bleed, r.w + 2 * bleed, r.h + 2 * bleed);
  region_count++;
}

int re_scene_id(const char *name) { return name && !strcmp(name, "primitives") ? SCENE_PRIMITIVES : SCENE_NONE; }

static ReTexture *checker(ReDraw *draw) {
  static ReTexture *texture;
  if (texture) return texture;
  texture = re_draw_texture_create(draw, CHECKER, CHECKER);
  if (!texture) return NULL;
  uint8_t pixels[CHECKER * CHECKER * 4];
  for (int y = 0; y < CHECKER; y++) for (int x = 0; x < CHECKER; x++) {
    uint8_t *p = pixels + (y * CHECKER + x) * 4; bool light = ((x / 8) + (y / 8)) % 2 == 0;
    mu_Color c = light ? RE_COLOR_TEXT : RE_COLOR_CONTROL;
    p[0] = c.r; p[1] = c.g; p[2] = c.b; p[3] = 255;
  }
  re_draw_texture_update(texture, pixels, CHECKER * 4);
  return texture;
}

/* Every contract primitive at several sizes, radii and corner masks, laid out over the workspace. */
void re_scene_draw(int scene, ReDraw *draw) {
  if (scene != SCENE_PRIMITIVES) return;
  static const float radii[4] = {0, 3, 6, 12};
  static const uint8_t masks[4] = {RE_CORNERS_ALL, RE_CORNER_TOP_LEFT | RE_CORNER_TOP_RIGHT, RE_CORNER_BOTTOM_RIGHT, 0};
  re_draw_clip(draw, NULL);
  region_count = 0;
  re_draw_rect(draw, mu_rect(40, 100, 900, 600), RE_COLOR_SURFACE);
  for (int i = 0; i < 4; i++) {
    re_draw_rrect(draw, mu_rect(60 + i * 110, 120, 90, 40), RE_COLOR_CONTROL, radii[i], RE_CORNERS_ALL);
    mark("rrect-radius", mu_rect(60 + i * 110, 120, 90, 40), 2);
    re_draw_rrect(draw, mu_rect(60 + i * 110, 175, 90, 40), RE_COLOR_CONTROL_HOVER, 8, masks[i]);
    mark("rrect-corners", mu_rect(60 + i * 110, 175, 90, 40), 2);
    re_draw_frame(draw, mu_rect(520 + i * 100, 120, 80, 40), RE_COLOR_BORDER, RE_COLOR_TEXT_MUTED, radii[i]);
    mark("frame", mu_rect(520 + i * 100, 120, 80, 40), 2);
    re_draw_ring(draw, mu_rect(520 + i * 100, 185, 70, 30), RE_COLOR_CARET, radii[i], 2);
    mark("ring", mu_rect(520 + i * 100, 185, 70, 30), 3);
  }
  for (int i = 0; i < 3; i++) {
    re_draw_shadow(draw, mu_rect(90 + i * 150, 250, 100, 50), RE_COLOR_GAME_BACKDROP, 6, 4 + i * 4);
    mark("shadow", mu_rect(90 + i * 150, 250, 100, 50), 6 + 4 + i * 4);
  }
  for (int i = 0; i < 3; i++) re_draw_rrect(draw, mu_rect(90 + i * 150, 250, 100, 50), RE_COLOR_INDICATOR, 6, RE_CORNERS_ALL);
  re_draw_text(draw, "The quick brown fox jumps over 0123456789 · éü", -1, 60, 330, RE_COLOR_TEXT);
  mark("text", mu_rect(60, 316, 480, 24), 2);
  re_draw_text_face(draw, RE_FACE_UI, 12, "UI face 12px: proportional advances", -1, 60, 356, RE_COLOR_TEXT_MUTED);
  re_draw_text_face(draw, RE_FACE_UI_MEDIUM, 13, "UI medium 13px", -1, 60, 376, RE_COLOR_TEXT);
  re_draw_text_face(draw, RE_FACE_UI_SEMIBOLD, 13, "UI semibold 13px", -1, 200, 376, RE_COLOR_TEXT);
  re_draw_text_face(draw, RE_FACE_MONO, 24, "Mono 24px", -1, 60, 398, RE_COLOR_TEXT_INDICATOR);
  mark("text-faces", mu_rect(60, 346, 480, 76), 2);
  for (int i = 0; i < RE_ICON_COUNT; i++) {
    re_draw_icon(draw, (uint8_t)i, mu_rect(560 + (i % 12) * 40, 330 + (i / 12) * 34, 30, 26), i % 2 ? RE_COLOR_CARET : RE_COLOR_TEXT);
  }
  mark("icons", mu_rect(560, 320, 490, 90), 2);
  ReTexture *t = checker(draw);
  re_draw_texture(draw, t, mu_rect(60, 440, 128, 128), 0);
  re_draw_texture(draw, t, mu_rect(220, 440, 128, 128), RE_DRAW_FLIP_Y);
  re_draw_texture(draw, t, mu_rect(380, 440, 200, 64), 0);
  mark("texture", mu_rect(60, 440, 520, 128), 2);
  mu_Rect clip = mu_rect(640, 440, 120, 80);
  re_draw_clip(draw, &clip);
  re_draw_rrect(draw, mu_rect(600, 420, 200, 120), RE_COLOR_CONTROL_ACTIVE, 16, RE_CORNERS_ALL);
  re_draw_text(draw, "clipped text run overflowing the box", -1, 600, 470, RE_COLOR_TEXT);
  re_draw_clip(draw, NULL);
  mark("clip", mu_rect(640, 440, 120, 80), 2);
  re_draw_frame(draw, mu_rect(60, 590, 800, 60), RE_COLOR_DIVIDER, RE_COLOR_SCROLL_THUMB_ACTIVE, 0);
  mark("frame-wide", mu_rect(60, 590, 800, 60), 2);
  re_draw_ring(draw, mu_rect(880, 120, 30, 30), RE_COLOR_SCROLL_THUMB, 15, 3);
  mark("ring-round", mu_rect(880, 120, 30, 30), 4);
  /* The version-2 gradient, both axes and with and without rounded ends, so every adapter's ramp is
   * compared against the reference the same way the other primitives are (spec 080). */
  re_draw_gradient(draw, mu_rect(60, 662, 400, 20), RE_COLOR_ACCENT, RE_COLOR_INFO, 10, RE_CORNERS_ALL, RE_GRADIENT_HORIZONTAL);
  re_draw_gradient(draw, mu_rect(490, 662, 120, 20), RE_COLOR_OK, RE_COLOR_ERR, 0, 0, RE_GRADIENT_HORIZONTAL);
  re_draw_gradient(draw, mu_rect(640, 640, 40, 42), RE_COLOR_WARN, RE_COLOR_CANVAS, 6, RE_CORNERS_ALL, RE_GRADIENT_VERTICAL);
  mark("gradient", mu_rect(60, 640, 620, 44), 2);
}
