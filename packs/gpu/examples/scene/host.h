/* What the example's HOST does, which is everything the seam deliberately does not (spec 124).
 *
 * The seam draws. It does not open a window, choose a device, make a swapchain, or read a frame
 * back — those belong to whoever owns the platform, which is this program. Splitting them behind one
 * interface is what makes "no call-site difference between backends" a claim about `scene.c` rather
 * than a claim about everything: scene.c is identical across backends, and THIS is where they
 * genuinely differ, because opening a GL context and opening a Vulkan device are not the same act
 * and the seam never pretended otherwise.
 *
 * Each backend has its own implementation, selected by the same build option that selects the seam's.
 */
#ifndef RE_SCENE_HOST_H
#define RE_SCENE_HOST_H

#include "rengine/gpu_seam.h"

#include <stdbool.h>
#include <stddef.h>

typedef struct Host Host;

/* Opens a window and whatever the backend needs behind it, then the seam. `offscreen` asks for a
 * hidden window and a target that can be read back — snapshot mode — rather than one that presents. */
Host *host_open(int width, int height, bool offscreen, char *error, size_t error_size);
void host_close(Host *host);

ReSeam *host_seam(Host *host);
/* The target a frame renders into: the window's back buffer, or the off-screen image. */
ReSeamTarget host_target(Host *host);
/* True while the window is open. Always false in off-screen mode, which draws a fixed count. */
bool host_poll(Host *host);
void host_present(Host *host);
/* Reads the target back as bottom-up RGBA. Off-screen mode only. */
bool host_read(Host *host, unsigned char *rgba, char *error, size_t error_size);

#endif
