#include <SDL.h>
#include <SDL_opengl.h>
#include <cstdio>
#ifdef _WIN32
#include "surface.h"
#endif

int main(int argc, char**) {
    if (SDL_Init(SDL_INIT_VIDEO) != 0) return 2;
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 2);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
    SDL_Window* window = SDL_CreateWindow("rEngine surface test", 0, 0, 64, 32, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
    if (!window) return 3;
    const auto context = SDL_GL_CreateContext(window);
    if (!context) return 4;
    bool pressed = false;
    for (int frame = 0; frame < (argc > 1 ? 6000 : 1000); ++frame) {
        SDL_Event event{};
        for (;;) {
#ifdef _WIN32
            const int available = rengine_surface_next_event(&event) || SDL_PollEvent(&event);
#else
            const int available = SDL_PollEvent(&event);
#endif
            if (!available) break;
            if (event.type == SDL_KEYDOWN && event.key.keysym.scancode == SDL_SCANCODE_W) pressed = true;
            if (event.type == SDL_KEYUP && event.key.keysym.scancode == SDL_SCANCODE_W) pressed = false;
            if (event.type == SDL_MOUSEBUTTONDOWN || event.type == SDL_MOUSEBUTTONUP)
                std::printf("button %u %u %d %d\n", event.button.button, event.button.state, event.button.x, event.button.y);
            if (event.type == SDL_KEYDOWN || event.type == SDL_KEYUP)
                std::printf("key %d %u\n", event.key.keysym.scancode, event.key.state);
            std::fflush(stdout);
        }
        glDisable(GL_SCISSOR_TEST);
        glClearColor(pressed ? 0.0f : 1.0f, pressed ? 1.0f : 0.0f, 0.0f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);
        glEnable(GL_SCISSOR_TEST); glScissor(0, 0, 64, 8);
        glClearColor(0, 0, 1, 1); glClear(GL_COLOR_BUFFER_BIT); glDisable(GL_SCISSOR_TEST);
        glPixelStorei(GL_PACK_ALIGNMENT, 8); glPixelStorei(GL_PACK_ROW_LENGTH, 17);
#ifdef _WIN32
        rengine_surface_before_swap(window);
#endif
        SDL_GL_SwapWindow(window);
        GLint alignment = 0, rowLength = 0;
        glGetIntegerv(GL_PACK_ALIGNMENT, &alignment); glGetIntegerv(GL_PACK_ROW_LENGTH, &rowLength);
        if (alignment != 8 || rowLength != 17) { std::fprintf(stderr, "Pixel-pack state changed\n"); return 5; }
        SDL_Delay(10);
    }
    SDL_GL_DeleteContext(context); SDL_DestroyWindow(window); SDL_Quit(); return 0;
}
