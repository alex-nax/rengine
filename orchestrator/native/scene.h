#ifndef RENGINE_SCENE_H
#define RENGINE_SCENE_H
#include "draw.h"
/* Synthetic scenes drawn over the workspace for adapter comparisons (spec 068). */
int re_scene_id(const char *name);
void re_scene_draw(int scene, ReDraw *draw);

/* What the last draw actually drew, and where (KI-111). The renderer gate used to compare a whole
 * scene, so a divergence was "385 pixels somewhere"; named regions make it "the shadow at blur 12
 * differs on Metal". They are recorded BY the drawing code rather than written down beside it,
 * because a table of rectangles kept in a test drifts the first time a shape moves. */
#define RE_SCENE_REGIONS 64
typedef struct { const char *name; mu_Rect rect; } ReSceneRegion;
int re_scene_region_count(void);
const ReSceneRegion *re_scene_region(int index);
#endif
