/* Spec 104 — the brand rasteriser. Runs against the REAL Kohai assets rather than a synthetic
 * square: the mark's path is rectilinear (M/H/V/Z) and the wordmark's is cubic, and a rasteriser
 * that handled only the first would still have passed a hand-made fixture. */
#include "svg.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static char dir[512];

static const char *fixture(const char *name) {
  static char path[640];
  snprintf(path, sizeof(path), "%s/%s", dir, name);
  return path;
}

/* Every pixel with any coverage, and the strongest one. Coverage separates "drew the artwork" from
 * "allocated a transparent buffer", which is the way a broken rasteriser passes a size assertion. */
static void survey(const ReSvgImage *img, int *ink, unsigned char *best_r, unsigned char *best_g,
                   unsigned char *best_b) {
  int most = -1;
  *ink = 0;
  for (int i = 0; i < img->width * img->height; i++) {
    const unsigned char *p = &img->rgba[(size_t)i * 4];
    if (p[3] == 0) continue;
    (*ink)++;
    if (p[3] > most) { most = p[3]; *best_r = p[0]; *best_g = p[1]; *best_b = p[2]; }
  }
}

static void near_colour(unsigned char got, unsigned char want, const char *what) {
  int delta = (int)got - (int)want;
  if (delta < 0) delta = -delta;
  if (delta > 8) { fprintf(stderr, "%s: got %u want %u\n", what, got, want); assert(0); }
}

int main(int argc, char **argv) {
  assert(argc > 1 && "fixture directory is the first argument");
  snprintf(dir, sizeof(dir), "%s", argv[1]);
  ReSvgImage img;

  /* The mark fits a square chip. 17.335 x 17.5537 is very slightly taller than wide, so a uniform
   * fit is bound by HEIGHT: the height fills the box and the width comes in just under it. A
   * rasteriser that stretched to the box would give 32x32 and pass a laxer assertion. */
  assert(re_svg_rasterize(fixture("mark.svg"), 32, 32, &img));
  assert(img.height == 32);
  assert(img.width == 32 || img.width == 31);
  int ink = 0;
  unsigned char r = 0, g = 0, b = 0;
  survey(&img, &ink, &r, &g, &b);
  assert(ink > 0 && "the mark rasterised to a transparent buffer");
  /* #CC4F4C — the fill the document declares. This is what proves the PATH was filled and not, say,
   * a bounding box cleared to something. */
  near_colour(r, 0xCC, "mark red");
  near_colour(g, 0x4F, "mark green");
  near_colour(b, 0x4C, "mark blue");
  re_svg_free(&img);
  assert(img.rgba == NULL && img.width == 0);

  /* The wordmark is wide (67.5668 x 18.8587), so the same call is bound by WIDTH. Its glyphs are
   * cubic béziers; the mark above has none. */
  assert(re_svg_rasterize(fixture("wordmark.svg"), 200, 200, &img));
  assert(img.width == 200);
  assert(img.height > 50 && img.height < 60);
  survey(&img, &ink, &r, &g, &b);
  assert(ink > 0 && "the wordmark rasterised to a transparent buffer");
  re_svg_free(&img);

  /* Scaling is uniform, not per-axis: a box far wider than the artwork must not stretch it. */
  assert(re_svg_rasterize(fixture("mark.svg"), 400, 40, &img));
  assert(img.height == 40 && img.width < 60 && "a wide box must not stretch the mark");
  re_svg_free(&img);

  /* Refusals. Each returns false and leaves `out` alone, so the caller falls back to its glyph
   * (spec 104 decision 7) instead of drawing a half-initialised image. */
  ReSvgImage untouched = {0};
  assert(!re_svg_rasterize(fixture("missing.svg"), 32, 32, &untouched));
  assert(!re_svg_rasterize(fixture("malformed.svg"), 32, 32, &untouched));
  assert(!re_svg_rasterize(fixture("empty.svg"), 32, 32, &untouched));
  assert(untouched.rgba == NULL && untouched.width == 0 && untouched.height == 0);

  /* Bounds on the request itself, so a declaration cannot ask for an allocation the chrome would
   * not survive. */
  assert(!re_svg_rasterize(fixture("mark.svg"), 0, 32, &untouched));
  assert(!re_svg_rasterize(fixture("mark.svg"), 32, -1, &untouched));
  assert(!re_svg_rasterize(fixture("mark.svg"), RE_SVG_MAX_EDGE + 1, 32, &untouched));
  assert(!re_svg_rasterize(NULL, 32, 32, &untouched));
  assert(!re_svg_rasterize(fixture("mark.svg"), 32, 32, NULL));

  printf("svg ok\n");
  return 0;
}
