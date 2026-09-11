/* The OpenGL host for the seam-backed draw list (spec 124, F133).
 *
 * Everything here is SDL and the GL context: the seam takes its entry points from
 * SDL_GL_GetProcAddress and never links a GL library of its own.
 */
#include "render/seam_host.h"

#include <SDL.h>

#include <stdlib.h>
#include <string.h>

struct ReSeamHost {
  SDL_Window *window;
  SDL_GLContext context;
  ReSeam *seam;
  bool current;
  int width, height;
};

static void *load_proc(void *user, const char *name) { (void)user; return SDL_GL_GetProcAddress(name); }
static void on_message(void *user, const char *message) { (void)user; SDL_SetError("%s", message); }

uint32_t re_seam_host_flags(void) {
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3); SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS, SDL_GL_CONTEXT_FORWARD_COMPATIBLE_FLAG);
  SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1); SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 0);
  SDL_GL_SetAttribute(SDL_GL_STENCIL_SIZE, 0);
  return SDL_WINDOW_OPENGL;
}

void re_seam_host_fail(const char *message) { SDL_SetError("%s", message); }
const char *re_seam_host_name(void) { return "opengl"; }

ReSeamHost *re_seam_host_open(void *opaque, char *error, size_t error_size) {
  SDL_Window *window = (SDL_Window *)opaque;
  ReSeamHost *host = calloc(1, sizeof(*host));
  if (!host) { snprintf(error, error_size, "out of memory"); return NULL; }
  host->window = window;
  host->context = SDL_GL_CreateContext(window);
  if (!host->context) {
    snprintf(error, error_size, "no GL context (%s)", SDL_GetError());
    free(host);
    return NULL;
  }
  SDL_GL_SetSwapInterval(1);
  ReSeamOpen options = {0};
  options.get_proc = load_proc;
  options.on_message = on_message;
  host->seam = re_seam_open(&options, error, error_size);
  if (!host->seam) { SDL_GL_DeleteContext(host->context); free(host); return NULL; }
  return host;
}

void re_seam_host_close(ReSeamHost *host) {
  if (!host) return;
  if (host->context) SDL_GL_MakeCurrent(host->window, host->context);
  re_seam_close(host->seam);
  if (host->context) SDL_GL_DeleteContext(host->context);
  free(host);
}

ReSeam *re_seam_host_seam(ReSeamHost *host) { return host->seam; }

void re_seam_host_size(ReSeamHost *host, int *width, int *height) {
  SDL_GL_GetDrawableSize(host->window, &host->width, &host->height);
  *width = host->width;
  *height = host->height;
}

ReSeamTarget re_seam_host_acquire(ReSeamHost *host) {
  if (!host->current) {
    if (SDL_GL_MakeCurrent(host->window, host->context) != 0) { ReSeamTarget none = {0, 0, 0}; return none; }
    host->current = true;
  }
  SDL_GL_GetDrawableSize(host->window, &host->width, &host->height);
  /* Framebuffer zero IS the back buffer on OpenGL, so the window's own surface is adopted rather
     than created. On Vulkan and Metal this is where a swapchain image would be acquired instead. */
  return re_seam_target_adopt(host->seam, 0, host->width, host->height, 0);
}

void re_seam_host_present(ReSeamHost *host) { SDL_GL_SwapWindow(host->window); }

bool re_seam_host_snapshot(ReSeamHost *host, const char *path) {
  void (*readPixels)(int, int, int, int, unsigned, unsigned, void *) =
    (void (*)(int, int, int, int, unsigned, unsigned, void *))SDL_GL_GetProcAddress("glReadPixels");
  void (*pixelStore)(unsigned, int) = (void (*)(unsigned, int))SDL_GL_GetProcAddress("glPixelStorei");
  if (!readPixels) return false;
  int w = host->width, h = host->height;
  unsigned char *pixels = malloc((size_t)w * (size_t)h * 4);
  if (!pixels) return false;
  if (pixelStore) pixelStore(0x0D05 /* GL_PACK_ALIGNMENT */, 1);
  readPixels(0, 0, w, h, 0x1908 /* GL_RGBA */, 0x1401 /* GL_UNSIGNED_BYTE */, pixels);
  SDL_Surface *surface = SDL_CreateRGBSurfaceWithFormat(0, w, h, 32, SDL_PIXELFORMAT_RGBA32);
  bool ok = false;
  if (surface) {
    /* glReadPixels hands back bottom-up and SDL wants top-down, which is the one orientation
       difference the OpenGL host absorbs — the seam's own targets already agree across backends. */
    for (int y = 0; y < h; y++)
      memcpy((unsigned char *)surface->pixels + (size_t)y * (size_t)surface->pitch,
             pixels + (size_t)(h - 1 - y) * (size_t)w * 4, (size_t)w * 4);
    ok = SDL_SaveBMP(surface, path) == 0;
    SDL_FreeSurface(surface);
  }
  free(pixels);
  return ok;
}
