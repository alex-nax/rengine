#ifndef RENGINE_SVG_H
#define RENGINE_SVG_H
#include <stdbool.h>

/* SVG rasterisation for project brand artwork (spec 104), over the pinned
 * third_party/nanosvg headers. The same wrapper shape as jpeg.c over stb: rEngine owns the
 * contract and the limits, the vendored code owns the parsing and the scan conversion.
 *
 * Only the brand slots use this. It is not a document renderer and not a format-registry
 * preview — see spec 104's "What this does not do". */

/* Straight-alpha RGBA, top-down, `width * 4` bytes per row — the layout re_draw_texture_update
 * expects, in the alpha space both backends blend with. Owned by the caller until re_svg_free. */
typedef struct {
  int width, height;
  unsigned char *rgba;
} ReSvgImage;

/* An upper bound on the rasterised size, so a declaration cannot ask for an allocation the
 * chrome would not survive. Well above any bar metric on any display rEngine supports. */
#define RE_SVG_MAX_EDGE 4096

/* Rasterise `path` scaled UNIFORMLY to fit inside `box_w` x `box_h` device pixels. The result is
 * the fitted size, not the box: artwork is never padded or stretched here, so the caller centres
 * what it gets and a wordmark keeps its own aspect ratio.
 *
 * False on a missing file, a document that parses to nothing, a zero or absurd viewBox, or a
 * requested box outside the bounds above. The caller draws its glyph instead (spec 104 decision 7);
 * `out` is untouched on failure. */
bool re_svg_rasterize(const char *path, int box_w, int box_h, ReSvgImage *out);

void re_svg_free(ReSvgImage *image);
#endif
