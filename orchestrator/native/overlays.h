#ifndef RENGINE_OVERLAYS_H
#define RENGINE_OVERLAYS_H
#include "app.h"

/* The workspace commands a menu row or a shortcut can run. The hints beside the rows name these
 * exact chords, and re_app_event serves them, so a menu never advertises a key that does nothing. */
enum { RE_COMMAND_SPLIT_VERTICAL = 0, RE_COMMAND_SPLIT_HORIZONTAL, RE_COMMAND_MERGE,
       RE_COMMAND_SHELL, RE_COMMAND_AGENT, RE_COMMAND_CLOSE_VIEW,
       /* The built-in procedural scene, which has no file to open it from (spec 126 decision 7).
          A command rather than a toolbar cell: the toolbar's pixels are judged against the recorded
          reference frames, and those came from a renderer that has retired and cannot re-record. */
       RE_COMMAND_SCENE };
#if defined(__APPLE__)
#define RE_PLATFORM_MODIFIER         KMOD_GUI
#define RE_SHORTCUT_SPLIT_VERTICAL   "Cmd \\"
#define RE_SHORTCUT_SPLIT_HORIZONTAL "Cmd Shift \\"
#define RE_SHORTCUT_MERGE            "Cmd Backspace"
#define RE_SHORTCUT_SHELL            "Cmd T"
#define RE_SHORTCUT_SCENE            "Cmd E"
#define RE_SHORTCUT_CLOSE            "Cmd W"
#define RE_SHORTCUT_RELEASE          "Cmd ."
#else
#define RE_PLATFORM_MODIFIER         KMOD_CTRL
#define RE_SHORTCUT_SPLIT_VERTICAL   "Ctrl \\"
#define RE_SHORTCUT_SPLIT_HORIZONTAL "Ctrl Shift \\"
#define RE_SHORTCUT_MERGE            "Ctrl Backspace"
#define RE_SHORTCUT_SHELL            "Ctrl T"
#define RE_SHORTCUT_SCENE            "Ctrl E"
#define RE_SHORTCUT_CLOSE            "Ctrl W"
#define RE_SHORTCUT_RELEASE          "Ctrl ."
#endif

/* The surfaces that open above the panes. The workspace decides which kind is open — `a->overlay`
 * holds one at a time — and calls the matching one of these to fill it. */
void re_overlay_settings(ReApp *app, mu_Context *ui);
void re_overlay_roots(ReApp *app, mu_Context *ui);    /* the project menu */
void re_overlay_pane(ReApp *app, mu_Context *ui);     /* the pane menu */
void re_overlay_dropdown(ReApp *app, mu_Context *ui); /* the open select, drawn above its own surface */
void re_overlay_token(ReApp *app, mu_Context *ui);

/* The other direction: what the overlays need back from the workspace. Kept to four so the seam
 * stays legible — a fifth is a sign the split is in the wrong place. */
const char *re_workspace_root_name(ReApp *app, const char *id);
const char *re_workspace_root_path(ReApp *app, const char *id);
void re_workspace_command(ReApp *app, int command); /* RE_COMMAND_*, as the pane menu runs them */
void re_workspace_overlay_close(ReApp *app);
#endif
