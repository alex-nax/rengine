#ifndef RENGINE_TRACKER_H
#define RENGINE_TRACKER_H
#include "app.h"
#include "ui/ui.h"
/* Contract-5 tracker tab: the project's task list from whichever backend it declares — its own
   git-checked-in inventory by default, or GitHub Issues or Linear (spec 083). The view reads and
   never writes, so a row offers to open its issue and nothing else. */
void re_tracker_ui(ReApp *app, mu_Context *ui, int tab);
#endif
