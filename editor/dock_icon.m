#include "dock_icon.h"
#import <AppKit/AppKit.h>
#include <string.h>

/* Compiled without ARC, like the Metal seam beside it, so the two retain/release rules in this
 * build are one rule. NSApplication retains the image it is given; this file owns nothing after. */

bool re_dock_icon_set(const unsigned char *rgba, int width, int height) {
  if (!rgba || width <= 0 || height <= 0) return false;
  /* NSApplication exists once SDL has opened its window, and the tile belongs to the process
   * rather than the window. A build with no application object has nothing to set. */
  NSApplication *app = [NSApplication sharedApplication];
  if (!app) return false;
  /* NSBitmapFormatAlphaNonpremultiplied, because re_svg_rasterize hands back STRAIGHT alpha.
   * Declaring premultiplied here would darken every edge pixel of the mark against its own
   * transparency, which reads as a dirty halo rather than as a wrong flag. */
  NSBitmapImageRep *rep = [[NSBitmapImageRep alloc]
      initWithBitmapDataPlanes:NULL
                    pixelsWide:width
                    pixelsHigh:height
                 bitsPerSample:8
               samplesPerPixel:4
                      hasAlpha:YES
                      isPlanar:NO
                colorSpaceName:NSDeviceRGBColorSpace
                  bitmapFormat:NSBitmapFormatAlphaNonpremultiplied
                   bytesPerRow:(NSInteger)width * 4
                  bitsPerPixel:32];
  if (!rep) return false;
  memcpy([rep bitmapData], rgba, (size_t)width * (size_t)height * 4u);
  /* Sized in POINTS from the pixel bitmap: the tile is drawn at a point size and macOS picks the
   * representation, so handing it 512x512 points would ask the Dock for a tile the size of a
   * window. The representation keeps its pixel dimensions, which is what the read-back reports. */
  NSImage *image = [[NSImage alloc] initWithSize:NSMakeSize(width / 2.0, height / 2.0)];
  if (!image) { [rep release]; return false; }
  [image addRepresentation:rep];
  [app setApplicationIconImage:image];
  [rep release];
  [image release];
  return true;
}

void re_dock_icon_size(int *width, int *height) {
  if (width) *width = 0;
  if (height) *height = 0;
  NSApplication *app = [NSApplication sharedApplication];
  NSImage *image = app ? [app applicationIconImage] : nil;
  if (!image) return;
  /* The REPRESENTATION's pixels, not the image's points: the point size is what the caller asked
   * to draw at, and two different bitmaps can share it. The pixels are what was actually handed
   * over, so a check can tell the declared mark from whatever the process defaulted to. */
  NSImageRep *rep = [[image representations] firstObject];
  if (!rep) return;
  if (width) *width = (int)[rep pixelsWide];
  if (height) *height = (int)[rep pixelsHigh];
}
