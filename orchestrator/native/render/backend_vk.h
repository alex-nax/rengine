/* Vulkan adapter (spec 073). Only render/backend_*.c and render/backend_*.m may use Vulkan symbols. */
#ifndef RENGINE_BACKEND_VK_H
#define RENGINE_BACKEND_VK_H
#include <SDL.h>
#include "render/backend.h"
Uint32 re_backend_vk_window_flags(void);                             /* returns SDL_WINDOW_VULKAN */
ReBackend *re_backend_vk_open(SDL_Window *window, ReFontSet *fonts); /* NULL with SDL_SetError on any failure */
#endif
