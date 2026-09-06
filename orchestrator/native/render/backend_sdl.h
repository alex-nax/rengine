/* SDL reference adapter (spec 067). Only render/backend_*.c may use SDL rendering, OpenGL, Metal or Vulkan symbols. */
#ifndef RENGINE_BACKEND_SDL_H
#define RENGINE_BACKEND_SDL_H
#include <SDL.h>
#include "render/backend.h"
ReBackend *re_backend_sdl_open(SDL_Window *window, ReFontSet *fonts);
#endif
