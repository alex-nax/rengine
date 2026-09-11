/* The draw list rendered through the pack's seam (spec 124, F133). */
#ifndef RENGINE_BACKEND_SEAM_H
#define RENGINE_BACKEND_SEAM_H
#include "render/backend.h"
#include <stdint.h>
uint32_t re_backend_seam_window_flags(void);
/* `window` is opaque: SDL_Window* on the desktop, ANativeWindow* on Android. See seam_host.h. */
ReBackend *re_backend_seam_open(void *window, ReFontSet *fonts);
#endif
