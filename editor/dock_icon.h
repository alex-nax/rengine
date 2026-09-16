#ifndef RENGINE_DOCK_ICON_H
#define RENGINE_DOCK_ICON_H
#include <stdbool.h>

/* The application's icon as the operating system shows it outside the window — macOS's Dock tile
 * (spec 136). A declared brand mark (spec 104) is drawn inside the chrome by the mark chip; this is
 * the same artwork handed to the platform, so the project a window belongs to is legible from the
 * Dock as well as from the toolbar.
 *
 * SDL_SetWindowIcon is deliberately not what this uses: on macOS it sets the window's icon and
 * leaves the Dock tile alone, which is the thing a person actually looks at. The Dock tile is
 * NSApplication's applicationIconImage and needs AppKit, so the implementation is one Objective-C
 * file compiled on Apple only; every other platform gets the stub beside it and reports nothing.
 */

/* The edge, in device pixels, the mark is rasterised to for the tile. The Dock draws at up to
 * 128pt and macOS asks for @2x, so 512 covers it with room for a larger tile without asking a
 * declaration for an allocation worth guarding against (RE_SVG_MAX_EDGE is the real bound). */
#define RE_DOCK_ICON_EDGE 512

/* Straight-alpha RGBA, top-down, `width * 4` bytes per row — re_svg_rasterize's layout exactly.
 * False when the platform has no tile to set, or the bitmap is unusable. */
bool re_dock_icon_set(const unsigned char *rgba, int width, int height);

/* What the OPERATING SYSTEM says the tile is now, in pixels, read back from it rather than
 * remembered from the call — the rule spec 084 decision 4 already applies to the window title, so
 * a check holds the chrome and the platform to one source instead of assuming they agree. Zero
 * when there is no tile, or off macOS. */
void re_dock_icon_size(int *width, int *height);
#endif
