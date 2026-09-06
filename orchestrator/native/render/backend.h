/* Adapter interface consumed by the draw-list glue; implemented per graphics API (spec 067). */
#ifndef RENGINE_BACKEND_H
#define RENGINE_BACKEND_H
#include "render/draw_list.h"
#include "render/font.h"

typedef struct ReBackend ReBackend;
typedef struct {
  const char *name;
  float (*density)(ReBackend *backend, int logical_width);
  bool (*begin)(ReBackend *backend, const ReDrawList *list);
  void (*execute)(ReBackend *backend, const ReDrawList *list);
  void (*present)(ReBackend *backend);
  bool (*snapshot)(ReBackend *backend, const char *path);
  ReTexture *(*texture_create)(ReBackend *backend, int width, int height);
  bool (*texture_update)(ReTexture *texture, const void *rgba, int pitch);
  void (*texture_destroy)(ReTexture *texture);
  void (*close)(ReBackend *backend);
} ReBackendOps;

struct ReBackend { const ReBackendOps *ops; ReFontSet *fonts; };
struct ReTexture { ReBackend *owner; int width, height; };
#endif
