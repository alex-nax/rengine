#pragma once
#include <SDL.h>

#if defined(_WIN32)
#if defined(RENGINE_SURFACE_BUILD)
#define RENGINE_SURFACE_API __declspec(dllexport)
#else
#define RENGINE_SURFACE_API __declspec(dllimport)
#endif
#else
#define RENGINE_SURFACE_API __attribute__((visibility("default")))
#endif

// Call on the GL context's thread immediately before every SDL_GL_SwapWindow.
extern "C" RENGINE_SURFACE_API void rengine_surface_before_swap(SDL_Window* window);
// Drain these events before polling the host SDL queue, on the same main thread.
extern "C" RENGINE_SURFACE_API int rengine_surface_next_event(SDL_Event* event);
extern "C" RENGINE_SURFACE_API bool rengine_surface_enabled();
