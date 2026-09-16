/* The draw list rendered through the pack's seam (spec 124, F133). */
#ifndef RENGINE_BACKEND_SEAM_H
#define RENGINE_BACKEND_SEAM_H
#include "render/backend.h"
#include <stdint.h>
uint32_t re_backend_seam_window_flags(void);
/* `window` is opaque: SDL_Window* on the desktop, ANativeWindow* on Android. See seam_host.h. */
ReBackend *re_backend_seam_open(void *window, ReFontSet *fonts);
/* The seam this copy calls, as a table of pointers, for the plugin render extension (charter D55).
 * Declared here because this family is one of the names tools/seam_prefix.py renames, so each copy
 * exports its own — which is exactly what a runtime `--renderer` switch needs. plugin_seam.c fills
 * it; the seam pointer to pass to its members is this backend's, from re_backend_seam_seam(). */
const struct RePluginRender *re_backend_seam_plugin_table(void);
/* This backend's seam, for the same extension. Opaque to everything that is not the pack. */
struct ReSeam *re_backend_seam_seam(ReBackend *backend);
#endif
