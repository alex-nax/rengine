#ifndef RENGINE_TRACKER_H
#define RENGINE_TRACKER_H
#include "app.h"
#include "ui/ui.h"
/* Contract-5 tracker tab: the project's task list from whichever backend it declares — its own
   git-checked-in inventory by default, or GitHub Issues or Linear (spec 083). Spec 103 decision 5
   makes the pane an orchestration surface on top of that list: each row can spawn a chosen agent
   and model on its task, decompose it, or hand the project token to a live agent. Reading the list
   is still all the tracker itself does; every control here acts on the agent system, not on the
   inventory, so a remote provider keeps its read-only rows and offers Spawn alone. */

/* Fixed capacities, so the menu owns nothing a close path would have to free. */
#define RE_TRACKER_AGENTS 8
#define RE_TRACKER_MODELS 12
#define RE_TRACKER_LIVE 16

void re_tracker_ui(ReApp *app, mu_Context *ui, int tab);
/* Whether this workspace serves the agent menu at all. A worker that owns no ledger serves no
   spawning either, and says so by advertising neither capability; the pane is told by name rather
   than spending a request on a route that is not there. */
bool re_tracker_menu_served(ReApp *app, int tab);
/* One `agents-menu` answer for that tab's root, or the reason there is none. The list never goes
   down with the menu: a worker that does not serve the route yet leaves the rows alone. */
void re_tracker_menu(ReApp *app, int tab, const cJSON *answer);
void re_tracker_menu_failed(ReApp *app, int tab, const char *error);
/* The answer to a spawn, and its refusal. Both belong to the pane: the worker's refusals name a
   whole prerequisite (a session host that predates task-driven panes, say), which a status line
   truncates and a note row does not. */
void re_tracker_spawned(ReApp *app, int tab, const cJSON *answer);
void re_tracker_spawn_failed(ReApp *app, int tab, const char *error);
/* `tracker`: the menu this window holds and the chooser a row has open. */
void re_tracker_inspect(const ReApp *app, cJSON *out);
#endif
