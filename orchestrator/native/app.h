#ifndef RENGINE_APP_H
#define RENGINE_APP_H
#include "layout.h"
#include "terminal.h"
#include "editor.h"
#include "game.h"
#include "formatview.h"
#include "recording.h"
#include "token.h"
enum { RE_TREE = 1, RE_EDITOR, RE_TERMINAL, RE_SESSIONS, RE_GAME, RE_DASHBOARD, RE_DEVICES, RE_TRACKER };
#define RE_DEVICES_TIMEOUT_MS 45000L /* a devices load runs every declared probe; see sidecar: devices-route */
typedef struct {
  bool used, dirty, conflict, discarding; int type, generation, saved, checkpoint, checkpoint_flight;
  bool session_ended;                        /* its session is gone from the workspace state: it ended with a previous host (spec 098) */
  char root[65], session[65], path[2048], title[256], version[65], error[512];
  char selected[1024];                       /* the last row opened here; its branch is never collapsed */
  int diagnostic_version;    /* the language servers' publish counter this tab has already drawn */
  cJSON *data; ReTerminal *terminal; ReEditor *editor; ReGame *game; ReFormatView *format; ReRecorder *recorder;
  mu_Rect rect, header; Uint64 edited;
} ReTab;
typedef struct { int id, operation, tab, generation, revision, slot; char root[65]; long timeout; } RePending;
/* Nested explorer rows (spec 080 decisions 7-10). One entry per directory expanded in place; the
 * pool is shared across tabs so a person with one deep tree is not limited by a per-tab quota. */
#define RE_TREE_EXPANSIONS 48
typedef struct {
  int tab, generation;       /* the tab that opened it; -1 when the slot is free */
  char path[1024];           /* directory path within that tab's root */
  cJSON *data;               /* its listing, NULL while the request is in flight */
  Uint64 opened;             /* when it was expanded, for the least-recently-expanded rule */
} ReExpansion;
typedef struct { int first, count, selected, width, tab; } ReTabStrip;
typedef struct ReApp {
  ReNet *net; ReSocket *events; ReLayout layout;
  ReTab tabs[RE_TABS]; RePending pending[128]; ReExpansion expansions[RE_TREE_EXPANSIONS];
  ReTabStrip strips[RE_PANES];
  cJSON *state, *previous_layout, *controls, *formats, *dashboards, *dashboards_opened;
  cJSON *conversations;                      /* the Sessions tab's conversation rows as drawn, for automation (spec 103) */
  char root[65], initial_terminal[65], initial_agent[65], initial_game[65];
  char primary_root[65];                     /* the root the window opened on; identity comes from it (spec 084) */
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
  char dropdown[32];                         /* the open select's key, empty when none */
  mu_Rect dropdown_anchor, dropdown_rect;    /* the select it hangs from, and where it landed */
  bool overlay_restore;
  bool desktop_registered, reload_requested; char desktop_id[65];
  ReProjectToken token;                             /* the project token of the primary root (spec 095) */
  int focus, drag_tab, resize_pane, drag_x, drag_y, mouse_x, mouse_y;
  Uint64 layout_changed, quit_started;
  /* What the focused editor last told the workspace, so a caret that has not moved is not
   * reported again and a held arrow key does not send a frame's worth of notifications. */
  char selection[192]; Uint64 selection_sent;
  char buffered[320];        /* file and revision of the last buffer sent to the language servers */
  Uint64 diagnostics_asked;  /* when the focused editor last asked what the servers had said */
  int scene;
} ReApp;
/* The overlay layer. Opening one closes the other, so the kind is a single value (spec 080). */
enum { RE_OVERLAY_NONE = 0, RE_OVERLAY_SETTINGS, RE_OVERLAY_ROOTS, RE_OVERLAY_PANE, RE_OVERLAY_TOKEN };

ReApp *re_app_open(const char *url, const char *token);
void re_app_close(ReApp *app);
void re_app_tick(ReApp *app);
void re_app_ui(ReApp *app, mu_Context *ui, int width, int height);
void re_app_draw(ReApp *app, ReDraw *draw);
void re_app_status(ReApp *app, ReDraw *draw);   /* the segmented status bar, drawn above every pane */
bool re_app_event(ReApp *app, const SDL_Event *event, ReDraw *draw);
/* Applies this root's theme file when a person has already activated it for that root (D34). */
void re_app_project_theme(ReApp *app);

/* The workspace wears the primary root's declared name and mark, falling back to rEdit and the
 * accent. Identity never follows the focused tab, so moving between panes cannot rename the
 * chrome under you (spec 084 decision 3). */
#define RE_DEFAULT_TITLE "rEdit"
const char *re_app_title(ReApp *app);          /* display title; never an identifier */
const char *re_app_mark(ReApp *app);           /* one or two characters for the brand chip */
mu_Color re_app_mark_color(ReApp *app);        /* the chip's fill, resolved from the declared token */

/* The explorer's nested mode. `re_app_expanded` returns the expansion index for a directory or -1;
 * expanding requests the listing, collapsing drops it and every expansion beneath it. */
int re_app_expanded(ReApp *app, int tab, const char *path);
void re_app_expand(ReApp *app, int tab, const char *path);
void re_app_collapse(ReApp *app, int tab, const char *path);
void re_app_expansions_clear(ReApp *app, int tab);
int re_app_tree_rows(ReApp *app, int tab);   /* rows loaded for this tab, root listing included */
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
int  re_app_devices(ReApp *app, const char *root);
void re_app_devices_refresh(ReApp *app, int tab);
int re_app_tracker(ReApp *app, const char *root);       /* the project's task list (spec 083) */
void re_app_tracker_refresh(ReApp *app, int tab);
void re_app_tracker_signin(ReApp *app, int tab);        /* opens the provider's sign-in page */
void re_app_open_url(ReApp *app, const char *url);      /* hands a task's link to the browser */
void re_devices_ui(ReApp *app, mu_Context *ui, int tab);
void re_app_save(ReApp *app, int tab);
void re_app_discard(ReApp *app, int tab);
void re_app_action(ReApp *app, const char *route, const cJSON *body);
void re_app_layout_changed(ReApp *app);
#endif
