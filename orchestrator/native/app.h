#ifndef RENGINE_APP_H
#define RENGINE_APP_H
#include "layout.h"
#include "terminal.h"
#include "editor.h"
#include "game.h"
#include "formatview.h"
enum { RE_TREE = 1, RE_EDITOR, RE_TERMINAL, RE_SESSIONS, RE_GAME, RE_DASHBOARD };
typedef struct {
  bool used, dirty, conflict, discarding; int type, generation, saved, checkpoint, checkpoint_flight;
  char root[65], session[65], path[2048], title[256], version[65], error[512];
  cJSON *data; ReTerminal *terminal; ReEditor *editor; ReGame *game; ReFormatView *format;
  mu_Rect rect, header; Uint64 edited;
} ReTab;
typedef struct { int id, operation, tab, generation, revision; char root[65]; long timeout; } RePending;
typedef struct { int first, count, selected, width, tab; } ReTabStrip;
typedef struct ReApp {
  ReNet *net; ReSocket *events; ReLayout layout;
  ReTab tabs[RE_TABS]; RePending pending[128];
  ReTabStrip strips[RE_PANES];
  cJSON *state, *previous_layout, *controls, *formats, *dashboards, *dashboards_opened;
  char root[65], initial_terminal[65], initial_agent[65], initial_game[65];
  char project_input[1024], agent[256], status[512];
  bool initialized, connected, vim, layout_dirty, quitting;
  int width, height, preset;                 /* last laid-out size and the active theme preset */
  bool explorer_nested;                      /* the explorer's mode (spec 080) */
  int overlay;                               /* RE_OVERLAY_*: one overlay at a time (spec 080 decision 5) */
  char scheme[32];                           /* syntax colour scheme */
  float accent_hue;                          /* live accent hue in degrees; 0 means the preset's own */
  char theme_path[1024];                     /* the popover's theme-file path field (spec 080) */
  char project_theme[64], project_theme_path[1200];  /* the theme this root offers, if it carries one */
  char project_theme_root[65];               /* the root that offer was probed for */
  mu_Rect overlay_anchor, overlay_rect;      /* the control the surface hangs from, and where it landed */
  mu_Id overlay_opener;                      /* focus returns here when the surface closes */
  bool overlay_restore;
  bool desktop_registered, reload_requested; char desktop_id[65];
  int focus, drag_tab, resize_pane, drag_x, drag_y, mouse_x, mouse_y;
  Uint64 layout_changed, quit_started;
  int scene;
} ReApp;
/* The overlay layer. Opening one closes the other, so the kind is a single value (spec 080). */
enum { RE_OVERLAY_NONE = 0, RE_OVERLAY_SETTINGS, RE_OVERLAY_ROOTS, RE_OVERLAY_PANE };

ReApp *re_app_open(const char *url, const char *token);
void re_app_close(ReApp *app);
void re_app_tick(ReApp *app);
void re_app_ui(ReApp *app, mu_Context *ui, int width, int height);
void re_app_draw(ReApp *app, ReDraw *draw);
void re_app_status(ReApp *app, ReDraw *draw);   /* the segmented status bar, drawn above every pane */
bool re_app_event(ReApp *app, const SDL_Event *event, ReDraw *draw);
/* Applies this root's theme file when a person has already activated it for that root (D34). */
void re_app_project_theme(ReApp *app);
bool re_app_quit(ReApp *app);
cJSON *re_app_inspect(ReApp *app);
int re_app_tab(ReApp *app, int type, const char *root, const char *path, const char *session, const char *title);
void re_app_load(ReApp *app, int tab);
void re_app_load_entry(ReApp *app, int tab);
void re_app_mode(ReApp *app, int tab, int mode);
const cJSON *re_app_format_record(ReApp *app, ReTab *tab);
bool re_app_external_session(ReApp *app, const char *session);
void re_app_control(ReApp *app, mu_Context *ui, const char *role, const char *key, int tab);
int re_app_dashboard(ReApp *app, const char *root);
void re_app_dashboard_run(ReApp *app, int tab, const char *action, bool capture);
void re_app_reveal(ReApp *app, const char *root, const char *artifact);
void re_dashboard_ui(ReApp *app, mu_Context *ui, int tab);
void re_app_save(ReApp *app, int tab);
void re_app_discard(ReApp *app, int tab);
void re_app_action(ReApp *app, const char *route, const cJSON *body);
void re_app_layout_changed(ReApp *app);
#endif
