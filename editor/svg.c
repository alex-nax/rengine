#include "svg.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* nanosvg ships as headers whose implementation is compiled once, here. NANOSVG_ALL_COLOR_KEYWORDS
 * costs a static table and is what makes `fill="red"` behave the way an author expects. */
#define NANOSVG_ALL_COLOR_KEYWORDS
#define NANOSVG_IMPLEMENTATION
#include "nanosvg.h"
#define NANOSVGRAST_IMPLEMENTATION
#include "nanosvgrast.h"

/* The unit the document is parsed in. Every brand asset in scope declares a viewBox in user units,
 * and the DPI argument only matters for a document sized in physical units (`mm`, `pt`). 96 is the
 * CSS reference pixel, i.e. the same answer a browser gives — which is the comparison anyone
 * checking this artwork will actually make. */
#define RE_SVG_DPI 96.0f

/* nanosvg mutates the buffer it parses (it writes NULs into attribute values), so the file is read
 * into memory rather than handed to nsvgParseFromFile — which would do the same read and give us no
 * way to bound the size first. */
static char *read_all(const char *path, size_t limit) {
  FILE *file = fopen(path, "rb");
  if (!file) return NULL;
  if (fseek(file, 0, SEEK_END)) { fclose(file); return NULL; }
  long size = ftell(file);
  if (size < 0 || (size_t)size > limit || fseek(file, 0, SEEK_SET)) { fclose(file); return NULL; }
  char *text = malloc((size_t)size + 1);
  if (!text) { fclose(file); return NULL; }
  size_t read = fread(text, 1, (size_t)size, file);
  fclose(file);
  if (read != (size_t)size) { free(text); return NULL; }
  text[size] = '\0';
  return text;
}

/* 4 MiB. A brand asset is kilobytes; this only exists so a declaration pointing at the wrong file
 * fails fast instead of reading something enormous into the render thread. */
#define RE_SVG_MAX_BYTES (4u * 1024u * 1024u)

bool re_svg_rasterize(const char *path, int box_w, int box_h, ReSvgImage *out) {
  if (!path || !out || box_w <= 0 || box_h <= 0) return false;
  if (box_w > RE_SVG_MAX_EDGE || box_h > RE_SVG_MAX_EDGE) return false;

  char *text = read_all(path, RE_SVG_MAX_BYTES);
  if (!text) return false;
  NSVGimage *doc = nsvgParse(text, "px", RE_SVG_DPI);
  free(text);
  if (!doc) return false;
  /* A document that parses but describes nothing is a failure, not an empty image: it means the
   * declaration named a file that cannot be a brand mark, and the glyph is the better answer. */
  if (!(doc->width > 0.0f) || !(doc->height > 0.0f) || !doc->shapes) { nsvgDelete(doc); return false; }

  /* Uniform fit — the smaller of the two ratios, so nothing is cropped and nothing is stretched. */
  float scale = (float)box_w / doc->width;
  float by_height = (float)box_h / doc->height;
  if (by_height < scale) scale = by_height;
  int width = (int)lroundf(doc->width * scale);
  int height = (int)lroundf(doc->height * scale);
  /* Rounding can take a very wide or very short document to zero on one axis; one pixel is the
   * floor, and the clamp keeps the fit inside the box the caller asked for. */
  if (width < 1) width = 1;
  if (height < 1) height = 1;
  if (width > box_w) width = box_w;
  if (height > box_h) height = box_h;

  unsigned char *rgba = malloc((size_t)width * (size_t)height * 4u);
  NSVGrasterizer *rast = rgba ? nsvgCreateRasterizer() : NULL;
  if (!rast) { free(rgba); nsvgDelete(doc); return false; }
  nsvgRasterize(rast, doc, 0.0f, 0.0f, scale, rgba, width, height, width * 4);
  nsvgDeleteRasterizer(rast);
  nsvgDelete(doc);

  /* No alpha conversion. nanosvg writes straight (non-premultiplied) RGBA, and both backends blend
   * with a SourceAlpha source factor (the seam's re_seam_blend_separate, and before it backend_gl.c's glBlendFuncSeparate and backend_metal.m
   * sourceRGBBlendFactor) — straight alpha is what they expect. Premultiplying here would
   * double-apply alpha and darken every antialiased edge. */

  out->width = width;
  out->height = height;
  out->rgba = rgba;
  return true;
}

void re_svg_free(ReSvgImage *image) {
  if (!image) return;
  free(image->rgba);
  image->rgba = NULL;
  image->width = image->height = 0;
}
