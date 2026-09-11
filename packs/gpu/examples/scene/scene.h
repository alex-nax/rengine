/* The scene the example renders, and the only thing that talks to the seam (spec 124). */
#ifndef RE_SCENE_H
#define RE_SCENE_H

#include "rengine/gpu_seam.h"
#include "scene_math.h"

#include <stdbool.h>
#include <stddef.h>

/* One vertex of everything in this scene: position, normal, texture coordinate. Interleaved in one
 * buffer with one layout, because the point is to exercise the seam rather than to show off. */
typedef struct { float px, py, pz, nx, ny, nz, u, v; } SceneVertex;

/* A run of vertices drawn with one transform and one set of state. A scene is a list of these, and
 * the frame walks it — which is what produces the many draws with state changes between them that a
 * Vulkan backend has to coalesce into pipelines. */
typedef struct {
  int first, count;
  Mat4 model;
  float tint[4];
  int texture;              /* 0 = checker (nearest, repeat), 1 = gradient (linear, clamp) */
  bool cull;
  bool depth_write;
  bool animate;             /* the frame number moves this part; a loaded model's parts never do */
  bool backdrop;            /* surrounds the scene rather than being in it — excluded from bounds */
} ScenePart;

typedef struct {
  SceneVertex *vertices;
  size_t vertex_count, vertex_capacity;
  ScenePart *parts;
  size_t part_count, part_capacity;
} SceneGeometry;

/* Everything the scene owns on the GPU, plus the geometry it was built from. */
typedef struct {
  SceneGeometry geometry;
  ReSeamBuffer buffer;
  ReSeamVertexArray array;
  ReSeamBuffer overlay_buffer;
  ReSeamVertexArray overlay_array;
  ReSeamProgram lit, flat, screen;
  int lit_view_proj, lit_model, lit_tint, lit_texture, lit_light;
  int flat_view_proj, flat_model, flat_tint;
  int screen_texture, screen_extent;
  ReSeamTexture checker, gradient;
  ReSeamTexture mirror_color, mirror_depth;
  ReSeamTarget mirror;
  int width, height;
  bool loaded_model;        /* true when geometry came from a file rather than from build_scene */
  Vec3 centre;              /* of the geometry's bounding box */
  float radius;             /* of the bounding sphere, which is what the camera is placed from */
  /* How the camera is framed, as multiples of that radius. A fitted orbit puts a camera outside a
     model's bounding sphere, which is right for an object and wrong for a building you want to stand
     inside — so framing is the caller's, with a default that suits the built-in scene. */
  float orbit, eye_height;
} Scene;

/* Builds the procedural scene: a floor, a ring of pillars, a spinning stack of boxes, a backdrop and
 * a translucent overlay. Deterministic — no clock, no random seed — because two backends are
 * compared on its pixels. */
bool scene_open(Scene *scene, ReSeam *seam, int width, int height, const char *model_path, char *error, size_t error_size);
void scene_close(Scene *scene, ReSeam *seam);
/* Renders one frame into `target`. `frame` advances the animation; the same number gives the same
 * image on every backend and every run. */
void scene_draw(Scene *scene, ReSeam *seam, ReSeamTarget target, int frame);

/* Reads an OBJ file into geometry. Positions, normals and texture coordinates; triangles and quads;
 * `usemtl` starts a new part so a model arrives as many draws rather than one. Materials themselves
 * are not loaded — see the comment in obj.c for why that is a deliberate limit and not a stub. */
bool scene_load_obj(SceneGeometry *geometry, const char *path, char *error, size_t error_size);
void scene_geometry_free(SceneGeometry *geometry);

#endif
