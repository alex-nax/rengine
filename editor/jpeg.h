#ifndef RENGINE_JPEG_H
#define RENGINE_JPEG_H
#include <stddef.h>
#include <stdbool.h>

/* In-memory JPEG encoding for game-recording keyframes (spec 081), over the pinned
 * third_party/stb/stb_image_write.h. The ring holds encoded bytes, so the file-writing entry points
 * of that header are compiled out; this is the only call rEngine makes into it.
 * `rgb` is `width * height * 3` bytes, top-down. On success `*out` is malloc'd and owned by the
 * caller. */
bool re_jpeg_encode(const unsigned char *rgb, int width, int height, int quality, unsigned char **out, size_t *size);
#endif
