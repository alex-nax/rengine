#include "dock_icon.h"

/* Every platform but macOS. The Dock tile is a macOS concept; Windows and Linux carry a window
 * icon instead, which is SDL_SetWindowIcon's job and a separate decision (spec 136, not decided
 * here). Reporting nothing is the honest answer for a platform with no tile — a stub that claimed
 * success would make the read-back agree with a call that did nothing. */
bool re_dock_icon_set(const unsigned char *rgba, int width, int height) {
  (void)rgba; (void)width; (void)height;
  return false;
}
void re_dock_icon_size(int *width, int *height) {
  if (width) *width = 0;
  if (height) *height = 0;
}
