#ifndef RENGINE_SCENE_H
#define RENGINE_SCENE_H
#include "draw.h"
/* Synthetic scenes drawn over the workspace for adapter comparisons (spec 068). */
int re_scene_id(const char *name);
void re_scene_draw(int scene, ReDraw *draw);
#endif
