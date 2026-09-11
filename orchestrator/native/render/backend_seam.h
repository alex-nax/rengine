/* The draw list rendered through the pack's seam (spec 124, F133). */
#ifndef RENGINE_BACKEND_SEAM_H
#define RENGINE_BACKEND_SEAM_H
#include "render/backend.h"
#include <SDL.h>
Uint32 re_backend_seam_window_flags(void);
ReBackend *re_backend_seam_open(SDL_Window *window, ReFontSet *fonts);
#endif
