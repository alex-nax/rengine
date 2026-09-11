/* The Metal host for the seam-backed draw list (spec 124, F133).
 *
 * Everything here is SDL, the CAMetalLayer and the drawable: the seam creates no swapchain, exactly
 * as the device layer creates no surface, so acquiring an image and presenting it is the host's
 * side of the boundary. Its OpenGL sibling adopts framebuffer zero for the same reason.
 *
 * Non-ARC, like the pack's own Metal file: this owns Metal objects in a plain C struct with explicit
 * retain/release, which is the discipline that file already follows.
 */
#include "render/seam_host.h"

#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>

#include <stdlib.h>

struct ReSeamHost {
  SDL_Window *window;
  SDL_MetalView view;
  id<MTLDevice> device;
  CAMetalLayer *layer;
  id<CAMetalDrawable> drawable;
  ReSeam *seam;
  ReSeamTarget target;
  int width, height;
};

static void on_message(void *user, const char *message) { (void)user; SDL_SetError("%s", message); }

Uint32 re_seam_host_flags(void) { return SDL_WINDOW_METAL; }
const char *re_seam_host_name(void) { return "metal"; }

/* One frame's drawable and the target that wrapped it. Both are per-frame on this backend — unlike
   OpenGL, where the target is the constant zero — so every acquire gives the previous one back.
   Dropping a drawable without presenting it is legal and happens whenever a snapshot is taken: the
   snapshot flushes a frame of its own, and the caller then draws and presents another. */
static void release_frame(ReSeamHost *host) {
  if (host->target.id) re_seam_target_destroy(host->seam, &host->target);
  host->target = (ReSeamTarget){0, 0, 0};
  if (host->drawable) { [host->drawable release]; host->drawable = nil; }
}

ReSeamHost *re_seam_host_open(SDL_Window *window, char *error, size_t error_size) {
  ReSeamHost *host = calloc(1, sizeof(*host));
  if (!host) { snprintf(error, error_size, "out of memory"); return NULL; }
  host->window = window;
  host->device = MTLCreateSystemDefaultDevice();
  if (!host->device) { snprintf(error, error_size, "no Metal device"); free(host); return NULL; }
  host->view = SDL_Metal_CreateView(window);
  if (!host->view) { snprintf(error, error_size, "no Metal view (%s)", SDL_GetError()); [host->device release]; free(host); return NULL; }
  host->layer = (CAMetalLayer *)SDL_Metal_GetLayer(host->view);
  if (!host->layer) {
    snprintf(error, error_size, "SDL did not provide a CAMetalLayer");
    SDL_Metal_DestroyView(host->view); [host->device release]; free(host); return NULL;
  }
  host->layer.device = host->device;
  host->layer.pixelFormat = MTLPixelFormatBGRA8Unorm;
  /* The snapshot reads the drawable back on the CPU, which a framebuffer-only layer forbids. */
  host->layer.framebufferOnly = NO;
  host->layer.displaySyncEnabled = YES;
  /* The Metal seam takes the host's device rather than making one — the same shape as the OpenGL
     seam taking the host's proc loader, and for the same reason: the pack owns no context. */
  ReSeamOpen options = {0};
  options.user = (void *)host->device;
  options.on_message = on_message;
  host->seam = re_seam_open(&options, error, error_size);
  if (!host->seam) { SDL_Metal_DestroyView(host->view); [host->device release]; free(host); return NULL; }
  return host;
}

void re_seam_host_close(ReSeamHost *host) {
  if (!host) return;
  release_frame(host);
  re_seam_close(host->seam);
  if (host->view) SDL_Metal_DestroyView(host->view);
  [host->device release];
  free(host);
}

ReSeam *re_seam_host_seam(ReSeamHost *host) { return host->seam; }

void re_seam_host_size(ReSeamHost *host, int *width, int *height) {
  SDL_Metal_GetDrawableSize(host->window, &host->width, &host->height);
  *width = host->width;
  *height = host->height;
}

ReSeamTarget re_seam_host_acquire(ReSeamHost *host) {
  release_frame(host);
  SDL_Metal_GetDrawableSize(host->window, &host->width, &host->height);
  host->layer.drawableSize = CGSizeMake(host->width, host->height);
  host->drawable = [[host->layer nextDrawable] retain];
  if (!host->drawable) { ReSeamTarget none = {0, 0, 0}; return none; }
  /* The drawable's texture is what the header means by "an id<MTLTexture> on Metal". */
  host->target = re_seam_target_adopt(host->seam, (uintptr_t)host->drawable.texture,
                                      host->width, host->height, 0);
  return host->target;
}

/* re_seam_frame_end has already committed and waited, so the drawable is presented directly rather
   than through presentDrawable: on a command buffer that is no longer open. */
void re_seam_host_present(ReSeamHost *host) {
  if (host->drawable) [host->drawable present];
  release_frame(host);
}

bool re_seam_host_snapshot(ReSeamHost *host, const char *path) {
  if (!host->drawable) return false;
  int w = host->width, h = host->height;
  SDL_Surface *surface = SDL_CreateRGBSurfaceWithFormat(0, w, h, 32, SDL_PIXELFORMAT_BGRA32);
  if (!surface) return false;
  /* No flip: Metal's textures and SDL's surfaces both put row 0 at the top. The OpenGL host is the
     one that absorbs an orientation difference, because glReadPixels is specified bottom-up. */
  [host->drawable.texture getBytes:surface->pixels
                       bytesPerRow:(NSUInteger)surface->pitch
                        fromRegion:MTLRegionMake2D(0, 0, (NSUInteger)w, (NSUInteger)h)
                       mipmapLevel:0];
  bool ok = SDL_SaveBMP(surface, path) == 0;
  SDL_FreeSurface(surface);
  return ok;
}
