/* The Metal host: a device, an off-screen texture, and a read-back (spec 124).
 *
 * Shorter than the other two because Metal's device needs no instance, no extensions and no
 * predicate — `MTLCreateSystemDefaultDevice` is the whole of it — and because the seam already owns
 * the images. What is left is exactly the host's share: choosing the device, and getting a frame
 * back out.
 *
 * Presenting is not here, for the same reason it is not in the Vulkan host: a window needs a
 * CAMetalLayer and a drawable, which belong to whoever owns the window. rEngine's own
 * backend_metal.m already has that, and F133 brings it along when the desktop moves onto the seam.
 */
#import <Metal/Metal.h>

#include "host.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct Host {
  id<MTLDevice> device;
  ReSeam *seam;
  ReSeamTarget target;
  ReSeamTexture color, depth;
  int width, height;
};

static void on_message(void *user, const char *message) { (void)user; fprintf(stderr, "%s\n", message); }

Host *host_open(int width, int height, bool offscreen, char *error, size_t error_size) {
  if (!offscreen) {
    snprintf(error, error_size,
             "the Metal host renders off-screen only: presenting needs a CAMetalLayer and a drawable, "
             "which belong to the window's owner rather than to the seam. Use --snapshot, or the "
             "OpenGL build for a window.");
    return NULL;
  }
  Host *host = calloc(1, sizeof(*host));
  if (host == NULL) { snprintf(error, error_size, "out of memory"); return NULL; }
  host->width = width;
  host->height = height;
  host->device = MTLCreateSystemDefaultDevice();
  if (host->device == nil) {
    snprintf(error, error_size, "no Metal device on this machine");
    free(host);
    return NULL;
  }
  ReSeamOpen options = {0};
  options.user = (void *)host->device;
  options.on_message = on_message;
  host->seam = re_seam_open(&options, error, error_size);
  if (host->seam == NULL) return NULL;

  host->color = re_seam_texture_2d_for(host->seam, NULL, width, height, RE_SEAM_FILTER_NEAREST,
                                       RE_SEAM_WRAP_CLAMP_TO_EDGE, RE_SEAM_TEXTURE_COLOR);
  host->depth = re_seam_texture_2d_for(host->seam, NULL, width, height, RE_SEAM_FILTER_NEAREST,
                                       RE_SEAM_WRAP_CLAMP_TO_EDGE, RE_SEAM_TEXTURE_DEPTH);
  host->target = re_seam_target(host->seam, host->color, host->depth);
  if (host->target.id == 0) {
    snprintf(error, error_size, "the off-screen target was not made; the seam reported why");
    return NULL;
  }
  return host;
}

void host_close(Host *host) {
  if (host == NULL) return;
  if (host->seam != NULL) {
    re_seam_target_destroy(host->seam, &host->target);
    re_seam_texture_destroy(host->seam, &host->color);
    re_seam_texture_destroy(host->seam, &host->depth);
    re_seam_close(host->seam);
  }
  [host->device release];
  free(host);
}

ReSeam *host_seam(Host *host) { return host->seam; }
ReSeamTarget host_target(Host *host) { return host->target; }
bool host_poll(Host *host) { (void)host; return false; }
void host_present(Host *host) { (void)host; }

bool host_read(Host *host, unsigned char *rgba, char *error, size_t error_size) {
  id<MTLTexture> texture = (id<MTLTexture>)re_seam_texture_handle(host->seam, host->color);
  if (texture == nil) {
    snprintf(error, error_size, "the colour target has no texture to read");
    return false;
  }
  /* The frame's own blit already synchronised this managed texture, so the bytes are here to take.
     Metal hands them back as BGRA on this pixel format, and the caller wants RGBA — the swap is the
     host's to do, exactly as the Vulkan host absorbs its own differences. */
  [texture getBytes:rgba bytesPerRow:(NSUInteger)host->width * 4
         fromRegion:MTLRegionMake2D(0, 0, (NSUInteger)host->width, (NSUInteger)host->height)
        mipmapLevel:0];
  return true;
}
