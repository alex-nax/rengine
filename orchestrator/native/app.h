#ifndef RENGINE_APP_H
#define RENGINE_APP_H
#include "layout.h"
#include "terminal.h"
#include "editor.h"
#include "game.h"
enum { RE_TREE = 1, RE_EDITOR, RE_TERMINAL, RE_SESSIONS, RE_GAME };
typedef struct {
  bool used, dirty, conflict, discarding; int type, generation, saved, checkpoint, checkpoint_flight;
  char root[65], session[65], path[2048], title[256], version[65], error[512];
  cJSON *data; ReTerminal *terminal; ReEditor *editor; ReGame *game;
  mu_Rect rect, header; Uint64 edited;
} ReTab;
typedef struct { int id, operation, tab, generation, revision; } RePending;
typedef struct { int first, count, selected, width, tab; } ReTabStrip;
typedef struct {
  ReNet *net; ReSocket *events; ReLayout layout;
  ReTab tabs[RE_TABS]; RePending pending[128];
  ReTabStrip strips[RE_PANES];
  cJSON *state, *previous_layout, *controls;
  char root[65], initial_terminal[65], initial_agent[65], initial_game[65];
  char project_input[1024], agent[256], status[512];
  bool initialized, connected, vim, layout_dirty, quitting;
  bool desktop_registered, reload_requested; char desktop_id[65];
  int focus, drag_tab, resize_pane, drag_x, drag_y, mouse_x, mouse_y;
  Uint64 layout_changed, quit_started;
} ReApp;
ReApp *re_app_open(const char *url, const char *token);
void re_app_close(ReApp *app);
void re_app_tick(ReApp *app);
void re_app_ui(ReApp *app, mu_Context *ui, int width, int height);
void re_app_draw(ReApp *app, ReDraw *draw);
bool re_app_event(ReApp *app, const SDL_Event *event, ReDraw *draw);
bool re_app_quit(ReApp *app);
cJSON *re_app_inspect(ReApp *app);
int re_app_tab(ReApp *app, int type, const char *root, const char *path, const char *session, const char *title);
void re_app_load(ReApp *app, int tab);
void re_app_save(ReApp *app, int tab);
void re_app_discard(ReApp *app, int tab);
void re_app_action(ReApp *app, const char *route, const cJSON *body);
void re_app_layout_changed(ReApp *app);
#endif
