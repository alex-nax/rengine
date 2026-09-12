/* Material maps, decoded by the consumer and handed to the scene (F136). */
#ifndef RE_SCENE_TEXTURES_H
#define RE_SCENE_TEXTURES_H
#include "plugin_render.h"
#include "scene.h"
/* Decodes up to `limit` of the model's `map_Kd` images and gives them to the scene. Returns how
   many arrived; a path that will not decode is skipped, and that material draws its colour. */
int scene_textures_load(Scene *scene, const RePluginRender *render, int limit);
void scene_textures_free(Scene *scene, const RePluginRender *render);
#endif
