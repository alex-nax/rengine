/* The scene the example renders, and the only thing that talks to the seam (spec 124). */
#ifndef RE_SCENE_H
#define RE_SCENE_H

#include "rengine/gpu_seam.h"
#include "scene_math.h"

#include <stdbool.h>
#include <stddef.h>

/* One vertex of everything in this scene: position, normal, texture coordinate. Interleaved in one
 * buffer with one layout, because the point is to exercise the seam rather than to show off. */
/* The colour is four BYTES, not four floats, which is the point of it being here: rEngine's own UI
 * vertex packs colour the same way, and until this existed the seam's vertex layout could only
 * describe floats. Twelve bytes saved per vertex, and one API addition justified by two consumers. */
typedef struct { float px, py, pz, nx, ny, nz, u, v; unsigned char rgba[4]; } SceneVertex;

/* A run of vertices drawn with one transform and one set of state. A scene is a list of these, and
 * the frame walks it — which is what produces the many draws with state changes between them that a
 * Vulkan backend has to coalesce into pipelines. */
#define SCENE_MATERIALS_MAX 256

/* One `usemtl` group's material, as the OBJ's companion .mtl describes it. The DECODING of `map` is
 * deliberately not here: obj.c's own comment gives the reason -- a PNG decoder would turn a seam
 * consumer into a renderer -- so the scene reads the paths and a consumer that owns a decoder hands
 * the textures back through scene_material_texture. That keeps the pack free of an image library
 * and still lets a model arrive with its materials. */
typedef struct {
  char name[64];
  float kd[3];              /* diffuse colour; white when the material does not say */
  char map[512];            /* diffuse map, resolved against the .obj's own directory; "" for none */
} SceneMaterial;

typedef struct {
  int first, count;
  Mat4 model;
  float tint[4];
  int texture;              /* 0 = checker (nearest, repeat), 1 = gradient (linear, clamp) */
  int material;             /* index into SceneGeometry.materials, or -1 for the built-in scene */
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
  SceneMaterial *materials;
  size_t material_count, material_capacity;
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
  /* An explicit camera. A consumer with a pointer sets this and gets look-around; left false and the
     scene frames itself from its own bounding sphere, which is what every gate renders and what
     keeps the recorded comparisons comparable. */
  struct { Vec3 eye, focus; bool set; } camera;
  /* The seam-exercising extras: the off-screen mirror and its inset, the depth-compare decal, the
     translucent band. They are why this scene exists as a gate, and they are noise over a model
     somebody brought to look at -- so a consumer previewing one turns them off. An explicit flag
     rather than inferring it from `loaded_model`, because this file already learned what sniffing a
     value to recover an intent costs (see draw_parts). Default on: main.c and every gate are
     unchanged. */
  bool furniture;
  ReSeamTexture white;                             /* 1x1, for a material with a colour and no map */
  ReSeamTexture maps[SCENE_MATERIALS_MAX];         /* what the consumer decoded, by material index */
} Scene;

/* Builds the procedural scene: a floor, a ring of pillars, a spinning stack of boxes, a backdrop and
 * a translucent overlay. Deterministic — no clock, no random seed — because two backends are
 * compared on its pixels. */
bool scene_open(Scene *scene, ReSeam *seam, int width, int height, const char *model_path, char *error, size_t error_size);
void scene_close(Scene *scene, ReSeam *seam);
/* Renders one frame into `target`. `frame` advances the animation; the same number gives the same
 * image on every backend and every run. */
void scene_draw(Scene *scene, ReSeam *seam, ReSeamTarget target, int frame);

/* The materials a loaded model named, for a consumer that can decode them. `scene_material_texture`
 * takes ownership of nothing: the texture stays the caller's to destroy, and the scene only binds
 * it. A material with no map, or one the caller never supplies, draws its `kd` colour. */
int scene_material_count(const Scene *scene);
const char *scene_material_map(const Scene *scene, int material);   /* "" when it has none */
void scene_material_texture(Scene *scene, int material, ReSeamTexture texture);

/* Reads an OBJ file into geometry. Positions, normals and texture coordinates; triangles and quads;
 * `usemtl` starts a new part so a model arrives as many draws rather than one. Materials themselves
 * are not loaded — see the comment in obj.c for why that is a deliberate limit and not a stub. */
bool scene_load_obj(SceneGeometry *geometry, const char *path, char *error, size_t error_size);
void scene_geometry_free(SceneGeometry *geometry);

#endif
