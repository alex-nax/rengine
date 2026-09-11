/* The procedural scene, and the frame that draws it through the seam (F132, spec 124).
 *
 * WHAT IT IS BUILT TO EXERCISE. This is not a pretty picture for its own sake — it is the consumer
 * whose pixels judge three backends, so it is built to contain what backends actually differ on:
 *
 *   - many draws with state changes between them, which is what a Vulkan backend must coalesce into
 *     cached pipelines rather than one pipeline per frame;
 *   - depth test and depth write toggled independently, which is why the seam sets them piecemeal;
 *   - back-face culling on and off in the same frame;
 *   - three programs, so "the right program was bound" is observable;
 *   - textures at both filters and both wraps, which no single sample position can tell apart;
 *   - an off-screen pass sampled by a later draw, which is the render-target API F129 added;
 *   - an alpha-blended overlay last, so blending and depth-write-off interact as they do in a UI.
 *
 * It is deterministic on purpose: no clock, no random seed. `frame` is the only input to the
 * animation, so the same frame number is the same image on every backend and every run — which is
 * what makes a pixel comparison between backends mean anything.
 */
#include "scene.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECKER_SIZE 16
#define GRADIENT_SIZE 32

/* ---- geometry ----------------------------------------------------------------------------------- */

static bool reserve_vertices(SceneGeometry *g, size_t extra) {
  if (g->vertex_count + extra <= g->vertex_capacity) return true;
  size_t capacity = g->vertex_capacity ? g->vertex_capacity : 1024;
  while (capacity < g->vertex_count + extra) capacity *= 2;
  SceneVertex *grown = realloc(g->vertices, capacity * sizeof(*grown));
  if (grown == NULL) return false;
  g->vertices = grown;
  g->vertex_capacity = capacity;
  return true;
}

static ScenePart *add_part(SceneGeometry *g) {
  if (g->part_count == g->part_capacity) {
    size_t capacity = g->part_capacity ? g->part_capacity * 2 : 32;
    ScenePart *grown = realloc(g->parts, capacity * sizeof(*grown));
    if (grown == NULL) return NULL;
    g->parts = grown;
    g->part_capacity = capacity;
  }
  ScenePart *part = &g->parts[g->part_count++];
  memset(part, 0, sizeof(*part));
  part->model = mat4_identity();
  part->tint[0] = part->tint[1] = part->tint[2] = part->tint[3] = 1.0f;
  part->cull = true;
  part->depth_write = true;
  return part;
}

static void push_vertex(SceneGeometry *g, Vec3 p, Vec3 n, float u, float v) {
  SceneVertex *out = &g->vertices[g->vertex_count++];
  out->px = p.x; out->py = p.y; out->pz = p.z;
  out->nx = n.x; out->ny = n.y; out->nz = n.z;
  out->u = u; out->v = v;
}

/* One face as two triangles, wound counter-clockwise seen from outside so back-face culling has
 * something to cull. `tile` scales the texture coordinates, which is how the floor repeats. */
static void push_quad(SceneGeometry *g, Vec3 a, Vec3 b, Vec3 c, Vec3 d, float tile) {
  Vec3 n = vec3_normalize(vec3_cross(vec3_sub(b, a), vec3_sub(d, a)));
  push_vertex(g, a, n, 0.0f, 0.0f);
  push_vertex(g, b, n, tile, 0.0f);
  push_vertex(g, c, n, tile, tile);
  push_vertex(g, a, n, 0.0f, 0.0f);
  push_vertex(g, c, n, tile, tile);
  push_vertex(g, d, n, 0.0f, tile);
}

static bool push_box(SceneGeometry *g, Vec3 centre, Vec3 half, float tile) {
  if (!reserve_vertices(g, 36)) return false;
  float x0 = centre.x - half.x, x1 = centre.x + half.x;
  float y0 = centre.y - half.y, y1 = centre.y + half.y;
  float z0 = centre.z - half.z, z1 = centre.z + half.z;
  push_quad(g, vec3(x0, y0, z1), vec3(x1, y0, z1), vec3(x1, y1, z1), vec3(x0, y1, z1), tile); /* +z */
  push_quad(g, vec3(x1, y0, z0), vec3(x0, y0, z0), vec3(x0, y1, z0), vec3(x1, y1, z0), tile); /* -z */
  push_quad(g, vec3(x1, y0, z1), vec3(x1, y0, z0), vec3(x1, y1, z0), vec3(x1, y1, z1), tile); /* +x */
  push_quad(g, vec3(x0, y0, z0), vec3(x0, y0, z1), vec3(x0, y1, z1), vec3(x0, y1, z0), tile); /* -x */
  push_quad(g, vec3(x0, y1, z1), vec3(x1, y1, z1), vec3(x1, y1, z0), vec3(x0, y1, z0), tile); /* +y */
  push_quad(g, vec3(x0, y0, z0), vec3(x1, y0, z0), vec3(x1, y0, z1), vec3(x0, y0, z1), tile); /* -y */
  return true;
}

/* The scene, laid out so that nothing is symmetric enough to hide a transposed matrix or a swapped
 * axis: the pillars are a ring with a gap, and the boxes climb in one direction. */
static bool build_scene(SceneGeometry *g) {
  ScenePart *floor = add_part(g);
  if (floor == NULL) return false;
  floor->first = (int)g->vertex_count;
  if (!push_box(g, vec3(0.0f, -0.25f, 0.0f), vec3(6.0f, 0.25f, 6.0f), 12.0f)) return false;
  floor->count = (int)g->vertex_count - floor->first;
  floor->texture = 0;                       /* checker, nearest + repeat: 12 tiles across */
  floor->tint[0] = 0.85f; floor->tint[1] = 0.85f; floor->tint[2] = 0.9f;

  /* Seven pillars around a circle with one place left empty. An eighth would make the image
     rotationally symmetric, and a symmetric image is one a flipped axis can survive. */
  for (int i = 0; i < 7; i++) {
    float angle = (float)i * 0.7853981634f;   /* pi/4 */
    ScenePart *pillar = add_part(g);
    if (pillar == NULL) return false;
    pillar->first = (int)g->vertex_count;
    if (!push_box(g, vec3(cosf(angle) * 4.0f, 1.5f, sinf(angle) * 4.0f), vec3(0.4f, 1.5f, 0.4f), 1.0f))
      return false;
    pillar->count = (int)g->vertex_count - pillar->first;
    pillar->texture = 1;                    /* gradient, linear + clamp */
    pillar->tint[0] = 0.6f + (float)i * 0.05f;
    pillar->tint[1] = 0.7f;
    pillar->tint[2] = 0.9f - (float)i * 0.05f;
  }

  /* A stack of boxes, each one drawn with its own model matrix and its own tint — this is where the
     per-draw uniform changes come from, and on Vulkan where a push-constant block gets exercised. */
  for (int i = 0; i < 5; i++) {
    ScenePart *box = add_part(g);
    if (box == NULL) return false;
    box->first = (int)g->vertex_count;
    float size = 0.7f - (float)i * 0.1f;
    if (!push_box(g, vec3(0.0f, 0.0f, 0.0f), vec3(size, size, size), 1.0f)) return false;
    box->count = (int)g->vertex_count - box->first;
    box->animate = true;
    box->texture = 0;
    box->tint[0] = 1.0f; box->tint[1] = 0.8f - (float)i * 0.12f; box->tint[2] = 0.3f;
  }

  /* An inside-out box for the backdrop: culling OFF, so a backend that always culls loses the sky
     and a backend that never culls keeps the pillars' insides. One part separates both mistakes. */
  ScenePart *sky = add_part(g);
  if (sky == NULL) return false;
  sky->first = (int)g->vertex_count;
  if (!push_box(g, vec3(0.0f, 0.0f, 0.0f), vec3(20.0f, 20.0f, 20.0f), 1.0f)) return false;
  sky->count = (int)g->vertex_count - sky->first;
  sky->cull = false;
  sky->backdrop = true;      /* it surrounds the scene, so it must not decide where the camera goes */
  sky->texture = 1;
  sky->tint[0] = 0.15f; sky->tint[1] = 0.18f; sky->tint[2] = 0.28f;
  return true;
}

/* A loaded model is in whatever units its author used — Crytek Sponza is about 1400 across — so the
 * camera is placed from the geometry rather than from a number that happened to suit a scene six
 * units wide. The built-in scene goes through the same path.
 *
 * Backdrop parts are excluded, and that has to be a flag the part carries rather than a rule about
 * which geometry is "the subject". The first version measured everything, the ±20 sky box decided
 * the radius, and the camera was placed outside the sky looking at its back — a black frame. A
 * loaded model has no backdrops, so it takes the same path with nothing excluded. */
static void measure(SceneGeometry *g, Vec3 *centre, float *radius) {
  float lo[3] = {0, 0, 0}, hi[3] = {0, 0, 0};
  bool any = false;
  for (size_t part = 0; part < g->part_count; part++) {
    if (g->parts[part].backdrop) continue;
    int first = g->parts[part].first, count = g->parts[part].count;
    for (int i = first; i < first + count; i++) {
      const float p[3] = {g->vertices[i].px, g->vertices[i].py, g->vertices[i].pz};
      for (int k = 0; k < 3; k++) {
        if (!any || p[k] < lo[k]) lo[k] = p[k];
        if (!any || p[k] > hi[k]) hi[k] = p[k];
      }
      any = true;
    }
  }
  if (!any) { *centre = vec3(0, 0, 0); *radius = 1.0f; return; }
  *centre = vec3((lo[0] + hi[0]) * 0.5f, (lo[1] + hi[1]) * 0.5f, (lo[2] + hi[2]) * 0.5f);
  Vec3 extent = vec3(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  *radius = sqrtf(vec3_dot(extent, extent)) * 0.5f;
  if (*radius <= 0.0f) *radius = 1.0f;
}

void scene_geometry_free(SceneGeometry *geometry) {
  free(geometry->vertices);
  free(geometry->parts);
  memset(geometry, 0, sizeof(*geometry));
}

/* ---- textures ------------------------------------------------------------------------------------ */

/* A checker at NEAREST and REPEAT, and a gradient at LINEAR and CLAMP. The pair is chosen so the two
 * filters and the two wrap modes are all visible in one frame: the floor tiles twelve times (repeat)
 * with hard edges (nearest), and the pillars show a smooth ramp (linear) that does not wrap. */
static ReSeamTexture make_checker(ReSeam *seam) {
  static unsigned char pixels[CHECKER_SIZE * CHECKER_SIZE * 4];
  for (int y = 0; y < CHECKER_SIZE; y++)
    for (int x = 0; x < CHECKER_SIZE; x++) {
      bool dark = ((x / 4) + (y / 4)) % 2 == 0;
      unsigned char *p = &pixels[(y * CHECKER_SIZE + x) * 4];
      p[0] = dark ? 60 : 215; p[1] = dark ? 64 : 210; p[2] = dark ? 74 : 200; p[3] = 255;
    }
  return re_seam_texture_2d(seam, pixels, CHECKER_SIZE, CHECKER_SIZE, RE_SEAM_FILTER_NEAREST,
                            RE_SEAM_WRAP_REPEAT);
}

static ReSeamTexture make_gradient(ReSeam *seam) {
  static unsigned char pixels[GRADIENT_SIZE * GRADIENT_SIZE * 4];
  for (int y = 0; y < GRADIENT_SIZE; y++)
    for (int x = 0; x < GRADIENT_SIZE; x++) {
      unsigned char *p = &pixels[(y * GRADIENT_SIZE + x) * 4];
      p[0] = (unsigned char)(255 * y / GRADIENT_SIZE);
      p[1] = (unsigned char)(200 - 100 * y / GRADIENT_SIZE);
      p[2] = (unsigned char)(120 + 100 * x / GRADIENT_SIZE);
      p[3] = 255;
    }
  return re_seam_texture_2d(seam, pixels, GRADIENT_SIZE, GRADIENT_SIZE, RE_SEAM_FILTER_LINEAR,
                            RE_SEAM_WRAP_CLAMP_TO_EDGE);
}

/* ---- shaders ---------------------------------------------------------------------------------
 * Generated from the shaders/ sources into both dialects at once: OpenGL 3.30 source and Vulkan SPIR-V,
 * committed so a consumer needs no shader toolchain to build. `ReSeamShader` carries both and each
 * backend takes its own half, which is the whole reason the seam takes a descriptor rather than a
 * source string — see spec 123. Regenerate with `python3 shaders/generate.py generate`. */
#include "shaders/scene_shaders.h"

#define STAGE(symbol) \
  ((ReSeamShader){.glsl = re_scene_##symbol##_glsl, .spirv = re_scene_##symbol##_spv, \
                  .spirv_bytes = sizeof(re_scene_##symbol##_spv), .msl = re_scene_##symbol##_msl})

static ReSeamProgram program_of(ReSeam *seam, ReSeamShader vertex, ReSeamShader fragment, const char *name) {
  return re_seam_program(seam, &vertex, &fragment, name);
}

/* ---- open and close -------------------------------------------------------------------------------- */

bool scene_open(Scene *scene, ReSeam *seam, int width, int height, const char *model_path,
                char *error, size_t error_size) {
  memset(scene, 0, sizeof(*scene));
  scene->width = width;
  scene->height = height;
  scene->orbit = 1.15f;
  scene->eye_height = 0.25f;

  if (model_path != NULL) {
    if (!scene_load_obj(&scene->geometry, model_path, error, error_size)) return false;
    scene->loaded_model = true;
  } else if (!build_scene(&scene->geometry)) {
    snprintf(error, error_size, "out of memory building the scene");
    return false;
  }

  measure(&scene->geometry, &scene->centre, &scene->radius);

  scene->lit = program_of(seam, STAGE(lit_vertex), STAGE(lit_fragment), "lit");
  scene->flat = program_of(seam, STAGE(flat_vertex), STAGE(flat_fragment), "flat");
  scene->screen = program_of(seam, STAGE(screen_vertex), STAGE(screen_fragment), "screen");
  if (scene->lit.id == 0 || scene->flat.id == 0 || scene->screen.id == 0) {
    snprintf(error, error_size, "a program did not build; the seam reported why");
    return false;
  }
  scene->lit_view_proj = re_seam_uniform_location(seam, scene->lit, "u_view_proj");
  scene->lit_model = re_seam_uniform_location(seam, scene->lit, "u_model");
  scene->lit_tint = re_seam_uniform_location(seam, scene->lit, "u_tint");
  scene->lit_texture = re_seam_uniform_location(seam, scene->lit, "u_texture");
  scene->lit_light = re_seam_uniform_location(seam, scene->lit, "u_light");
  scene->flat_view_proj = re_seam_uniform_location(seam, scene->flat, "u_view_proj");
  scene->flat_model = re_seam_uniform_location(seam, scene->flat, "u_model");
  scene->flat_tint = re_seam_uniform_location(seam, scene->flat, "u_tint");
  scene->screen_texture = re_seam_uniform_location(seam, scene->screen, "u_texture");
  scene->screen_extent = re_seam_uniform_location(seam, scene->screen, "u_extent");

  /* A uniform the shader does not expose comes back as -1, and writing to -1 is silently ignored by
     every backend — so the scene renders, plausibly, with that value missing. That is exactly how
     the first version of the shader generator failed: a macro the GLSL preprocessor would not expand
     left every uniform undeclared, the programs compiled and linked without a word, and the frame
     was black. Nothing downstream could have told anyone why. It is a refusal now. */
  const struct { const char *name; int location; } required[] = {
    {"lit u_view_proj", scene->lit_view_proj}, {"lit u_model", scene->lit_model},
    {"lit u_tint", scene->lit_tint}, {"lit u_texture", scene->lit_texture},
    {"lit u_light", scene->lit_light}, {"flat u_view_proj", scene->flat_view_proj},
    {"flat u_model", scene->flat_model}, {"flat u_tint", scene->flat_tint},
    {"screen u_texture", scene->screen_texture}, {"screen u_extent", scene->screen_extent},
  };
  for (size_t i = 0; i < sizeof(required) / sizeof(required[0]); i++)
    if (required[i].location < 0) {
      snprintf(error, error_size, "the shaders do not expose %s; writing to it would be ignored and "
               "the frame would render without it", required[i].name);
      return false;
    }
  scene->buffer = re_seam_buffer(seam);
  re_seam_buffer_update(seam, scene->buffer, scene->geometry.vertices,
                        scene->geometry.vertex_count * sizeof(SceneVertex), RE_SEAM_BUFFER_STATIC);
  const ReSeamVertexAttribute attributes[3] = {
    {0, 3, offsetof(SceneVertex, px)},
    {1, 3, offsetof(SceneVertex, nx)},
    {2, 2, offsetof(SceneVertex, u)},
  };
  const ReSeamVertexLayout layout = {attributes, 3, sizeof(SceneVertex)};
  scene->array = re_seam_vertex_array(seam, scene->buffer, &layout);

  /* The overlay and the mirror quad share one buffer of two clip-space triangles. */
  static const SceneVertex quad[6] = {
    {-1, -1, 0, 0, 0, 1, 0, 0}, {1, -1, 0, 0, 0, 1, 1, 0}, {1, 1, 0, 0, 0, 1, 1, 1},
    {-1, -1, 0, 0, 0, 1, 0, 0}, {1, 1, 0, 0, 0, 1, 1, 1}, {-1, 1, 0, 0, 0, 1, 0, 1},
  };
  scene->overlay_buffer = re_seam_buffer(seam);
  re_seam_buffer_update(seam, scene->overlay_buffer, quad, sizeof(quad), RE_SEAM_BUFFER_STATIC);
  scene->overlay_array = re_seam_vertex_array(seam, scene->overlay_buffer, &layout);

  scene->checker = make_checker(seam);
  scene->gradient = make_gradient(seam);

  /* The off-screen pass renders the same scene from a second viewpoint into a quarter-size target,
     which a later draw samples. Quarter size on purpose: a backend that used the wrong viewport
     would fill it correctly at full size and wrongly here. */
  int mirror_w = width / 4, mirror_h = height / 4;
  scene->mirror_color = re_seam_texture_2d_for(seam, NULL, mirror_w, mirror_h, RE_SEAM_FILTER_LINEAR,
                                               RE_SEAM_WRAP_CLAMP_TO_EDGE, RE_SEAM_TEXTURE_COLOR);
  scene->mirror_depth = re_seam_texture_2d_for(seam, NULL, mirror_w, mirror_h, RE_SEAM_FILTER_NEAREST,
                                               RE_SEAM_WRAP_CLAMP_TO_EDGE, RE_SEAM_TEXTURE_DEPTH);
  scene->mirror = re_seam_target(seam, scene->mirror_color, scene->mirror_depth);
  if (scene->mirror.id == 0) {
    snprintf(error, error_size, "the off-screen target was not complete; the seam reported why");
    return false;
  }
  return true;
}

void scene_close(Scene *scene, ReSeam *seam) {
  re_seam_target_destroy(seam, &scene->mirror);
  re_seam_texture_destroy(seam, &scene->mirror_color);
  re_seam_texture_destroy(seam, &scene->mirror_depth);
  re_seam_texture_destroy(seam, &scene->checker);
  re_seam_texture_destroy(seam, &scene->gradient);
  re_seam_vertex_array_destroy(seam, &scene->array);
  re_seam_vertex_array_destroy(seam, &scene->overlay_array);
  re_seam_buffer_destroy(seam, &scene->buffer);
  re_seam_buffer_destroy(seam, &scene->overlay_buffer);
  re_seam_program_destroy(seam, &scene->lit);
  re_seam_program_destroy(seam, &scene->flat);
  re_seam_program_destroy(seam, &scene->screen);
  scene_geometry_free(&scene->geometry);
}

/* ---- the frame -------------------------------------------------------------------------------------- */

/* Where the spinning boxes are at `frame`. Pulled out so the off-screen pass and the main pass agree
 * without recomputing, and so the animation is obviously a pure function of the frame number. */
static Mat4 box_transform(int index, int frame) {
  float t = (float)frame * 0.02f;
  float lift = 1.0f + (float)index * 0.85f;
  Mat4 spin = mat4_rotate_y(t + (float)index * 0.6f);
  Mat4 tilt = mat4_rotate_x(t * 0.4f);
  return mat4_multiply(mat4_translate(0.0f, lift, 0.0f), mat4_multiply(spin, tilt));
}

static void draw_parts(Scene *scene, ReSeam *seam, Mat4 view_proj, int frame) {
  re_seam_program_use(seam, scene->lit);
  re_seam_uniform_mat4(seam, scene->lit_view_proj, view_proj.m);
  re_seam_uniform_int(seam, scene->lit_texture, 0);
  re_seam_uniform_vec4(seam, scene->lit_light, 0.4f, 0.8f, 0.45f, 0.0f);
  re_seam_vertex_array_bind(seam, scene->array);

  int box = 0;
  for (size_t i = 0; i < scene->geometry.part_count; i++) {
    const ScenePart *part = &scene->geometry.parts[i];
    /* A part says whether it animates. The first version inferred it from the tint's blue channel,
       and the backdrop's blue happened to fall under the threshold — so the sky box was given the
       spinning-box transform and swung through the scene, hiding the floor from the overhead pass.
       Sniffing a value to recover an intent the data could have carried is how that happens. */
    Mat4 model = part->animate ? box_transform(box++, frame) : part->model;

    re_seam_cull(seam, part->cull ? RE_SEAM_CULL_BACK : RE_SEAM_CULL_NONE);
    re_seam_depth(seam, RE_SEAM_DEPTH_TEST_ENABLED,
                  part->depth_write ? RE_SEAM_DEPTH_WRITE_ENABLED : RE_SEAM_DEPTH_WRITE_DISABLED);
    re_seam_texture_bind(seam, part->texture == 1 ? scene->gradient : scene->checker, 0);
    re_seam_uniform_mat4(seam, scene->lit_model, model.m);
    re_seam_uniform_vec4(seam, scene->lit_tint, part->tint[0], part->tint[1], part->tint[2], part->tint[3]);
    re_seam_draw(seam, RE_SEAM_PRIMITIVE_TRIANGLES, part->first, part->count);
  }
}

void scene_draw(Scene *scene, ReSeam *seam, ReSeamTarget target, int frame) {
  float t = (float)frame * 0.02f;
  float r = scene->radius;
  Mat4 projection = mat4_perspective(1.0471975512f, (float)scene->width / (float)scene->height,
                                     r * 0.01f, r * 8.0f);
  Vec3 focus = vec3(scene->centre.x, scene->centre.y - r * 0.15f, scene->centre.z);
  Vec3 eye = vec3(scene->centre.x + cosf(t * 0.3f) * r * scene->orbit,
                  scene->centre.y + r * scene->eye_height,
                  scene->centre.z + sinf(t * 0.3f) * r * scene->orbit);
  Mat4 view = mat4_look_at(eye, focus, vec3(0.0f, 1.0f, 0.0f));
  Mat4 view_proj = mat4_multiply(projection, view);

  re_seam_frame_begin(seam, target);

  /* Pass one, off-screen and from above: the render target F129 added, at a quarter size. */
  re_seam_target_bind(seam, scene->mirror);
  re_seam_viewport(seam, 0, 0, scene->mirror.width, scene->mirror.height);
  re_seam_blend(seam, RE_SEAM_BLEND_NONE);
  /* Depth writes MUST be on to clear depth — the seam documents this and preserves it deliberately,
     and this frame walked straight into it. The overlay at the end of the previous frame leaves
     writes off, so from frame one the clear silently did nothing, the overhead pass met its own
     stale depth, and the static floor failed LESS against itself while the moving boxes sometimes
     passed. It looked like a broken render target. It was a state the call site owns. */
  re_seam_depth(seam, RE_SEAM_DEPTH_TEST_ENABLED, RE_SEAM_DEPTH_WRITE_ENABLED);
  re_seam_clear(seam, 0.05f, 0.06f, 0.09f, 1.0f, true);
  Mat4 above = mat4_look_at(vec3(scene->centre.x, scene->centre.y + r * 1.4f, scene->centre.z + r * 0.001f),
                            scene->centre, vec3(0.0f, 1.0f, 0.0f));
  draw_parts(scene, seam, mat4_multiply(projection, above), frame);

  /* Pass two, the frame's own target. */
  re_seam_target_bind(seam, (ReSeamTarget){0, 0, 0});
  re_seam_viewport(seam, 0, 0, scene->width, scene->height);
  re_seam_depth(seam, RE_SEAM_DEPTH_TEST_ENABLED, RE_SEAM_DEPTH_WRITE_ENABLED);
  re_seam_clear(seam, 0.02f, 0.02f, 0.04f, 1.0f, true);
  draw_parts(scene, seam, view_proj, frame);

  /* A decal, drawn twice from the SAME geometry to make the depth compare function decisive.

     The first attempt laid it exactly on the floor and relied on LESS_EQUAL to let it tie with the
     floor's depth. That is z-fighting: the two planes come from different geometry, so their
     interpolated depths differ in the last bits and each rasteriser resolves the tie its own way —
     4,737 pixels apart between the backends, 133 of them nowhere near an edge. It was testing
     floating point, not the seam.

     So the decal sits clear of the floor and primes its own depth first. The second pass is the same
     quad at the same depth, blended: under LESS_EQUAL it draws over the first and the decal ends up
     a blend of the two colours; under LESS it is rejected and the decal stays the first colour
     alone. Identical geometry means identical depth on both backends, so the comparison is decisive
     rather than a coin toss. This is the depth-pre-pass pattern vtmb-vr makes fourteen glDepthFunc
     calls for. */
  Mat4 decal = mat4_multiply(mat4_translate(scene->centre.x, r * 0.004f, scene->centre.z),
                             mat4_multiply(mat4_rotate_x(-1.5707963268f),
                                           mat4_scale(r * 0.22f, r * 0.22f, 1.0f)));
  re_seam_program_use(seam, scene->flat);
  re_seam_uniform_mat4(seam, scene->flat_view_proj, view_proj.m);
  re_seam_uniform_mat4(seam, scene->flat_model, decal.m);
  re_seam_cull(seam, RE_SEAM_CULL_NONE);
  re_seam_vertex_array_bind(seam, scene->overlay_array);
  re_seam_blend(seam, RE_SEAM_BLEND_NONE);
  re_seam_depth(seam, RE_SEAM_DEPTH_TEST_ENABLED, RE_SEAM_DEPTH_WRITE_ENABLED);
  re_seam_uniform_vec4(seam, scene->flat_tint, 0.95f, 0.35f, 0.15f, 1.0f);
  re_seam_draw(seam, RE_SEAM_PRIMITIVE_TRIANGLES, 0, 6);

  re_seam_depth(seam, RE_SEAM_DEPTH_TEST_ENABLED, RE_SEAM_DEPTH_WRITE_DISABLED);
  re_seam_depth_compare(seam, RE_SEAM_DEPTH_LESS_EQUAL);
  re_seam_blend(seam, RE_SEAM_BLEND_ALPHA);
  re_seam_uniform_vec4(seam, scene->flat_tint, 0.1f, 0.35f, 0.95f, 0.6f);
  re_seam_draw(seam, RE_SEAM_PRIMITIVE_TRIANGLES, 0, 6);
  re_seam_depth_compare(seam, RE_SEAM_DEPTH_LESS);
  re_seam_blend(seam, RE_SEAM_BLEND_NONE);

  /* The off-screen result, shown in the corner with depth off — the sample that proves pass one
     rendered somewhere other than here. */
  re_seam_depth(seam, RE_SEAM_DEPTH_TEST_DISABLED, RE_SEAM_DEPTH_WRITE_DISABLED);
  re_seam_cull(seam, RE_SEAM_CULL_NONE);
  re_seam_program_use(seam, scene->screen);
  re_seam_uniform_int(seam, scene->screen_texture, 0);
  re_seam_uniform_vec2(seam, scene->screen_extent, 0.28f, 0.28f);
  re_seam_texture_bind(seam, scene->mirror_color, 0);
  re_seam_vertex_array_bind(seam, scene->overlay_array);
  re_seam_draw(seam, RE_SEAM_PRIMITIVE_TRIANGLES, 0, 6);

  /* A translucent band across the bottom, blended, drawn with the flat program: the last thing in
     the frame, as a UI layer is, and the only user of the third program. */
  re_seam_program_use(seam, scene->flat);
  re_seam_uniform_mat4(seam, scene->flat_view_proj, mat4_identity().m);
  re_seam_uniform_mat4(seam, scene->flat_model,
                       mat4_multiply(mat4_translate(0.0f, -0.82f, 0.0f), mat4_scale(1.0f, 0.18f, 1.0f)).m);
  re_seam_uniform_vec4(seam, scene->flat_tint, 0.1f, 0.75f, 0.95f, 0.45f);
  re_seam_blend(seam, RE_SEAM_BLEND_ALPHA);
  re_seam_draw(seam, RE_SEAM_PRIMITIVE_TRIANGLES, 0, 6);
  re_seam_blend(seam, RE_SEAM_BLEND_NONE);

  re_seam_frame_end(seam);
}
