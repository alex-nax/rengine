/* The OpenGL host: an SDL window, a GL context, and a framebuffer to read back from (spec 124). */
#include "host.h"

#include <SDL.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define GL_FRAMEBUFFER 0x8D40
#define GL_COLOR_ATTACHMENT0 0x8CE0
#define GL_DEPTH_ATTACHMENT 0x8D00
#define GL_TEXTURE_2D 0x0DE1
#define GL_RGBA 0x1908
#define GL_UNSIGNED_BYTE 0x1401

struct Host {
  SDL_Window *window;
  SDL_GLContext context;
  ReSeam *seam;
  ReSeamTarget target;
  ReSeamTexture color, depth;
  unsigned fbo;
  int width, height;
  bool offscreen, running;
  void (*genFramebuffers)(int, unsigned *);
  void (*bindFramebuffer)(unsigned, unsigned);
  void (*framebufferTexture2D)(unsigned, unsigned, unsigned, unsigned, int);
  void (*readPixels)(int, int, int, int, unsigned, unsigned, void *);
};

static void *load_proc(void *user, const char *name) { (void)user; return SDL_GL_GetProcAddress(name); }
static void on_message(void *user, const char *message) { (void)user; fprintf(stderr, "%s\n", message); }

Host *host_open(int width, int height, bool offscreen, char *error, size_t error_size) {
  if (SDL_Init(SDL_INIT_VIDEO) != 0) {
    snprintf(error, error_size, "SDL video unavailable (%s)", SDL_GetError());
    return NULL;
  }
  Host *host = calloc(1, sizeof(*host));
  if (host == NULL) { snprintf(error, error_size, "out of memory"); return NULL; }
  host->width = width;
  host->height = height;
  host->offscreen = offscreen;
  host->running = true;

  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS, SDL_GL_CONTEXT_FORWARD_COMPATIBLE_FLAG);
  SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
  Uint32 flags = SDL_WINDOW_OPENGL | (offscreen ? SDL_WINDOW_HIDDEN : SDL_WINDOW_SHOWN);
  host->window = SDL_CreateWindow("rengine-gpu scene", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
                                  width, height, flags);
  if (host->window == NULL) { snprintf(error, error_size, "no window (%s)", SDL_GetError()); return NULL; }
  host->context = SDL_GL_CreateContext(host->window);
  if (host->context == NULL) { snprintf(error, error_size, "no GL context (%s)", SDL_GetError()); return NULL; }

  ReSeamOpen options = {0};
  options.get_proc = load_proc;
  options.on_message = on_message;
  host->seam = re_seam_open(&options, error, error_size);
  if (host->seam == NULL) return NULL;

  if (offscreen) {
    host->genFramebuffers = (void (*)(int, unsigned *))SDL_GL_GetProcAddress("glGenFramebuffers");
    host->bindFramebuffer = (void (*)(unsigned, unsigned))SDL_GL_GetProcAddress("glBindFramebuffer");
    host->framebufferTexture2D = (void (*)(unsigned, unsigned, unsigned, unsigned, int))SDL_GL_GetProcAddress("glFramebufferTexture2D");
    host->readPixels = (void (*)(int, int, int, int, unsigned, unsigned, void *))SDL_GL_GetProcAddress("glReadPixels");
    if (!host->genFramebuffers || !host->readPixels) {
      snprintf(error, error_size, "this GL has no framebuffer objects");
      return NULL;
    }
    /* Rendering into an image the host owns and reading that back, rather than reading the window's
       back buffer, which depends on a compositor nobody controls. */
    host->color = re_seam_texture_2d_for(host->seam, NULL, width, height, RE_SEAM_FILTER_NEAREST,
                                         RE_SEAM_WRAP_CLAMP_TO_EDGE, RE_SEAM_TEXTURE_COLOR);
    host->depth = re_seam_texture_2d_for(host->seam, NULL, width, height, RE_SEAM_FILTER_NEAREST,
                                         RE_SEAM_WRAP_CLAMP_TO_EDGE, RE_SEAM_TEXTURE_DEPTH);
    host->genFramebuffers(1, &host->fbo);
    host->bindFramebuffer(GL_FRAMEBUFFER, host->fbo);
    host->framebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, host->color.id, 0);
    host->framebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, host->depth.id, 0);
    host->target = re_seam_target_adopt(host->seam, host->fbo, width, height);
  } else {
    host->target = re_seam_target_adopt(host->seam, 0, width, height);   /* the back buffer */
  }
  return host;
}

void host_close(Host *host) {
  if (host == NULL) return;
  if (host->seam != NULL) {
    re_seam_texture_destroy(host->seam, &host->color);
    re_seam_texture_destroy(host->seam, &host->depth);
    re_seam_close(host->seam);
  }
  if (host->context) SDL_GL_DeleteContext(host->context);
  if (host->window) SDL_DestroyWindow(host->window);
  SDL_Quit();
  free(host);
}

ReSeam *host_seam(Host *host) { return host->seam; }
ReSeamTarget host_target(Host *host) { return host->target; }

bool host_poll(Host *host) {
  if (host->offscreen) return false;
  SDL_Event event;
  while (SDL_PollEvent(&event))
    if (event.type == SDL_QUIT || (event.type == SDL_KEYDOWN && event.key.keysym.sym == SDLK_ESCAPE))
      host->running = false;
  return host->running;
}

void host_present(Host *host) {
  if (!host->offscreen) SDL_GL_SwapWindow(host->window);
}

bool host_read(Host *host, unsigned char *rgba, char *error, size_t error_size) {
  if (!host->offscreen) { snprintf(error, error_size, "read-back needs an off-screen host"); return false; }
  host->bindFramebuffer(GL_FRAMEBUFFER, host->fbo);
  host->readPixels(0, 0, host->width, host->height, GL_RGBA, GL_UNSIGNED_BYTE, rgba);
  return true;
}
