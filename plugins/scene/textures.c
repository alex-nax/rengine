/* The decoding half of a model's materials, which the scene deliberately does not do (see obj.c).
 *
 * The scene reads `map_Kd` paths and this turns them into seam textures, because the consumer is
 * where an image decoder belongs — rEngine already vendors stb_image for its own image view, and
 * the pack stays free of one. A texture the scene could not be given draws as its material's colour
 * rather than failing the frame: half a model is worth more than none while a path is wrong.
 */
#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_ONLY_JPEG
#define STBI_ONLY_TGA
#define STBI_ONLY_BMP
#include "stb_image.h"

#include "scene_textures.h"

#include <stdio.h>
#include <string.h>

int scene_textures_load(Scene *scene, const RePluginRender *render, int limit) {
  int loaded = 0;
  for (int i = 0; i < scene_material_count(scene) && loaded < limit; i++) {
    const char *path = scene_material_map(scene, i);
    if (!path || !*path) continue;
    int width = 0, height = 0, channels = 0;
    /* Four channels always: the seam's texture upload takes RGBA8 and a three-channel source would
       otherwise need a per-format path here for no gain. */
    unsigned char *pixels = stbi_load(path, &width, &height, &channels, 4);
    if (!pixels) continue;
    ReSeamTexture texture = render->texture_2d(render->seam, pixels, width, height,
                                               RE_SEAM_FILTER_LINEAR, RE_SEAM_WRAP_REPEAT);
    stbi_image_free(pixels);
    if (!texture.id) continue;
    scene_material_texture(scene, i, texture);
    loaded++;
  }
  return loaded;
}

void scene_textures_free(Scene *scene, const RePluginRender *render) {
  for (int i = 0; i < SCENE_MATERIALS_MAX; i++) {
    ReSeamTexture texture = scene->maps[i];
    if (!texture.id) continue;
    render->texture_destroy(render->seam, &texture);
    scene_material_texture(scene, i, (ReSeamTexture){0, 0, 0});
  }
}
