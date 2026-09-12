/* A minimal OBJ reader, for the example's optional --scene (F132, spec 124).
 *
 * WHY NOT tinyobjloader. It is C++ and about two thousand lines, and it would be a vendored
 * dependency of a pack whose whole claim is that a consumer can add it and build. Nothing in this
 * repository's tests loads a model at all; this exists so a person can point the example at Sponza
 * and get frame times that mean something next to other renderers' published numbers.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. Materials are not loaded — no .mtl, no textures, no colours. A
 * `usemtl` line starts a new part, so the model arrives as many draws rather than one (which is the
 * property that matters here: Sponza is 393 parts, and that is a real test of per-draw state), but
 * every part renders with the example's own procedural texture. Loading materials would mean a PNG
 * decoder and a material model, and the example would become a renderer instead of a seam consumer.
 * This is a stated limit, not an unfinished stub.
 */
#include "scene.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { float *values; size_t count, capacity; int stride; } FloatList;

static bool push_floats(FloatList *list, const float *values) {
  if (list->count + (size_t)list->stride > list->capacity) {
    size_t capacity = list->capacity ? list->capacity * 2 : 4096;
    float *grown = realloc(list->values, capacity * sizeof(float));
    if (grown == NULL) return false;
    list->values = grown;
    list->capacity = capacity;
  }
  for (int i = 0; i < list->stride; i++) list->values[list->count++] = values[i];
  return true;
}

/* OBJ indices are 1-based and may be negative, counting back from the end. Getting that wrong
 * silently renders a shuffled mesh, so it is one function used by every lookup. */
static size_t resolve(long index, size_t have) {
  if (index > 0) return (size_t)(index - 1);
  if (index < 0 && (size_t)(-index) <= have) return have - (size_t)(-index);
  return (size_t)-1;
}

static bool ensure_capacity(SceneGeometry *g, size_t extra) {
  if (g->vertex_count + extra <= g->vertex_capacity) return true;
  size_t capacity = g->vertex_capacity ? g->vertex_capacity : 65536;
  while (capacity < g->vertex_count + extra) capacity *= 2;
  SceneVertex *grown = realloc(g->vertices, capacity * sizeof(*grown));
  if (grown == NULL) return false;
  g->vertices = grown;
  g->vertex_capacity = capacity;
  return true;
}


/* ---- materials ------------------------------------------------------------------------------
 * `mtllib` and `usemtl` are read; the images are NOT. The reason is the one at the top of this
 * file: a decoder here would make a seam consumer into a renderer. So the paths are resolved and
 * handed on, and whoever owns a decoder supplies the textures (scene_material_texture).
 */
static void directory_of(const char *path, char *out, size_t size) {
  const char *slash = strrchr(path, '/');
  size_t n = slash ? (size_t)(slash - path) : 0;
  if (n >= size) n = size - 1;
  memcpy(out, path, n); out[n] = 0;
}
static void resolve_beside(const char *dir, const char *name, char *out, size_t size) {
  while (*name == ' ' || *name == '\t') name++;
  if (*name == '/' || !*dir) snprintf(out, size, "%s", name);
  else snprintf(out, size, "%s/%s", dir, name);
  /* A .mtl carries whatever separator the machine that exported it used, and Sponza's came out of
     3ds Max on Windows: `textures\sponza_thorn_diff.png`. Every one of its 24 maps is unopenable
     here until that is a slash, and the model draws in flat Kd colours with nothing saying why. */
  for (char *at = out; *at; at++) if (*at == '\\') *at = '/';
}
static void trim(char *text) {
  size_t n = strlen(text);
  while (n && (text[n - 1] == '\n' || text[n - 1] == '\r' || text[n - 1] == ' ' || text[n - 1] == '\t')) text[--n] = 0;
}
static SceneMaterial *begin_material(SceneGeometry *g, const char *name) {
  if (g->material_count == SCENE_MATERIALS_MAX) return NULL;
  if (g->material_count == g->material_capacity) {
    size_t capacity = g->material_capacity ? g->material_capacity * 2 : 32;
    if (capacity > SCENE_MATERIALS_MAX) capacity = SCENE_MATERIALS_MAX;
    SceneMaterial *grown = realloc(g->materials, capacity * sizeof(*grown));
    if (grown == NULL) return NULL;
    g->materials = grown; g->material_capacity = capacity;
  }
  SceneMaterial *material = &g->materials[g->material_count++];
  memset(material, 0, sizeof(*material));
  snprintf(material->name, sizeof(material->name), "%s", name);
  material->kd[0] = material->kd[1] = material->kd[2] = 1.0f;
  return material;
}
static int material_named(const SceneGeometry *g, const char *name) {
  for (size_t i = 0; i < g->material_count; i++) if (!strcmp(g->materials[i].name, name)) return (int)i;
  return -1;
}
/* A .mtl is read for exactly two things: the diffuse colour and the diffuse map. Everything else an
   exporter writes -- specular, bump, illumination models -- is skipped rather than half-understood. */
static void load_mtl(SceneGeometry *geometry, const char *path, const char *dir) {
  FILE *file = fopen(path, "rb");
  if (file == NULL) return;               /* a model without its .mtl still draws, in its Kd default */
  char line[1024];
  SceneMaterial *material = NULL;
  while (fgets(line, sizeof(line), file) != NULL) {
    trim(line);
    /* Exporters indent everything under `newmtl`, with tabs -- 3ds Max's does, which is what
       Sponza's own .mtl came out of. Matching the raw line found none of these keys and the model
       arrived with every part its default tint and no map: a whole material system skipped by one
       leading tab. */
    char *key = line;
    while (*key == ' ' || *key == '\t') key++;
    if (strncmp(key, "newmtl", 6) == 0) {
      const char *name = key + 6; while (*name == ' ' || *name == '\t') name++;
      material = begin_material(geometry, name);
    } else if (material != NULL && strncmp(key, "map_Kd", 6) == 0) {
      resolve_beside(dir, key + 6, material->map, sizeof(material->map));
    } else if (material != NULL && strncmp(key, "Kd", 2) == 0 && (key[2] == ' ' || key[2] == '\t')) {
      sscanf(key + 3, "%f %f %f", &material->kd[0], &material->kd[1], &material->kd[2]);
    }
  }
  fclose(file);
}

static ScenePart *begin_part(SceneGeometry *g) {
  if (g->part_count == g->part_capacity) {
    size_t capacity = g->part_capacity ? g->part_capacity * 2 : 64;
    ScenePart *grown = realloc(g->parts, capacity * sizeof(*grown));
    if (grown == NULL) return NULL;
    g->parts = grown;
    g->part_capacity = capacity;
  }
  ScenePart *part = &g->parts[g->part_count++];
  memset(part, 0, sizeof(*part));
  part->model = mat4_identity();
  part->first = (int)g->vertex_count;
  part->tint[0] = 0.82f; part->tint[1] = 0.80f; part->tint[2] = 0.76f; part->tint[3] = 1.0f;
  part->texture = 1;
  part->material = -1;
  /* Two-sided. A file's winding is its exporter's business and this reader cannot know it: Sponza's
     vault interiors are backfaces from inside the atrium, and culling them left the arches as holes
     onto the clear colour -- which reads as unlit geometry rather than absent geometry. The
     built-in scene sets `cull` per part and still exercises the seam's culling either way. */
  part->cull = false;
  part->depth_write = true;
  return part;
}

/* One "v/vt/vn" reference. Any of the three may be absent. */
typedef struct { long v, vt, vn; } Corner;

static Corner parse_corner(const char *text) {
  Corner corner = {0, 0, 0};
  corner.v = strtol(text, (char **)&text, 10);
  if (*text == '/') {
    text++;
    if (*text != '/') corner.vt = strtol(text, (char **)&text, 10);
    if (*text == '/') { text++; corner.vn = strtol(text, (char **)&text, 10); }
  }
  return corner;
}

bool scene_load_obj(SceneGeometry *geometry, const char *path, char *error, size_t error_size) {
  char directory[1024];
  directory_of(path, directory, sizeof(directory));
  FILE *file = fopen(path, "rb");
  if (file == NULL) {
    snprintf(error, error_size, "cannot open %s", path);
    return false;
  }
  memset(geometry, 0, sizeof(*geometry));
  FloatList positions = {NULL, 0, 0, 3};
  FloatList normals = {NULL, 0, 0, 3};
  FloatList uvs = {NULL, 0, 0, 2};
  ScenePart *part = NULL;
  char line[512];
  bool ok = true;

  while (ok && fgets(line, sizeof(line), file) != NULL) {
    if (line[0] == 'v' && line[1] == ' ') {
      float v[3] = {0, 0, 0};
      sscanf(line + 2, "%f %f %f", &v[0], &v[1], &v[2]);
      ok = push_floats(&positions, v);
    } else if (line[0] == 'v' && line[1] == 'n') {
      float v[3] = {0, 0, 0};
      sscanf(line + 3, "%f %f %f", &v[0], &v[1], &v[2]);
      ok = push_floats(&normals, v);
    } else if (line[0] == 'v' && line[1] == 't') {
      float v[2] = {0, 0};
      sscanf(line + 3, "%f %f", &v[0], &v[1]);
      ok = push_floats(&uvs, v);
    } else if (strncmp(line, "mtllib", 6) == 0) {
      char named[1024];
      trim(line);
      resolve_beside(directory, line + 6, named, sizeof(named));
      load_mtl(geometry, named, directory);
    } else if (strncmp(line, "usemtl", 6) == 0) {
      if (part != NULL) part->count = (int)geometry->vertex_count - part->first;
      part = begin_part(geometry);
      ok = part != NULL;
      if (ok) {
        char name[256];
        snprintf(name, sizeof(name), "%s", line + 6);
        trim(name);
        const char *trimmed = name; while (*trimmed == ' ' || *trimmed == '\t') trimmed++;
        part->material = material_named(geometry, trimmed);
        /* The material's own colour, so a part with no map still arrives its own shade rather than
           the procedural scene's default. */
        if (part->material >= 0) {
          const SceneMaterial *m = &geometry->materials[part->material];
          part->tint[0] = m->kd[0]; part->tint[1] = m->kd[1]; part->tint[2] = m->kd[2];
        }
      }
    } else if (line[0] == 'f' && line[1] == ' ') {
      if (part == NULL) { part = begin_part(geometry); if (part == NULL) { ok = false; break; } }
      /* Read the whole face, then fan it into triangles. A quad is two triangles and an n-gon is
         n-2; OBJ exporters emit both, and a reader that assumed triangles would drop half of some
         models without saying anything. */
      Corner corners[16];
      int count = 0;
      const char *cursor = line + 2;
      while (count < 16) {
        while (*cursor == ' ' || *cursor == '\t') cursor++;
        if (*cursor == '\0' || *cursor == '\n' || *cursor == '\r') break;
        corners[count++] = parse_corner(cursor);
        while (*cursor && *cursor != ' ' && *cursor != '\t' && *cursor != '\n') cursor++;
      }
      if (count < 3) continue;
      if (!ensure_capacity(geometry, (size_t)(count - 2) * 3)) { ok = false; break; }
      for (int i = 1; i + 1 < count; i++) {
        const Corner triangle[3] = {corners[0], corners[i], corners[i + 1]};
        for (int k = 0; k < 3; k++) {
          SceneVertex *out = &geometry->vertices[geometry->vertex_count++];
          memset(out, 0, sizeof(*out));
          out->rgba[0] = out->rgba[1] = out->rgba[2] = out->rgba[3] = 255;
          size_t vi = resolve(triangle[k].v, positions.count / 3);
          if (vi != (size_t)-1 && vi * 3 + 2 < positions.count) {
            out->px = positions.values[vi * 3];
            out->py = positions.values[vi * 3 + 1];
            out->pz = positions.values[vi * 3 + 2];
          }
          size_t ni = resolve(triangle[k].vn, normals.count / 3);
          if (ni != (size_t)-1 && ni * 3 + 2 < normals.count) {
            out->nx = normals.values[ni * 3];
            out->ny = normals.values[ni * 3 + 1];
            out->nz = normals.values[ni * 3 + 2];
          } else {
            out->ny = 1.0f;   /* a model with no normals still lights, flatly and visibly */
          }
          size_t ti = resolve(triangle[k].vt, uvs.count / 2);
          if (ti != (size_t)-1 && ti * 2 + 1 < uvs.count) {
            out->u = uvs.values[ti * 2];
            out->v = uvs.values[ti * 2 + 1];
          }
        }
      }
    }
  }
  if (part != NULL) part->count = (int)geometry->vertex_count - part->first;
  fclose(file);
  free(positions.values);
  free(normals.values);
  free(uvs.values);

  if (!ok) {
    scene_geometry_free(geometry);
    snprintf(error, error_size, "out of memory reading %s", path);
    return false;
  }
  if (geometry->vertex_count == 0) {
    scene_geometry_free(geometry);
    snprintf(error, error_size, "%s has no faces this reader understood", path);
    return false;
  }
  return true;
}
