/* OpenGL 3.3 core adapter (spec 068). Only render/backend_*.c may use OpenGL symbols. */
#ifndef RENGINE_BACKEND_GL_H
#define RENGINE_BACKEND_GL_H
#include <SDL.h>
#include "render/backend.h"
Uint32 re_backend_gl_window_flags(void);                             /* sets context attributes; call before SDL_CreateWindow */
ReBackend *re_backend_gl_open(SDL_Window *window, ReFontSet *fonts); /* NULL with SDL_SetError on any failure */
#endif
