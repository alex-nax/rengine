#include "surface.h"

namespace {
SDL_bool relativeMode = SDL_FALSE;
void swapWindow(SDL_Window* window) { rengine_surface_before_swap(window); SDL_GL_SwapWindow(window); }
int pollEvent(SDL_Event* event) { return rengine_surface_next_event(event) ? 1 : SDL_PollEvent(event); }
int setRelative(SDL_bool enabled) {
    if (!rengine_surface_enabled()) return SDL_SetRelativeMouseMode(enabled);
    relativeMode = enabled; return 0;
}
SDL_bool getRelative() { return rengine_surface_enabled() ? relativeMode : SDL_GetRelativeMouseMode(); }
void warpMouse(SDL_Window* window, int x, int y) { if (!rengine_surface_enabled()) SDL_WarpMouseInWindow(window, x, y); }
}
static const struct { const void* replacement; const void* original; }
hooks[] __attribute__((used, section("__DATA,__interpose"))) = {
    {reinterpret_cast<const void*>(swapWindow), reinterpret_cast<const void*>(SDL_GL_SwapWindow)},
    {reinterpret_cast<const void*>(pollEvent), reinterpret_cast<const void*>(SDL_PollEvent)},
    {reinterpret_cast<const void*>(setRelative), reinterpret_cast<const void*>(SDL_SetRelativeMouseMode)},
    {reinterpret_cast<const void*>(getRelative), reinterpret_cast<const void*>(SDL_GetRelativeMouseMode)},
    {reinterpret_cast<const void*>(warpMouse), reinterpret_cast<const void*>(SDL_WarpMouseInWindow)},
};
