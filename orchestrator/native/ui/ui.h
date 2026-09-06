/* rEngine UI: owned immediate-mode controls over pristine microui (charter D33, spec 076).
 *
 * Conventions follow microui exactly, because this layer is meant to read as an extension of it:
 *   - every control takes `mu_Context *ctx` first and an `opt` flag word last;
 *   - identity, layout, hover and focus come from microui (`mu_get_id`, `mu_layout_next`,
 *     `mu_update_control`), so these controls interleave with microui's own;
 *   - results are microui's `MU_RES_*` bits;
 *   - nothing allocates, nothing is stored per frame outside one fixed table, and this header is
 *     the documentation.
 * Drawing goes through the draw list rather than microui's command list, because rounded corners,
 * inner highlights, shadows, rings and gradients have no microui command.
 *
 * The layer depends on the renderer and microui only; it never includes a workspace header, so it
 * can ship as a curated capability of its own.
 */
#ifndef RENGINE_UI_H
#define RENGINE_UI_H
#include "draw.h"

enum {                          /* opt flags; microui's MU_OPT_* still apply where it handles the control */
  RE_UI_GHOST = 1 << 0,         /* no fill until hovered: toolbar actions */
  RE_UI_PRIMARY = 1 << 1,       /* accent fill with on-accent text */
  RE_UI_ON = 1 << 2,            /* selected member of a segmented group, or a checked box */
  RE_UI_ICON_ONLY = 1 << 3,     /* centre the icon and ignore the label */
  RE_UI_ALIGN_LEFT = 1 << 4,    /* left-align the label instead of centring it */
  RE_UI_CARET = 1 << 5,         /* trailing caret: selects and dropdown buttons */
  RE_UI_MUTED = 1 << 6,         /* muted label colour */
  RE_UI_SMALL = 1 << 7,         /* 11px label instead of 12px */
  RE_UI_LARGE = 1 << 8,         /* 13px label */
  RE_UI_STRONG = 1 << 9,        /* semibold face */
  RE_UI_DISABLED = 1 << 10,     /* drawn faint and never focusable */
  RE_UI_GROUP_FIRST = 1 << 11,  /* round only the leading corners */
  RE_UI_GROUP_MIDDLE = 1 << 12, /* square both ends */
  RE_UI_GROUP_LAST = 1 << 13,   /* round only the trailing corners */
  RE_UI_TRANSPARENT = 1 << 14,  /* hit area only: the caller drew the face itself */
  RE_UI_FIELD_PAD = 1 << 15,    /* the card's field padding rather than a button's */
};

void re_ui_begin(ReDraw *draw, double seconds);  /* once per frame, before any control */
bool re_ui_animating(void);                      /* a transition is still running: schedule another frame */

/* Controls. `icon` is an RE_ICON_* value or RE_ICON_UNKNOWN for none. */
int re_ui_button_ex(mu_Context *ctx, const char *label, int icon, int opt);
int re_ui_select_ex(mu_Context *ctx, const char *label, int icon, int opt);
int re_ui_textbox_ex(mu_Context *ctx, char *buffer, int size, int icon, const char *placeholder, int opt);
int re_ui_checkbox_ex(mu_Context *ctx, const char *label, int *state, int opt);
int re_ui_slider_ex(mu_Context *ctx, float *value, float low, float high, int opt);
void re_ui_label_ex(mu_Context *ctx, const char *label, int opt);
void re_ui_separator(mu_Context *ctx);           /* vertical rule inside a row */
/* One row of a list or tree: hover highlight, selection fill, an icon, an ellipsised name and a
   faint right-aligned meta column. `depth` indents by the tree indent token. */
int re_ui_row_ex(mu_Context *ctx, const char *name, int icon, const char *meta, int depth, int opt);
/* A state pill: a dot in the semantic hue and the label beside it, on a faint rounded ground. */
enum { RE_UI_PILL_NEUTRAL = 0, RE_UI_PILL_OK, RE_UI_PILL_WARN, RE_UI_PILL_ERR, RE_UI_PILL_INFO };
void re_ui_pill(mu_Context *ctx, const char *label, int kind);

/* Surfaces the workspace draws around its own content. */
void re_ui_panel(ReDraw *draw, mu_Rect rect, mu_Color fill);                      /* flat fill, no radius */
void re_ui_tab(ReDraw *draw, mu_Rect rect, const char *label, int icon, bool active, bool dirty, int reserve); /* reserve: room kept at the right edge, for the close control */
void re_ui_focus_ring(ReDraw *draw, mu_Rect rect, float radius);

#define re_ui_button(ctx, label) re_ui_button_ex(ctx, label, RE_ICON_UNKNOWN, 0)
#define re_ui_select(ctx, label) re_ui_select_ex(ctx, label, RE_ICON_UNKNOWN, RE_UI_CARET | RE_UI_ALIGN_LEFT)
#define re_ui_textbox(ctx, buffer, size) re_ui_textbox_ex(ctx, buffer, size, RE_ICON_UNKNOWN, NULL, 0)
#define re_ui_checkbox(ctx, label, state) re_ui_checkbox_ex(ctx, label, state, 0)
#define re_ui_label(ctx, label) re_ui_label_ex(ctx, label, 0)
#endif
