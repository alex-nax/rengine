/* Metal adapter (spec 072). Only render/backend_*.c and render/backend_*.m may use Metal symbols. */
#ifndef RENGINE_BACKEND_METAL_H
#define RENGINE_BACKEND_METAL_H
#include <SDL.h>
#include "render/backend.h"
Uint32 re_backend_metal_window_flags(void);                             /* returns SDL_WINDOW_METAL */
ReBackend *re_backend_metal_open(SDL_Window *window, ReFontSet *fonts); /* NULL with SDL_SetError on any failure */
#endif
