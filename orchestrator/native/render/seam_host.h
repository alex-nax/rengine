/* What the desktop's HOST does for a seam-backed renderer, which is everything the seam does not.
 *
 * The seam draws. It does not make a window, choose a device, own a swapchain, present a frame or
 * read one back — those belong to whoever owns the platform. `backend_seam.c` is therefore the same
 * source whichever graphics API is underneath, and this is the one file per API (spec 124, F133).
 *
 * It is the same split the pack's scene example already proved, and the reason "no call-site
 * difference between backends" is a claim about the draw list rather than about everything: opening
 * a GL context and opening a Vulkan device are not the same act and the seam never pretended so.
 */
#ifndef RENGINE_SEAM_HOST_H
#define RENGINE_SEAM_HOST_H

#include "rengine/gpu_seam.h"
#include <SDL.h>
#include <stdbool.h>

typedef struct ReSeamHost ReSeamHost;

/* The window flags this API needs, set before the window is made — the same shape
 * re_backend_gl_window_flags already has, because SDL wants some attributes set first. */
Uint32 re_seam_host_flags(void);
/* Opens the device or context on `window`, then the seam on it. */
ReSeamHost *re_seam_host_open(SDL_Window *window, char *error, size_t error_size);
void re_seam_host_close(ReSeamHost *host);

ReSeam *re_seam_host_seam(ReSeamHost *host);
/* The drawable size in physical pixels, which is not the window size on a scaled display. */
void re_seam_host_size(ReSeamHost *host, int *width, int *height);
/* The target this frame draws into: a swapchain image, a drawable's texture, or the back buffer.
 * Answered per frame because that is what a swapchain means. A zero target means the host could not
 * acquire one — a resize in flight, usually — and the frame should be skipped rather than drawn. */
ReSeamTarget re_seam_host_acquire(ReSeamHost *host);
void re_seam_host_present(ReSeamHost *host);
/* Writes the frame just presented to a BMP. The host's, because a read-back is a synchronisation
 * point and the seam's frame path is thin on purpose. */
bool re_seam_host_snapshot(ReSeamHost *host, const char *path);
/* The name this backend reports, which is the API's, not the seam's. */
const char *re_seam_host_name(void);

#endif
